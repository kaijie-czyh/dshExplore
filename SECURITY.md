# Security policy

## What this package does

`dsh-trajectory` is a **read-only observer** of the DeepSeek Harness
(`@deepseek-ai/dsh`) `session/event` stream:

- It subscribes to events broadcast by your running DSH process.
- It writes a copy of those events to a local SQLite file inside the directory
  you choose (default `<DSH_HOME>/dsh-trajectory.db`).
- It never patches DSH core, never injects anything into the model-visible
  context, and never extends `SessionEventMap`.
- The CLI only reads that local SQLite file; it does not connect to any
  network endpoint.

## Threat model and out-of-scope

The package inherits the trust boundary of whatever DSH process mounts it.
You should think of it like a debug logger:

- **In scope**: integrity of the local store, predictable resource usage,
  no surprise network egress, no privilege escalation beyond what your DSH
  process already has.
- **Out of scope**: the safety of prompts or tool calls made by DSH itself,
  model output quality, and the confidentiality of anything the model sees.
  This package sees whatever the model sees, by design.

## Permissions this package requests

By default the plugin:

- Reads files only inside the `--store` path you pass (default
  `<DSH_HOME>/dsh-trajectory.db` and its `-wal`/`-shm` companions).
- Writes only to that same path.
- Does not open network sockets.

The CLI additionally:

- Reads any `--store` path you pass and any file passed to `ingest`.
- Writes the HTML output of `compare -o <path>` only to the path you specify.

If a future release needs broader access, it will be opt-in and called out in
the CHANGELOG.

## Reporting a vulnerability

**Do not** file a public GitHub issue for security problems. Please email the
maintainer at the address listed on the npm package page or the GitHub
repository's "Security" tab, with:

1. A description of the issue and its impact.
2. Reproduction steps, including the DSH version and the `sessionId` if
   available.
3. Whether you would like public credit.

We aim to acknowledge within **5 business days** and to ship a fix or a
documented mitigation within **30 days** for high-severity issues.

## Supply chain

- Runtime dependencies are pinned in `package-lock.json`; releases are
  reproducible with `npm ci`.
- CI runs on every push and PR; see `.github/workflows/ci.yml`.
- Dependabot opens weekly PRs for new dependency versions; maintainers
  review and merge deliberately.

## Known limitations

- The plugin relies on the public `session/event` event names. DeepSeek
  Harness is in developer preview and may rename or restructure events;
  a breaking change in DSH can manifest as silently dropped events here.
  Pin your DSH version in production.
- `better-sqlite3` is a native module. Build it from source only on systems
  where you trust the toolchain.