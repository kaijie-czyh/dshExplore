/**
 * Append-only trajectory store backed by SQLite (better-sqlite3, sync API).
 *
 * Design constraints:
 *  - We never mutate or delete an existing row. UPDATEs are limited to the
 *    `sessions` summary row for derived counters (steps, tool_calls, etc.).
 *  - Event rows are keyed by (session_id, seq); uniqueness is enforced.
 *  - Writes are wrapped in a transaction for batched throughput; the Cordis
 *    listener typically fires once per event, but bulk replay uses appendMany.
 *
 * The store lives at `<dsh-home>/dsh-trajectory.db` by default; override via
 * the `storePath` option. Schema migrations are versioned via PRAGMA user_version.
 */

import DatabaseT from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DURABLE_KINDS, isDurableEvent, type SessionEvent } from "./events.js";

export interface StoreOptions {
  /** Absolute path to the sqlite file. */
  storePath: string;
}

interface EventRow {
  session_id: string;
  seq: number;
  kind: string;
  ts: number;
  source: string | null;
  payload: string;
}

interface SessionRow {
  session_id: string;
  first_ts: number;
  last_ts: number;
  steps: number;
  tool_calls: number;
  user_messages: number;
  assistant_messages: number;
  error_count: number;
  /** rc.7+: total bytes of durable image attachments cited in this session. */
  image_bytes: number;
  /** rc.7+: count of durable image attachments cited in this session. */
  image_count: number;
  /** rc.8+: number of subagents spawned (Claude Code / Codex). */
  subagent_spawns: number;
  /** rc.8+: number of subagent completions that reported ok=false. */
  subagent_errors: number;
  /** Internal accumulator columns projected to match the upsert's named params. */
  steps_total?: number;
  tools_total?: number;
  users_total?: number;
  assistants_total?: number;
  errors_total?: number;
  image_bytes_total?: number;
  image_count_total?: number;
  subagent_spawns_total?: number;
  subagent_errors_total?: number;
}

export class TrajectoryStore {
  private db: DatabaseT.Database;
  private insertEventStmt!: DatabaseT.Statement;
  private upsertSessionStmt!: DatabaseT.Statement;

