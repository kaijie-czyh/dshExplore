#!/usr/bin/env node
/**
 * Verify the Cordis plugin against a real Cordis Context, without depending on
 * the full DeepSeek Harness stack.
 *
 * What this proves:
 *   1. The plugin's `apply()` correctly subscribes to `session/event` on a real
 *      Cordis `Context` (not just a hand-rolled mock).
 *   2. The events we generate match the durable shapes the SQLite store and
 *      the replay / diff code expect.
 *   3. Two "sessions" on the same task land side by side, and our CLI can
 *      replay, diff, and produce a Compare HTML from them.
 *
 * What this does NOT prove (the explicit gap, called out in README §Limitations):
 *   - We do not connect to a live DeepSeek model or the official DSH runtime.
 *   - We synthesize the session/event payloads by hand. They mirror the
 *     contract documented in docs/architecture.md; if DSH renames an event
 *     kind, the plugin's `isDurableEvent` guard will skip it gracefully.
 *
 * Run with: `node scripts/verify-cordis-only.mjs`
 * No network, no global installs, only files inside this repo.
 */

import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Resolve this script's directory and the compiled CLI.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const cliBin = resolve(repoRoot, "dist", "cli", "index.js");

if (!existsSync(cliBin)) {
  console.error(`CLI not built: ${cliBin}\nRun \`npm run build\` first.`);
  process.exit(1);
}

// Create a temp workspace so this script leaves nothing behind on rerun.
const workspace = mkdtempSync(join(tmpdir(), "dsh-traj-verify-"));
const storePath = join(workspace, "traj.db");
const htmlPath = join(workspace, "compare.html");

function now() { return Date.now(); }

function makeSession(sessionId, behaviour) {
  const t0 = now();
  const seq = (n) => ({ kind: null, sessionId, seq: n, ts: t0 + n * 10 });

  const events = [];
  let n = 1;
  events.push({ kind: "turn/start", sessionId, seq: n++, ts: t0 });
  events.push({
    kind: "user/message",
    sessionId,
    seq: n++,
    ts: t0 + 10,
    text: behaviour.prompt,
  });
  events.push({ kind: "step/start", sessionId, seq: n++, ts: t0 + 20, stepIndex: 0 });
  events.push({
    kind: "assistant/message",
    sessionId,
    seq: n++,
    ts: t0 + 30,
    text: behaviour.firstReply,
  });
  for (const tool of behaviour.tools) {
    events.push({
      kind: "tool/call",
      sessionId,
      seq: n++,
      ts: t0 + 40,
      toolName: tool.name,
      arguments: tool.arguments ?? {},
    });
    events.push({
      kind: "tool/result",
      sessionId,
      seq: n++,
      ts: t0 + 50,
      toolName: tool.name,
      ok: tool.ok !== false,
      result: tool.result ?? "ok",
      error: tool.error,
    });
  }
  events.push({ kind: "step/end", sessionId, seq: n++, ts: t0 + 60, stepIndex: 0 });
  events.push({
    kind: "assistant/message",
    sessionId,
    seq: n++,
    ts: t0 + 70,
    text: behaviour.finalAnswer,
  });
  events.push({ kind: "turn/end", sessionId, seq: n++, ts: t0 + 80, steps: 1 });
  return events;
}

// Two sessions that diverge in tool selection and final answer.
const sessionA = {
  sessionId: "real-A",
  prompt: "List files that look stale.",
  firstReply: "I'll scan the repo for stale files.",
  tools: [{ name: "shell", arguments: { cmd: "ls -la" }, result: "..." }],
  finalAnswer: "Three files look stale.",
};
const sessionB = {
  sessionId: "real-B",
  prompt: "List files that look stale.",
  firstReply: "I'll scan the repo for stale files.",
  tools: [{ name: "grep.search", arguments: { pattern: "TODO" }, ok: false, error: "timeout", result: null }],
  finalAnswer: "Five files look stale.",
};

