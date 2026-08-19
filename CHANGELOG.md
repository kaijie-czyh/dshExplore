# Changelog

## 0.2.0 — 2026-08-23

DSH shipped multimodal input ([rc.7](https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.0-rc.7)) and Codex / Claude Code subagent bundles ([rc.8](https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.0-rc.8)) inside a week of `0.1.0`. This release keeps the read-only observer contract but makes the new event shapes first-class so A/B diff and Compare HTML stay useful on multimodal and subagent-rich sessions.

### Added

- **`tool/image` event** (rc.7+): durable image attachment metadata from MCP/ACP and PTC mode nested-image forwarding. We persist `attachmentId`, `mime`, `byteLength`, and the optional `@`-menu label; **never the pixel bytes**.
- **`subagent/spawn` and `subagent/complete` events** (rc.8+): Claude Code / Codex subagent lifecycle as recorded in the session log. `handle` is matched against the corresponding `spawn` so a delayed `complete` slots in correctly.
- **Multimodal-aware totals**: `ls`, `replay`, `diff`, and the HTML Compare view all surface image bytes / count and subagent spawns / errors. New event kinds are added to `DURABLE_KINDS` so they round-trip through SQLite.
- **Compare HTML**: each step now also renders image chips and subagent chips, and the header shows `Δ imgs` and `Δ subs` next to the existing duration / error deltas.
- **Schema v2 migration**: `ALTER TABLE … ADD COLUMN` for the new counters; existing stores backfill cleanly to zero.

### Compatibility

- `SessionEvent` is widened by *adding* optional variants — existing consumers compile unchanged.
- Plugin still does not extend `SessionEventMap`, does not inject into model-visible context, and does not patch the agent loop.

## 0.1.0 — 2026-08-19

Initial release. Tracks DeepSeek Harness developer preview.

- Cordis plugin: subscribes to `session/event`, persists durable events to a
  local SQLite store. New `autoDispose` option for test ergonomics; default
  behavior is unchanged for DSH mounts.
- CLI: `ls`, `replay`, `diff`, `compare`, `ingest`, with bilingual `--help`.
- Self-contained HTML Compare view (no runtime dependencies, embeds both replays).
- Two example JSONL sessions under `examples/`.
- Two maintainer verification scripts under `scripts/`:
  - `verify-cordis-only.mjs` — boots a real `cordis.Context`, attaches the
    compiled plugin, emits a two-session task, and exercises the CLI.
  - `verify-with-mock-llm.mjs` — additionally boots
    `@deepseek-ai/dsh-llm-mock-server`, fires real `POST /chat/completions`
    over real sockets, parses the SSE stream, and feeds chunks back into
    Cordis as `assistant/chunk` events.
- Smoke tests via `node --test`.
- Repository plumbing: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue / PR templates, GitHub Actions CI on Node
  18 / 20 / 22 × ubuntu / windows / macos, Dependabot.
