#!/usr/bin/env node
/**
 * Verify the plugin against the official @deepseek-ai/dsh-llm-mock-server.
 *
 * This script does NOT depend on the full DeepSeek Harness runtime. It boots
 * the mock server (an OpenAI-compatible HTTP/SSE server shipped by DeepSeek for
 * recovery tests), fires real HTTP requests through node:fetch, and feeds the
 * stream chunks back through a real Cordis Context with our plugin mounted.
 *
 * What this proves:
 *   - The OpenAI-compatible wire format the plugin ultimately relies on (via
 *     DSH's DeepSeek adapter) is reachable end-to-end through a scriptable
 *     mock, with real SSE bytes flowing on a real local port.
 *   - The plugin persists everything that comes out of the wire.
 *
 * What this does NOT prove:
 *   - That DSH's own DeepSeek adapter talks to this server in production
 *     (that requires the full DSH runtime and is captured in §9 as future
 *     work).
 *
 * Run with: `node scripts/verify-with-mock-llm.mjs`
 * Network: localhost only. No external calls.
 */

import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cliBin = resolve(repoRoot, "dist", "cli", "index.js");

if (!existsSync(cliBin)) {
  console.error(`CLI not built: ${cliBin}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "dsh-traj-mock-"));
const storePath = join(workspace, "traj.db");

// Boot the mock server on an ephemeral port. `success` streams a valid chat
// completion, so we expect real SSE bytes back.
const handle = await startMockLlmServer({
  host: "127.0.0.1",
  port: 0,
  apiKey: "mock-key",
  sequence: ["success", "success"],
  successText: "I'll scan the repo for stale files.",
});

const port = handle.port;
const baseURL = `http://127.0.0.1:${port}/v1`;
console.log(`mock-server: ${baseURL}`);
console.log(`store:       ${storePath}`);

const ctx = new Context();
const trajectoryPlugin = (await import(`file://${resolve(repoRoot, "dist", "plugin", "trajectory-plugin.js").replace(/\\/g, "/")}`)).default;
const plugin = trajectoryPlugin(ctx, { storePath, autoDispose: false });

let chunkCount = 0;
async function fire(label, sessionId) {
  const t0 = Date.now();
  ctx.emit("session/event", {
    kind: "turn/start", sessionId, seq: 1, ts: t0, source: "core/agent",
  });
  ctx.emit("session/event", {
    kind: "user/message", sessionId, seq: 2, ts: t0 + 1,
    text: "List files that look stale.",
  });
  ctx.emit("session/event", {
    kind: "step/start", sessionId, seq: 3, ts: t0 + 2, stepIndex: 0,
  });

  // Real HTTP call to the mock server. Real SSE bytes on a real socket.
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer mock-key`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "mock-deepseek",
      messages: [{ role: "user", content: "List files that look stale." }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`mock returned ${res.status}`);
  let assembled = "";
  let seq = 4;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line || line === "data: [DONE]") continue;
      try {
        const payload = JSON.parse(line.slice("data: ".length));
        const delta = payload?.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          assembled += delta;
          ctx.emit("session/event", {
            kind: "assistant/chunk", sessionId, seq: seq++, ts: Date.now(),
            source: "llm-deepseek", delta: payload,
          });
          chunkCount += 1;
        }
      } catch { /* malformed; ignored per mock-server contract */ }
    }
  }
  ctx.emit("session/event", {
    kind: "assistant/message", sessionId, seq: seq++, ts: Date.now(),
    text: assembled, source: "llm-deepseek",
  });
  ctx.emit("session/event", {
    kind: "step/end", sessionId, seq: seq++, ts: Date.now(), stepIndex: 0,
  });
  ctx.emit("session/event", {
    kind: "turn/end", sessionId, seq: seq++, ts: Date.now(), steps: 1,
  });
  console.log(`${label}: ${chunkCount} SSE chunks streamed, assembled=${JSON.stringify(assembled)}`);
  chunkCount = 0;
  return assembled;
}

await fire("session mock-A", "mock-A");
await fire("session mock-B", "mock-B");

await handle.close();
plugin.detach?.();
plugin.store.close();

console.log("\n## dsh-trajectory ls\n");
console.log(execFileSync(process.execPath, [cliBin, "--store", storePath, "ls"], { encoding: "utf8" }).trimEnd());

console.log("\n## dsh-trajectory diff mock-A mock-B\n");
console.log(execFileSync(process.execPath, [cliBin, "--store", storePath, "diff", "mock-A", "mock-B"], { encoding: "utf8" }).trimEnd());

console.log("\n## dsh-trajectory compare mock-A mock-B -o compare.html\n");
const htmlPath = join(workspace, "compare.html");
execFileSync(process.execPath, [cliBin, "--store", storePath, "compare", "mock-A", "mock-B", "-o", htmlPath], { encoding: "utf8" });
const { statSync } = await import("node:fs");
console.log(`compare.html: ${statSync(htmlPath).size} bytes`);

try {
  rmSync(workspace, { recursive: true, force: true });
  console.log(`cleaned workspace: ${workspace}`);
} catch (err) {
  console.error(`could not remove ${workspace}: ${err.message}`);
}