// Third session: multimodal + subagent path (rc.7+ / rc.8+).
function makeMultimodalEvents(sessionId, t0) {
  const events = [];
  let n = 1;
  const ts = (offset) => t0 + offset;
  events.push({ kind: "turn/start", sessionId, seq: n++, ts: ts(0) });
  events.push({
    kind: "user/message",
    sessionId,
    seq: n++,
    ts: ts(10),
    text: "What's in this screenshot? @latest.png",
  });
  events.push({ kind: "step/start", sessionId, seq: n++, ts: ts(20), stepIndex: 0 });
  // image attachment metadata (rc.7+); the harness keeps the bytes, we record the metadata.
  events.push({
    kind: "tool/image",
    sessionId,
    seq: n++,
    ts: ts(22),
    toolName: "read_file",
    attachmentId: "att-001",
    mime: "image/png",
    byteLength: 184_320,
    label: "latest.png",
  });
  events.push({
    kind: "assistant/message",
    sessionId,
    seq: n++,
    ts: ts(30),
    text: "I see a build error panel. Delegating to a Codex agent for a closer look.",
  });
  events.push({
    kind: "subagent/spawn",
    sessionId,
    seq: n++,
    ts: ts(31),
    handle: "codex-1",
    profile: "codex",
    task: "Inspect build error panel and propose fix.",
  });
  events.push({
    kind: "tool/call",
    sessionId,
    seq: n++,
    ts: ts(40),
    toolName: "shell",
    arguments: { cmd: "grep -R build . --include=*.log | head" },
  });
  events.push({
    kind: "tool/result",
    sessionId,
    seq: n++,
    ts: ts(50),
    toolName: "shell",
    ok: true,
    result: "build.log: error TS2304 ...",
  });
  events.push({
    kind: "subagent/complete",
    sessionId,
    seq: n++,
    ts: ts(70),
    handle: "codex-1",
    ok: true,
  });
  events.push({ kind: "step/end", sessionId, seq: n++, ts: ts(80), stepIndex: 0 });
  events.push({
    kind: "assistant/message",
    sessionId,
    seq: n++,
    ts: ts(90),
    text: "Codex fix: rename `buildArtifacts` to `build_artifacts`.",
  });
  events.push({ kind: "turn/end", sessionId, seq: n++, ts: ts(100), steps: 1 });
  return events;
}

const eventsA = makeSession(sessionA.sessionId, sessionA);
const eventsB = makeSession(sessionB.sessionId, sessionB);
const eventsMM = makeMultimodalEvents("real-MM", Date.now() + 5000); // offset to disambiguate ts

// Boot a real Cordis context. Mount our plugin (compiled JS) on it.
const ctx = new Context();
const trajectoryPlugin = (await import(`file://${resolve(repoRoot, "dist", "plugin", "trajectory-plugin.js").replace(/\\/g, "/")}`)).default;
const handle = trajectoryPlugin(ctx, { storePath, autoDispose: false });

console.log(`workspace: ${workspace}`);
console.log(`store:     ${storePath}`);
console.log(`context:   ${ctx.constructor.name}`);

// Emit three sessions: two text-only, one multimodal-with-subagent.
for (const e of eventsA) ctx.emit("session/event", e);
for (const e of eventsB) ctx.emit("session/event", e);
for (const e of eventsMM) ctx.emit("session/event", e);

// Detach manually (no plugin lifecycle here in the bare-cordis case).
handle.detach?.();

// Tear down the plugin's store explicitly.
handle.store.close();

console.log("\n--- ingest via real Cordis Context done ---\n");

function run(args) {
  return execFileSync(process.execPath, [cliBin, "--store", storePath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const lsOut = run(["ls"]);
console.log("## `dsh-trajectory ls`\n");
console.log(lsOut.trimEnd());

const replayA = run(["replay", "real-A"]);
console.log("\n## `dsh-trajectory replay real-A`\n");
console.log(replayA.trimEnd());

const diffAB = run(["diff", "real-A", "real-B"]);
console.log("\n## `dsh-trajectory diff real-A real-B`\n");
console.log(diffAB.trimEnd());

const compareAB = run(["compare", "real-A", "real-B", "-o", htmlPath]);
console.log("\n## `dsh-trajectory compare real-A real-B -o compare.html`\n");
console.log(compareAB.trimEnd());

// Show that multimodal + subagent events land in the store and that diff/replay see them.
const replayMM = run(["replay", "real-MM"]);
console.log("\n## `dsh-trajectory replay real-MM` (multimodal + subagent)\n");
console.log(replayMM.trimEnd());

const diffAMM = run(["diff", "real-A", "real-MM"]);
console.log("\n## `dsh-trajectory diff real-A real-MM`\n");
console.log(diffAMM.trimEnd());

const { statSync } = await import("node:fs");
const htmlStat = statSync(htmlPath);
console.log(`\ncompare.html: ${htmlStat.size} bytes (single-file, zero-runtime)`);

// Best-effort cleanup; on failure just print the path so the user knows where it is.
try {
  rmSync(workspace, { recursive: true, force: true });
  console.log(`cleaned workspace: ${workspace}`);
} catch (err) {
  console.error(`could not remove ${workspace}: ${err.message}`);
}