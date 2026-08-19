#!/usr/bin/env node
/**
 * dsh-trajectory CLI
 *
 * Subcommands:
 *   replay <sessionId>        Render a transcript of a stored session.
 *   diff <sessionA> <sessionB> Compare two sessions and print a structured diff.
 *   ls                        List all stored sessions.
 *   ingest <file.jsonl>       Bulk-import events from a JSONL file (for testing
 *                             and offline migration; one event per line).
 *
 * The CLI does not require DSH to be running. It only reads the local store.
 * Inside a live DSH process, the plugin (src/plugin/trajectory-plugin.ts) feeds
 * the same store from session/event.
 */

import { Command } from "commander";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { TrajectoryStore, defaultStorePath } from "../core/store.js";
import { replay, renderTranscript } from "../core/replay.js";
import { diff, renderDiff } from "../core/diff.js";
import { renderCompareHtml } from "../web/compare-template.js";
import type { SessionEvent } from "../core/events.js";

const program = new Command();
program
  .name("dsh-trajectory")
  .description("Append-only trajectory toolkit for DeepSeek Harness (DSH).")
  .version("0.2.0")
  .option("--store <path>", "Path to the trajectory db", defaultStorePath())
  .addHelpText("after", `
Examples:
  $ dsh-trajectory ls
  $ dsh-trajectory replay sess-A
  $ dsh-trajectory diff sess-A sess-B
  $ dsh-trajectory compare sess-A sess-B -o report.html

示例：
  $ dsh-trajectory ls
  $ dsh-trajectory replay sess-A
  $ dsh-trajectory diff sess-A sess-B
  $ dsh-trajectory compare sess-A sess-B -o report.html
`);

program
  .command("ls")
  .description("List stored sessions / 列出已存储的会话")
  .addHelpText("after", "Prints one line per session with step / tool / error counts.\n每个会话一行，展示步骤、工具、错误计数。")
  .action((_opts, cmd) => {
    const store = new TrajectoryStore({ storePath: cmd.optsWithGlobals().store });
    try {
      const rows = store.listSessions();
      if (rows.length === 0) {
        console.log("(no sessions)");
        return;
      }
      console.log(`${rows.length} session(s):`);
      for (const r of rows) {
        const dur = ((r.last_ts - r.first_ts) / 1000).toFixed(2);
        const images = r.image_count ? ` imgs=${r.image_count}(${formatBytes(r.image_bytes)})` : "";
        const subs = r.subagent_spawns ? ` subs=${r.subagent_spawns}/${r.subagent_errors}err` : "";
        console.log(
          `  ${r.session_id}  steps=${r.steps}  tools=${r.tool_calls}  errs=${r.error_count}  dur=${dur}s${images}${subs}`,
        );
      }
    } finally {
      store.close();
    }
  });

program
  .command("replay <sessionId>")
  .description("Render a transcript for a stored session / 渲染某个会话的转录")
  .option("--json", "Print the replay summary as JSON / 以 JSON 形式输出")
  .addHelpText("after", "Reads events for <sessionId> from the store and prints a transcript.\n从存储中读出 <sessionId> 的事件并打印转录。")
  .action((sessionId: string, opts, cmd) => {
    const store = new TrajectoryStore({ storePath: cmd.optsWithGlobals().store });
    try {
      const events = store.getSession(sessionId);
      if (events.length === 0) {
        console.error(`session not found: ${sessionId}`);
        process.exit(1);
      }
      const summary = replay(events);
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(renderTranscript(summary));
      }
    } finally {
      store.close();
    }
  });

program
  .command("diff <sessionA> <sessionB>")
  .description("Compare two sessions / 比较两个会话")
  .option("--json", "Print the diff as JSON / 以 JSON 形式输出")
  .addHelpText("after", "Aligns steps by index and surfaces tool, duration, and answer divergence.\n按 step 索引对齐，展示工具、时延、最终答案的差异。")
  .action((a: string, b: string, opts, cmd) => {
    const store = new TrajectoryStore({ storePath: cmd.optsWithGlobals().store });
    try {
      const ea = store.getSession(a);
      const eb = store.getSession(b);
      if (ea.length === 0 || eb.length === 0) {
        console.error(`one of the sessions is unknown: ${a} / ${b}`);
        process.exit(1);
      }
      const d = diff(replay(ea), replay(eb));
      if (opts.json) console.log(JSON.stringify(d, null, 2));
      else console.log(renderDiff(d));
    } finally {
      store.close();
    }
  });

program
  .command("compare <sessionA> <sessionB>")
  .description("Render an HTML Compare view for two sessions / 输出两个会话的 HTML 对比页")
  .option("-o, --out <file>", "Write HTML to this path; omit to print to stdout / 写入路径；省略则打印到 stdout")
  .addHelpText("after", "Generates a single self-contained HTML file with two columns side by side.\n生成单文件 HTML，左右两栏对比。")
  .action(async (a: string, b: string, opts, cmd) => {
    const store = new TrajectoryStore({ storePath: cmd.optsWithGlobals().store });
    try {
      const ea = store.getSession(a);
      const eb = store.getSession(b);
      if (ea.length === 0 || eb.length === 0) {
        console.error(`one of the sessions is unknown: ${a} / ${b}`);
        process.exit(1);
      }
      const html = renderCompareHtml(replay(ea), replay(eb));
      if (opts.out) {
        await writeFile(resolve(opts.out), html, "utf8");
        console.error(`wrote ${opts.out}`);
      } else {
        process.stdout.write(html);
      }
    } finally {
      store.close();
    }
  });

program
  .command("ingest <file>")
  .description("Ingest a JSONL file of session events into the store / 从 JSONL 文件导入事件到存储")
  .addHelpText("after", "One JSON event per line. Malformed lines are skipped silently.\n每行一个 JSON 事件；解析失败会被静默跳过。")
  .action(async (file: string, _opts, cmd) => {
    const path = resolve(file);
    if (!existsSync(path)) {
      console.error(`file not found: ${path}`);
      process.exit(1);
    }
    const store = new TrajectoryStore({ storePath: cmd.optsWithGlobals().store });
    const batch: unknown[] = [];
    let total = 0;
    const flush = () => {
      if (batch.length === 0) return 0;
      const inserted = store.appendMany(batch);
      total += batch.length;
      batch.length = 0;
      return inserted;
    };
    try {
      const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          batch.push(JSON.parse(trimmed));
        } catch {
          // skip malformed lines
        }
        if (batch.length >= 500) flush();
      }
      flush();
      console.error(`ingested ${total} line(s) into ${cmd.optsWithGlobals().store}`);
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}