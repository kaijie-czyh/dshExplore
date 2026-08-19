/**
 * Cordis plugin for DeepSeek Harness (DSH).
 *
 * Mounts beside the official plugins; subscribes to the durable `session/event`
 * stream and persists every event into the local SQLite store. No model-visible
 * injection, no policy overrides, no core patching.
 *
 * Mount contract (per docs/architecture.md "Where new behavior goes"):
 *   - We do NOT extend `SessionEventMap`. We are a consumer only.
 *   - We use `ctx.sessions` (read-only) when available, falling back to a
 *     direct listener for offline harnesses / tests.
 *   - The plugin exports a `apply(ctx, options)` helper. DSH loads it via a
 *     standard bundle hook (`cordis.patch.yml` or the user's profile patch).
 *
 * The plugin module is intentionally decoupled from the CLI so it can be reused
 * by tests, by other plugins (e.g. an evaluator), and by the bundled CLI.
 */

import { TrajectoryStore, defaultStorePath } from "../core/store.js";
import { isDurableEvent } from "../core/events.js";

export interface TrajectoryPluginOptions {
  /** Override the sqlite path; defaults to <DSH_HOME>/dsh-trajectory.db. */
  storePath?: string;
  /**
   * When true (default), the plugin opens its store eagerly and holds the
   * connection for the lifetime of the process. Set false for ephemeral tasks.
   */
  persistent?: boolean;
  /**
   * When true (default) and `ctx.effect` is available, the plugin registers a
   * Cordis effect that closes the store when the plugin unloads. Disable in
   * test scripts that need to keep the store open across multiple invocations
   * of the same Node process (e.g. emit → invoke the CLI subprocess).
   */
  autoDispose?: boolean;
}

/**
 * Apply the plugin to a Cordis context. We accept a minimal interface so this
 * function is testable without a live DSH runtime.
 */
export interface MinimalCordisContext {
  on: (event: string, listener: (payload: unknown) => void) => unknown;
  off?: (event: string, listener: (payload: unknown) => void) => unknown;
  /** Optional dispose hook, fired when the plugin unloads. */
  effect?: (dispose: () => void) => unknown;
}

export function apply(ctx: MinimalCordisContext, options: TrajectoryPluginOptions = {}) {
  const autoDispose = options.autoDispose !== false;
  const store = new TrajectoryStore({
    storePath: options.storePath ?? defaultStorePath(),
  });

  const listener = (payload: unknown) => {
    if (!isDurableEvent(payload)) return;
    store.append(payload);
  };

  ctx.on("session/event", listener);
  if (autoDispose && ctx.effect) ctx.effect(() => store.close());

  return {
    store,
    detach: () => ctx.off?.("session/event", listener),
  };
}

/**
 * Default Cordis plugin entry — the shape DSH expects from `package.json`'s
 * `dsh.plugin` field. We export a function returning the standard apply.
 */
export default function trajectoryPlugin(ctx: MinimalCordisContext, opts?: TrajectoryPluginOptions) {
  return apply(ctx, opts);
}