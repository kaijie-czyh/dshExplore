/**
 * Replay a stored session as a structured narrative.
 *
 * The DSH runtime can already resume / fork / replay sessions natively; this
 * module is for offline replay against our own SQLite store, independent of
 * a running DSH process. Useful for diffing, regression tests, and audits.
 */

import type { SessionEvent } from "./events.js";

export interface ReplayStep {
  index: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  user?: string;
  assistant?: string;
  toolCalls: Array<{ name: string; arguments: unknown; ok?: boolean; error?: string }>;
  /** Image attachments cited inside this step (rc.7+). */
  images: Array<{ attachmentId: string; mime: string; byteLength: number; label?: string }>;
  /** Subagents spawned inside this step (rc.8+). */
  subagents: Array<{ handle: string; profile: string; task: string; ok?: boolean; error?: string }>;
  errorCount: number;
}

export interface ReplaySummary {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  totalDurationMs: number;
  steps: ReplayStep[];
  totals: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    errors: number;
    imageBytes: number;
    imageCount: number;
    subagentSpawns: number;
    subagentErrors: number;
  };
}

export function replay(events: ReadonlyArray<SessionEvent>): ReplaySummary {
  if (events.length === 0) {
    throw new Error("replay: empty event list");
  }
  const sessionId = events[0].sessionId;
  const steps: ReplayStep[] = [];
  const totals = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    errors: 0,
    imageBytes: 0,
    imageCount: 0,
    subagentSpawns: 0,
    subagentErrors: 0,
  };
  const state: { current: ReplayStep | null } = { current: null };
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = 0;

  function beginStep(ts: number, index: number): void {
    if (state.current) steps.push(state.current);
    state.current = {
      index,
      startTs: ts,
      endTs: ts,
      durationMs: 0,
      toolCalls: [],
      images: [],
      subagents: [],
      errorCount: 0,
    };
  }

  for (const e of events) {
    if (e.ts < startedAt) startedAt = e.ts;
    if (e.ts > endedAt) endedAt = e.ts;
    const cur = state.current;
    switch (e.kind) {
      case "step/start":
        beginStep(e.ts, e.stepIndex);
        break;
      case "step/end":
        if (!state.current || state.current.index !== e.stepIndex) {
          beginStep(e.ts, e.stepIndex);
        }
        if (state.current) {
          state.current.endTs = e.ts;
          state.current.durationMs = e.ts - state.current.startTs;
        }
        break;
      case "user/message":
        totals.userMessages += 1;
        if (cur) {
          cur.user = (cur.user ? cur.user + "\n" : "") + e.text;
        }
        break;
      case "assistant/message":
        totals.assistantMessages += 1;
        if (cur) {
          cur.assistant = (cur.assistant ? cur.assistant + "\n" : "") + e.text;
        }
        break;
      case "tool/call":
        totals.toolCalls += 1;
        if (cur) {
          cur.toolCalls.push({ name: e.toolName, arguments: e.arguments });
        }
        break;
      case "tool/result": {
        const ok = e.ok;
        if (cur && cur.toolCalls.length > 0) {
          const last = cur.toolCalls[cur.toolCalls.length - 1];
          last.ok = ok;
          if (!ok) {
            last.error = e.error;
            cur.errorCount += 1;
            totals.errors += 1;
          }
        } else if (!ok) {
          totals.errors += 1;
          if (cur) cur.errorCount += 1;
        }
        break;
      }
      case "tool/image":
        totals.imageCount += 1;
        totals.imageBytes += e.byteLength;
        if (cur) {
          cur.images.push({
            attachmentId: e.attachmentId,
            mime: e.mime,
            byteLength: e.byteLength,
            label: e.label,
          });
        }
        break;
      case "subagent/spawn":
        totals.subagentSpawns += 1;
        if (cur) {
          cur.subagents.push({ handle: e.handle, profile: e.profile, task: e.task });
        }
        break;
      case "subagent/complete": {
        // Find the open spawn with this handle in any step (defaults to current).
        const target = cur?.subagents.find((s) => s.handle === e.handle) ??
          steps.reverse().flatMap((s) => s.subagents).find((s) => s.handle === e.handle);
        if (target) {
          target.ok = e.ok;
          if (!e.ok) target.error = e.error;
        }
        if (!e.ok) {
          totals.subagentErrors += 1;
          if (cur) cur.errorCount += 1;
        }
        break;
      }
      default:
        break;
    }
  }
  if (state.current) steps.push(state.current);
  return {
    sessionId,
    startedAt,
    endedAt,
    totalDurationMs: Math.max(0, endedAt - startedAt),
    steps,
    totals,
  };
}

/** Render the summary as a human-readable transcript. */
export function renderTranscript(summary: ReplaySummary): string {
  const lines: string[] = [];
  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  lines.push(`session ${summary.sessionId}`);
  lines.push(`  started: ${new Date(summary.startedAt).toISOString()}`);
  lines.push(`  ended:   ${new Date(summary.endedAt).toISOString()}`);
  lines.push(`  total:   ${fmt(summary.totalDurationMs)}`);
  lines.push(
    `  totals:  user=${summary.totals.userMessages} assistant=${summary.totals.assistantMessages} tool=${summary.totals.toolCalls} errors=${summary.totals.errors} images=${summary.totals.imageCount}(${formatBytes(summary.totals.imageBytes)}) subagents=${summary.totals.subagentSpawns}(err=${summary.totals.subagentErrors})`,
  );
  lines.push(`  steps:`);
  for (const s of summary.steps) {
    lines.push(`    [${s.index}] ${fmt(s.durationMs)} errs=${s.errorCount} imgs=${s.images.length} subs=${s.subagents.length}`);
    if (s.user) lines.push(`      user: ${truncate(s.user, 200)}`);
    if (s.assistant) lines.push(`      asst: ${truncate(s.assistant, 200)}`);
    for (const tc of s.toolCalls) {
      const status = tc.ok === undefined ? "?" : tc.ok ? "ok" : "err";
      lines.push(`      tool: ${tc.name} (${status})`);
    }
    for (const im of s.images) {
      const tag = im.label ? ` ${truncate(im.label, 60)}` : "";
      lines.push(`      img:  ${im.mime} ${formatBytes(im.byteLength)}#${im.attachmentId}${tag}`);
    }
    for (const sa of s.subagents) {
      const status = sa.ok === undefined ? "?" : sa.ok ? "ok" : "err";
      lines.push(`      sub:  ${sa.profile} ${sa.handle} (${status}) ${truncate(sa.task, 80)}`);
    }
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}