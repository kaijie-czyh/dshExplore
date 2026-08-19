# dsh-trajectory

> An independent trajectory toolkit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Append-only indexer, offline replay CLI, A/B diff CLI, and a minimal Compare web view.
> Built entirely on DSH's public `session/event` stream — no core patches.

DSH records every model-visible fact in an append-only session log and replays it
through the official Trajectory view. This package adds three things that the
core does not ship out of the box:

1. **Offline replay.** Re-render any stored session as a structured transcript
   without a running DSH process.
2. **A/B diff.** Compare two sessions on the same task and see step-level
   divergences in tool choice, duration, errors, and final answer.
3. **Self-contained Compare HTML.** A single-file view that pins two replays
   side by side for code review or regression reports.

It works because of one architectural decision in DSH: *"Model-visible means
logged."* Anything the model saw can be reconstructed from the session log, so
we can run replay, diff, and visualization without touching the loop itself.

## Status

`dsh-trajectory` 0.2.0. Tracks DeepSeek Harness developer preview (tested
against [rc.7](https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.0-rc.7)
and [rc.8](https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.0-rc.8)
public event surfaces). The plugin is event-source-incremental: new rc.x
event kinds are added to `DURABLE_KINDS` without breaking older stores, and
the SQLite schema carries an additive migration.

## Install

DSH itself must be installed first (`npx @deepseek-ai/dsh web`). This package
is a plugin and a CLI:

```bash
git clone https://github.com/kaijie-czyh/dshExplore
cd dsh-trajectory
npm install
npm run build
```

Then, in a running DSH process, mount the plugin from your `cordis.patch.yml`:

```yaml
plugins:
  - name: dsh-trajectory
    path: ./dist/plugin/trajectory-plugin.js
```

The plugin subscribes to `session/event`, persists every durable event into a
local SQLite file (default `<DSH_HOME>/dsh-trajectory.db`), and tears down its
effect cleanly when the DSH process unloads.

## CLI

The same code ships a CLI for offline analysis against the same store:

```bash
# List stored sessions
node dist/cli/index.js ls

# Replay one session as a transcript
node dist/cli/index.js replay <sessionId>

# Compare two sessions
node dist/cli/index.js diff <sessionA> <sessionB>

# Render an HTML Compare view
node dist/cli/index.js compare <sessionA> <sessionB> -o ./compare.html

# Ingest a JSONL export (one event per line) — useful for offline migration
node dist/cli/index.js ingest ./examples/session-a.jsonl
```

Add `--store <path>` to point at any sqlite; defaults to
`<DSH_HOME>/dsh-trajectory.db`.

## Why this exists

The official Trajectory view inside the DSH Web UI is excellent for inspecting
a single run. It is not designed for:

- regression tests across runs,
- comparing two models / two prompts on the same task,
- long-running audits and shared reports.

This toolkit fills that gap by treating the append-only log as a first-class
artifact you can version, diff, and render without re-executing anything.

## Security / Permissions

`dsh-trajectory` is a **read-only observer** of DSH sessions. To make the
boundary explicit up front:

- **No model-visible injection.** The plugin never writes to the model's
  prompt, tool list, or context. It only subscribes to `session/event`.
- **No loop patching.** No hooks, monkey-patches, or wrappers are installed
  in DSH's agent loop. The core binary behaves identically with or without
  this plugin loaded.
- **No `SessionEventMap` extension.** Event types are consumed as-is from the
  public surface; nothing new is registered into the harness.
- **Local-only storage by default.** Events are written to a SQLite file under
  `<DSH_HOME>/` (`<DSH_HOME>/dsh-trajectory.db`). No data is sent off-host
  unless you explicitly point `--store` at a remote path or ship the file
  yourself.
- **File-system scope.** The plugin needs read/write access to its SQLite
  path and read access to the session log directory DSH already exposes. No
  other host resources (network, env secrets, shell, child processes) are
  touched.
- **Process lifetime.** The plugin's effect is scoped to the DSH process
  that loads it and tears down on unload. Other DSH instances, your shell,
  and other repos are unaffected.
- **No code execution from stored data.** Replay, diff, and the Compare HTML
  only read from the local store. Nothing in the tool ever executes content
  pulled out of a session log.

If you fork or extend this plugin, treat the SQLite store as
**potentially sensitive**: it contains the full transcript of every model-
visible event, which may include user messages, tool inputs/outputs, and
file paths. Don't share `dsh-trajectory.db` without reviewing its contents.