  constructor(opts: StoreOptions) {
    mkdirSync(dirname(opts.storePath), { recursive: true });
    this.db = new DatabaseT(opts.storePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init() {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          session_id TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          kind       TEXT NOT NULL,
          ts         INTEGER NOT NULL,
          source     TEXT,
          payload    TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);

        CREATE TABLE IF NOT EXISTS sessions (
          session_id        TEXT PRIMARY KEY,
          first_ts          INTEGER NOT NULL,
          last_ts           INTEGER NOT NULL,
          steps             INTEGER NOT NULL DEFAULT 0,
          tool_calls        INTEGER NOT NULL DEFAULT 0,
          user_messages     INTEGER NOT NULL DEFAULT 0,
          assistant_messages INTEGER NOT NULL DEFAULT 0,
          error_count       INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.db.pragma("user_version = 1");
    }
    // v2: rc.7/rc.8 session counters. Additive; existing rows backfill to 0.
    if (version < 2) {
      const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      const add = (name: string, type: string) => {
        if (!have.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type} NOT NULL DEFAULT 0`);
      };
      add("image_bytes", "INTEGER");
      add("image_count", "INTEGER");
      add("subagent_spawns", "INTEGER");
      add("subagent_errors", "INTEGER");
      this.db.pragma("user_version = 2");
    }
    this.insertEventStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (session_id, seq, kind, ts, source, payload)
      VALUES (@session_id, @seq, @kind, @ts, @source, @payload)
    `);
    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, first_ts, last_ts,
        steps, tool_calls, user_messages, assistant_messages, error_count,
        image_bytes, image_count, subagent_spawns, subagent_errors
      ) VALUES (
        @session_id, @first_ts, @last_ts,
        @steps_total, @tools_total, @users_total, @assistants_total, @errors_total,
        @image_bytes_total, @image_count_total, @subagent_spawns_total, @subagent_errors_total
      )
      ON CONFLICT(session_id) DO UPDATE SET
        last_ts = MAX(last_ts, excluded.last_ts),
        steps   = steps   + excluded.steps,
        tool_calls = tool_calls + excluded.tool_calls,
        user_messages = user_messages + excluded.user_messages,
        assistant_messages = assistant_messages + excluded.assistant_messages,
        error_count = error_count + excluded.error_count,
        image_bytes = image_bytes + excluded.image_bytes,
        image_count = image_count + excluded.image_count,
        subagent_spawns = subagent_spawns + excluded.subagent_spawns,
        subagent_errors = subagent_errors + excluded.subagent_errors
    `);
  }

  /**
   * Append a single event. Returns true if a new row was inserted, false if it
   * was a duplicate (already present). Unknown shapes are ignored silently.
   */
  append(event: unknown): boolean {
    if (!isDurableEvent(event)) return false;
    if (!DURABLE_KINDS.has(event.kind)) return false;
    return this.appendMany([event]) === 1;
  }

  /**
   * Append a batch. Returns the count of newly inserted rows.
   * Wrapped in a single transaction for throughput.
   */
  appendMany(events: ReadonlyArray<unknown>): number {
    const tx = this.db.transaction((rows: EventRow[], sessionRows: SessionRow[]) => {
      let inserted = 0;
      for (const row of rows) {
        const info = this.insertEventStmt.run(row);
        if (info.changes > 0) inserted += 1;
      }
      for (const s of sessionRows) {
        this.upsertSessionStmt.run(s);
      }
      return inserted;
    });
    const eventRows: EventRow[] = [];
    const sessionAcc = new Map<string, SessionRow>();
    for (const e of events) {
      if (!isDurableEvent(e) || !DURABLE_KINDS.has(e.kind)) continue;
      eventRows.push({
        session_id: e.sessionId,
        seq: e.seq,
        kind: e.kind,
        ts: e.ts,
        source: e.source ?? null,
        payload: JSON.stringify(e),
      });
      const s = sessionAcc.get(e.sessionId) ?? {
        session_id: e.sessionId,
        first_ts: e.ts,
        last_ts: e.ts,
        steps: 0,
        tool_calls: 0,
        user_messages: 0,
        assistant_messages: 0,
        error_count: 0,
        image_bytes: 0,
        image_count: 0,
        subagent_spawns: 0,
        subagent_errors: 0,
        // SQLite upsert parameter names; populated from the cumulative totals.
        steps_total: 0,
        tools_total: 0,
        users_total: 0,
        assistants_total: 0,
        errors_total: 0,
        image_bytes_total: 0,
        image_count_total: 0,
        subagent_spawns_total: 0,
        subagent_errors_total: 0,
      };
      s.first_ts = Math.min(s.first_ts, e.ts);
      s.last_ts = Math.max(s.last_ts, e.ts);
      switch (e.kind) {
        case "step/start":
        case "step/end":
          s.steps += 1;
          break;
        case "tool/call":
          s.tool_calls += 1;
          break;
        case "tool/result":
          s.error_count += e.ok ? 0 : 1;
          break;
        case "user/message":
          s.user_messages += 1;
          break;
        case "assistant/message":
          s.assistant_messages += 1;
          break;
        case "tool/image":
          s.image_count += 1;
          s.image_bytes += e.byteLength;
          break;
        case "subagent/spawn":
          s.subagent_spawns += 1;
          break;
        case "subagent/complete":
          s.subagent_errors += e.ok ? 0 : 1;
          break;
      }
      sessionAcc.set(e.sessionId, s);
    }
    // Project cumulative totals into the named params the prepared statement expects.
    const sessionRows: Array<SessionRow> = [...sessionAcc.values()].map((s) => ({
      ...s,
      steps_total: s.steps,
      tools_total: s.tool_calls,
      users_total: s.user_messages,
      assistants_total: s.assistant_messages,
      errors_total: s.error_count,
      image_bytes_total: s.image_bytes,
      image_count_total: s.image_count,
      subagent_spawns_total: s.subagent_spawns,
      subagent_errors_total: s.subagent_errors,
    }));
    return tx(eventRows, sessionRows);
  }

  /** List all known sessions, most recent first. */
  listSessions(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_ts DESC`)
      .all() as SessionRow[];
  }

  /** Return all events for a session in append order. */
  getSession(sessionId: string): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as Array<{ payload: string }>;
    const out: SessionEvent[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.payload) as SessionEvent);
      } catch {
        // skip malformed rows; the source-of-truth is still DSH's log
      }
    }
    return out;
  }

  /** Compact summary for a single session, or null if unknown. */
  getSummary(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  close() {
    this.db.close();
  }
}

/** Default location: <harness-home>/dsh-trajectory.db. */
export function defaultStorePath(harnessHome?: string): string {
  const home = harnessHome ?? process.env.DSH_HOME ?? resolve(process.cwd(), ".dsh-trajectory");
  return resolve(home, "dsh-trajectory.db");
}