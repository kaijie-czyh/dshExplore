/**
 * Smoke test for dsh-trajectory.
 *
 * Builds a tiny store from inline events, then asserts the round-trip:
 *   appendMany -> listSessions -> getSession -> replay -> diff.
 *
 * Run with `node --test test/smoke.test.mjs` after `npm run build`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the compiled JS so this file can stay plain JS.
const { TrajectoryStore } = await import("../dist/core/store.js");
const { replay: replayEvents, renderTranscript } = await import("../dist/core/replay.js");
const { diff, renderDiff } = await import("../dist/core/diff.js");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-traj-"));
  const store = new TrajectoryStore({ storePath: join(dir, "traj.db") });
  return { store, dir };
}

test("appends and replays a synthetic session", () => {
  const { store, dir } = makeStore();
  try {
    const sessionId = "sess-smoke";
    const base = 1_700_000_000_000;
    const events = [
      { kind: "turn/start", sessionId, seq: 1, ts: base, source: "core/agent" },
      { kind: "user/message", sessionId, seq: 2, ts: base + 10, text: "hi" },
      { kind: "step/start", sessionId, seq: 3, ts: base + 20, stepIndex: 0 },
      { kind: "assistant/message", sessionId, seq: 4, ts: base + 30, text: "hello" },
      {
        kind: "tool/call",
        sessionId,
        seq: 5,
        ts: base + 40,
        toolName: "shell",
        arguments: { cmd: "echo hi" },
      },
      {
        kind: "tool/result",
        sessionId,
        seq: 6,
        ts: base + 100,
        toolName: "shell",
        ok: true,
        result: "hi",
      },
      { kind: "step/end", sessionId, seq: 7, ts: base + 110, stepIndex: 0 },
      { kind: "turn/end", sessionId, seq: 8, ts: base + 120, steps: 1 },
    ];
    const inserted = store.appendMany(events);
    assert.equal(inserted, events.length);

    const listed = store.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].session_id, sessionId);
    assert.equal(listed[0].steps, 2); // both step/start and step/end count
    assert.equal(listed[0].tool_calls, 1);
    assert.equal(listed[0].user_messages, 1);
    assert.equal(listed[0].assistant_messages, 1);
    assert.equal(listed[0].error_count, 0);

    const got = store.getSession(sessionId);
    assert.equal(got.length, events.length);

    const summary = replayEvents(got);
    assert.equal(summary.steps.length, 1);
    assert.equal(summary.steps[0].toolCalls.length, 1);
    assert.equal(summary.totals.toolCalls, 1);

    // Re-render to ensure no throw
    const txt = renderTranscript(summary);
    assert.match(txt, /session sess-smoke/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff flags divergent steps and final-answer mismatch", () => {
  const { store, dir } = makeStore();
  try {
    const base = 1_700_000_000_000;
    const a = [
      { kind: "turn/start", sessionId: "A", seq: 1, ts: base, source: "core/agent" },
      { kind: "user/message", sessionId: "A", seq: 2, ts: base + 10, text: "go" },
      { kind: "step/start", sessionId: "A", seq: 3, ts: base + 20, stepIndex: 0 },
      { kind: "assistant/message", sessionId: "A", seq: 4, ts: base + 30, text: "first" },
      {
        kind: "tool/call",
        sessionId: "A",
        seq: 5,
        ts: base + 40,
        toolName: "shell",
        arguments: {},
      },
      {
        kind: "tool/result",
        sessionId: "A",
        seq: 6,
        ts: base + 50,
        toolName: "shell",
        ok: true,
        result: "ok",
      },
      { kind: "step/end", sessionId: "A", seq: 7, ts: base + 60, stepIndex: 0 },
      { kind: "turn/end", sessionId: "A", seq: 8, ts: base + 70, steps: 1 },
    ];
    const b = [
      { kind: "turn/start", sessionId: "B", seq: 1, ts: base, source: "core/agent" },
      { kind: "user/message", sessionId: "B", seq: 2, ts: base + 10, text: "go" },
      { kind: "step/start", sessionId: "B", seq: 3, ts: base + 20, stepIndex: 0 },
      { kind: "assistant/message", sessionId: "B", seq: 4, ts: base + 30, text: "second" },
      {
        kind: "tool/call",
        sessionId: "B",
        seq: 5,
        ts: base + 40,
        toolName: "grep",
        arguments: {},
      },
      {
        kind: "tool/result",
        sessionId: "B",
        seq: 6,
        ts: base + 50,
        toolName: "grep",
        ok: false,
        result: null,
        error: "boom",
      },
      { kind: "step/end", sessionId: "B", seq: 7, ts: base + 60, stepIndex: 0 },
      { kind: "turn/end", sessionId: "B", seq: 8, ts: base + 70, steps: 1 },
    ];
    store.appendMany(a);
    store.appendMany(b);
    const ra = replayEvents(store.getSession("A"));
    const rb = replayEvents(store.getSession("B"));
    const d = diff(ra, rb);
    assert.equal(d.finalAnswerEqual, false);
    assert.equal(d.steps[0].divergence, "shared");
    assert.equal(d.steps[0].toolSetEqual, false);
    assert.equal(d.totals.errors, 1);
    const txt = renderDiff(d);
    assert.match(txt, /final answer equal: no/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts image attachments and subagent lifecycle (rc.7 / rc.8)", () => {
  const { store, dir } = makeStore();
  try {
    const base = 1_700_000_000_000;
    const sessionId = "sess-mm";
    const events = [
      { kind: "turn/start", sessionId, seq: 1, ts: base },
      { kind: "user/message", sessionId, seq: 2, ts: base + 5, text: "see @x.png" },
      { kind: "step/start", sessionId, seq: 3, ts: base + 10, stepIndex: 0 },
      {
        kind: "tool/image",
        sessionId,
        seq: 4,
        ts: base + 12,
        toolName: "read_file",
        attachmentId: "att-x",
        mime: "image/png",
        byteLength: 1024,
        label: "x.png",
      },
      {
        kind: "subagent/spawn",
        sessionId,
        seq: 5,
        ts: base + 20,
        handle: "codex-1",
        profile: "codex",
        task: "inspect",
      },
      {
        kind: "subagent/complete",
        sessionId,
        seq: 6,
        ts: base + 30,
        handle: "codex-1",
        ok: false,
        error: "boom",
      },
      { kind: "step/end", sessionId, seq: 7, ts: base + 40, stepIndex: 0 },
      { kind: "turn/end", sessionId, seq: 8, ts: base + 50, steps: 1 },
    ];
    assert.equal(store.appendMany(events), events.length);

    const row = store.getSummary(sessionId);
    assert.equal(row.image_count, 1);
    assert.equal(row.image_bytes, 1024);
    assert.equal(row.subagent_spawns, 1);
    assert.equal(row.subagent_errors, 1);

    const summary = replayEvents(store.getSession(sessionId));
    assert.equal(summary.totals.imageCount, 1);
    assert.equal(summary.totals.imageBytes, 1024);
    assert.equal(summary.totals.subagentSpawns, 1);
    assert.equal(summary.totals.subagentErrors, 1);
    assert.equal(summary.steps[0].images.length, 1);
    assert.equal(summary.steps[0].images[0].attachmentId, "att-x");
    assert.equal(summary.steps[0].subagents.length, 1);
    assert.equal(summary.steps[0].subagents[0].ok, false);

    const txt = renderTranscript(summary);
    assert.match(txt, /images=1\(1\.0KB\)/);
    assert.match(txt, /subagents=1\(err=1\)/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});