## Multimodal and sub-agent aware

DSH shipped image attachments (rc.7) and Claude Code / Codex subagent
bundles (rc.8) within a week of the initial open-source release. Because
the listener contract is "append-only on `session/event`", this toolkit
extends without fork or shim:

- `tool/image` events carry `attachmentId`, `mime`, `byteLength`, and an
  optional `@`-menu label. The plugin records **metadata only**; the bytes
  live in the harness' own attachment store.
- `subagent/spawn` / `subagent/complete` events describe Claude Code and
  Codex child-agent lifecycle as it appears in the model-visible log. The
  plugin does not own these handles — it only records when they appeared
  and whether the result was `ok=false`.
- `ls`, `replay`, `diff`, and the HTML Compare view all surface image
  bytes / count and subagent spawns / errors as first-class deltas. The
  Compare HTML header now shows `Δ imgs` and `Δ subs` next to the
  existing duration and error deltas.

A regression script under `scripts/verify-cordis-only.mjs` emits a
three-session workload (two text-only and one multimodal-with-subagent)
through a real `cordis.Context` and feeds it through the same CLI pipeline.

## Compatibility notes

- DSH is in developer preview. The official README warns:
  *"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."* We only consume the public
  `session/event` surface, but pinned event shapes may need updates as DSH
  stabilizes its `SessionEventMap`.
- The plugin does not patch the loop, does not inject anything into the
  model-visible context, and does not extend `SessionEventMap`. It is a
  pure observer.

## What this looks like in practice

Two verification scripts live under `scripts/` and runnable by maintainers
after `npm install`. Convenience npm scripts are wired up:

```bash
npm run verify:cordis    # scripts/verify-cordis-only.mjs
npm run verify:mock-llm  # scripts/verify-with-mock-llm.mjs
```

What each script does:

- **`verify-cordis-only.mjs`** — boots a real `cordis.Context` (the same
  framework DSH itself mounts on), attaches our compiled plugin, and emits a
  synthetic two-session task. The CLI then replays, diffs, and produces an
  HTML compare view.
- **`verify-with-mock-llm.mjs`** — additionally boots
  `@deepseek-ai/dsh-llm-mock-server` (DeepSeek's official OpenAI-compatible
  HTTP/SSE fault server, shipped for recovery tests), fires real
  `POST /chat/completions` over real sockets, parses the SSE stream, and
  feeds the chunks back into Cordis as `assistant/chunk` events. Same CLI
  pipeline at the end.

Both scripts leave nothing on disk: they `mkdtempSync` a workspace, run, and
`rmSync` it on success. Both run entirely on `127.0.0.1`.

Excerpt from a real run of `verify-cordis-only.mjs`:

```
$ node dist/cli/index.js --store $DB replay real-A
session real-A
  started: 2026-08-19T02:50:11.476Z
  ended:   2026-08-19T02:50:11.556Z
  total:   0.08s
  totals:  user=1 assistant=2 tool=1 errors=0
  steps:
    [0] 0.04s errs=0
      asst: I'll scan the repo for stale files.
Three files look stale.
      tool: shell (ok)

$ node dist/cli/index.js --store $DB diff real-A real-B
diff: real-A  vs  real-B
  totals Δ (B - A):
    tool=0  errors=1
    duration=0.00s
  steps:
    [0] tools≠  Δdur=0.00s  Δerr=1
  final answer equal: no
    A: Three files look stale.
    B: Five files look stale.
```

The compare view is a single HTML file, typically ~5–6 KB, with zero runtime
dependencies (no CDN, no framework, no inline `<script src>`).

## Limitations

- The full DSH binary (`@deepseek-ai/dsh`) is large and was not exercisable
  inside this repo's npm install during development. The verification scripts
  therefore boot Cordis and the mock LLM server directly. Once DSH itself is
  reachable in CI, a third script can run end-to-end against the real binary.
- Event shapes are derived from the public `docs/architecture.md` and the
  Cordis behavior observed at runtime; they have not been type-checked
  against the official `SessionEventMap`. Pin your DSH version when this
  matters to you.
- `better-sqlite3` is a native module; build it on a system with a C++
  toolchain you trust. We document the prerequisites in `CONTRIBUTING.md`.

## License

MIT.