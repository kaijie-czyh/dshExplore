/**
 * Minimal shape of the DeepSeek Harness session/event stream we depend on.
 *
 * Why this is a stub instead of importing from @deepseek-ai/dsh:
 * - DSH is in developer preview. README warns: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES".
 * - The Cordis contract for our plugin only needs to (a) consume `session/event` payloads,
 *   and (b) know enough shape to drive replay/diff. Importing internal types would couple us
 *   to whatever the current package layout happens to be.
 *
 * What we depend on (per docs/architecture.md, 2026-08-18):
 * - Every model-visible input is reconstructable from the append-only log.
 * - The log is keyed by `(sessionId, seq)`; durable events are turn/*, step/*,
 *   user/message, assistant/*, tool/*, plus session lifecycle.
 * - Raw assistant/chunk is preserved for replay fidelity.
 *
 * When DSH stabilizes, swap these shapes for the package's SessionEventMap.
 *
 * rc.7 / rc.8 additions (2026-08-21):
 * - `tool/image`: durable image attachment metadata (MCP/ACP attachments,
 *   PTC mode nested-image forwarding). We do NOT persist pixel data.
 * - `subagent/spawn` / `subagent/complete`: Claude Code and Codex subagent
 *   lifecycle as it appears in the session log. The plugin does not own
 *   these handles; it only records when they appeared.
 */

export type SessionId = string;

export interface SessionEventBase {
  /** Monotonic sequence within a session; assigned by DSH on append. */
  seq: number;
  /** Wall-clock timestamp captured by the producer. */
  ts: number;
  /** Originating plugin/component name (e.g. core/agent, core/session). */
  source?: string;
}

export type Role = "user" | "assistant" | "tool" | "system";

export interface UserMessageEvent extends SessionEventBase {
  kind: "user/message";
  sessionId: SessionId;
  text: string;
}

export interface AssistantChunkEvent extends SessionEventBase {
  kind: "assistant/chunk";
  sessionId: SessionId;
  /** Raw streaming chunk payload as produced by the LLM adapter. */
  delta: unknown;
}

export interface AssistantMessageEvent extends SessionEventBase {
  kind: "assistant/message";
  sessionId: SessionId;
  text: string;
  /** Aggregated token usage for this assistant message, if reported. */
  usage?: { input: number; output: number };
}

export interface ToolCallEvent extends SessionEventBase {
  kind: "tool/call";
  sessionId: SessionId;
  toolName: string;
  arguments: unknown;
}

export interface ToolResultEvent extends SessionEventBase {
  kind: "tool/result";
  sessionId: SessionId;
  toolName: string;
  ok: boolean;
  result: unknown;
  /** If !ok, the underlying error message. */
  error?: string;
}

/**
 * rc.7+ durable image attachment. Carries metadata only; the bytes live in the
 * harness' own attachment store. We persist the metadata so that two runs on
 * the same task can be diffed on "which images were cited, where, and how big".
 */
export interface ToolImageEvent extends SessionEventBase {
  kind: "tool/image";
  sessionId: SessionId;
  toolName: string;
  attachmentId: string;
  mime: string;
  byteLength: number;
  /** Optional human-readable label from @-menu references (rc.8). */
  label?: string;
}

/**
 * rc.8+ subagent scheduling. We treat it as durable because Claude Code /
 * Codex subagent lifecycles are now part of the model-visible log.
 * `handle` is a stable identifier usable for matching spawns across replays.
 */
export interface SubagentSpawnEvent extends SessionEventBase {
  kind: "subagent/spawn";
  sessionId: SessionId;
  handle: string;
  profile: string;
  task: string;
}

export interface SubagentCompleteEvent extends SessionEventBase {
  kind: "subagent/complete";
  sessionId: SessionId;
  handle: string;
  ok: boolean;
  error?: string;
}

export interface TurnStartEvent extends SessionEventBase {
  kind: "turn/start";
  sessionId: SessionId;
}

export interface TurnEndEvent extends SessionEventBase {
  kind: "turn/end";
  sessionId: SessionId;
  /** Step count actually executed in this turn (0 if rejected at pre-step). */
  steps: number;
}

export interface StepStartEvent extends SessionEventBase {
  kind: "step/start";
  sessionId: SessionId;
  stepIndex: number;
}

export interface StepEndEvent extends SessionEventBase {
  kind: "step/end";
  sessionId: SessionId;
  stepIndex: number;
}

export type SessionEvent =
  | UserMessageEvent
  | AssistantChunkEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolImageEvent
  | SubagentSpawnEvent
  | SubagentCompleteEvent
  | TurnStartEvent
  | TurnEndEvent
  | StepStartEvent
  | StepEndEvent;

export type SessionEventKind = SessionEvent["kind"];

/**
 * Check whether an arbitrary object looks like one of our durable session events.
 * Used at the Cordis boundary so we don't choke on unknown event kinds.
 */
export function isDurableEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown; sessionId?: unknown; seq?: unknown };
  return (
    typeof v.kind === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.seq === "number"
  );
}

/**
 * Canonical set of durable event kinds we care about. Capability events
 * (fs/*, tools/*, telemetry/*) and live agent events (agent/*) are intentionally
 * excluded: we only persist what can survive a reload.
 */
export const DURABLE_KINDS: ReadonlySet<SessionEventKind> = new Set<SessionEventKind>([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  // rc.7+: image attachments and PTC mode nested-image forwarding.
  "tool/image",
  // rc.8+: Claude Code / Codex subagent scheduling surfaced in the log.
  "subagent/spawn",
  "subagent/complete",
]);