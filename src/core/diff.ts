/**
 * Compare two replay summaries and produce a structured diff.
 *
 * Goal: tell a reviewer at a glance whether two DSH sessions on the same task
 * diverged in step count, tool selection, error rate, latency, or final answer.
 */

import type { ReplaySummary } from "./replay.js";

export interface StepDiff {
  index: number;
  /** false if both sides have a step at this index. true if only A or only B. */
  divergence: "only-a" | "only-b" | "shared";
  toolsA?: string[];
  toolsB?: string[];
  toolSetEqual?: boolean;
  durationDeltaMs?: number;
  errorDelta?: number;
}

export interface SummaryDiff {
  sessionA: string;
  sessionB: string;
  totals: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    errors: number;
    durationMs: number;
    /** rc.7+: byte delta across durable image attachments. */
    imageBytesDelta: number;
    /** rc.7+: attachment count delta. */
    imageCountDelta: number;
    /** rc.8+: number of additional subagent spawns in B vs A. */
    subagentSpawnDelta: number;
    /** rc.8+: number of additional subagent errors in B vs A. */
    subagentErrorDelta: number;
  };
  steps: StepDiff[];
  finalAnswerA?: string;
  finalAnswerB?: string;
  finalAnswerEqual?: boolean;
}

export function diff(a: ReplaySummary, b: ReplaySummary): SummaryDiff {
  const maxLen = Math.max(a.steps.length, b.steps.length);
  const steps: StepDiff[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    const sa = a.steps[i];
    const sb = b.steps[i];
    if (sa && !sb) {
      steps.push({ index: i, divergence: "only-a", toolsA: sa.toolCalls.map((t) => t.name) });
    } else if (!sa && sb) {
      steps.push({ index: i, divergence: "only-b", toolsB: sb.toolCalls.map((t) => t.name) });
    } else if (sa && sb) {
      const toolsA = sa.toolCalls.map((t) => t.name);
      const toolsB = sb.toolCalls.map((t) => t.name);
      steps.push({
        index: i,
        divergence: "shared",
        toolsA,
        toolsB,
        toolSetEqual: sameSet(toolsA, toolsB),
        durationDeltaMs: sb.durationMs - sa.durationMs,
        errorDelta: sb.errorCount - sa.errorCount,
      });
    }
  }
  const finalA = lastAssistant(a);
  const finalB = lastAssistant(b);
  return {
    sessionA: a.sessionId,
    sessionB: b.sessionId,
    totals: {
      userMessages: b.totals.userMessages - a.totals.userMessages,
      assistantMessages: b.totals.assistantMessages - a.totals.assistantMessages,
      toolCalls: b.totals.toolCalls - a.totals.toolCalls,
      errors: b.totals.errors - a.totals.errors,
      durationMs: b.totalDurationMs - a.totalDurationMs,
      imageBytesDelta: b.totals.imageBytes - a.totals.imageBytes,
      imageCountDelta: b.totals.imageCount - a.totals.imageCount,
      subagentSpawnDelta: b.totals.subagentSpawns - a.totals.subagentSpawns,
      subagentErrorDelta: b.totals.subagentErrors - a.totals.subagentErrors,
    },
    steps,
    finalAnswerA: finalA,
    finalAnswerB: finalB,
    finalAnswerEqual: finalA === finalB,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function lastAssistant(s: ReplaySummary): string | undefined {
  for (let i = s.steps.length - 1; i >= 0; i -= 1) {
    if (s.steps[i].assistant) return s.steps[i].assistant;
  }
  return undefined;
}

/** Render the diff as a human-readable report. */
export function renderDiff(d: SummaryDiff): string {
  const lines: string[] = [];
  lines.push(`diff: ${d.sessionA}  vs  ${d.sessionB}`);
  lines.push(`  totals Δ (B - A):`);
  lines.push(`    user=${d.totals.userMessages}  assistant=${d.totals.assistantMessages}`);
  lines.push(`    tool=${d.totals.toolCalls}  errors=${d.totals.errors}`);
  lines.push(`    duration=${(d.totals.durationMs / 1000).toFixed(2)}s`);
  // rc.7/8 fields are surfaced only when non-zero, to keep the legacy report tidy.
  const t = d.totals;
  const extras: string[] = [];
  if (t.imageCountDelta || t.imageBytesDelta) extras.push(`images=Δ${t.imageCountDelta}(${formatBytesSigned(t.imageBytesDelta)})`);
  if (t.subagentSpawnDelta || t.subagentErrorDelta) extras.push(`subagents=Δ${t.subagentSpawnDelta}(err=${t.subagentErrorDelta})`);
  if (extras.length) lines.push(`    ${extras.join("  ")}`);
  lines.push(`  steps:`);
  for (const s of d.steps) {
    if (s.divergence !== "shared") {
      lines.push(`    [${s.index}] ${s.divergence.toUpperCase()}`);
      continue;
    }
    const toolsEq = s.toolSetEqual ? "=" : "≠";
    const dur = s.durationDeltaMs ?? 0;
    const err = s.errorDelta ?? 0;
    lines.push(
      `    [${s.index}] tools${toolsEq}  Δdur=${(dur / 1000).toFixed(2)}s  Δerr=${err}`,
    );
  }
  lines.push(`  final answer equal: ${d.finalAnswerEqual ? "yes" : "no"}`);
  if (!d.finalAnswerEqual) {
    if (d.finalAnswerA) lines.push(`    A: ${truncate(d.finalAnswerA, 240)}`);
    if (d.finalAnswerB) lines.push(`    B: ${truncate(d.finalAnswerB, 240)}`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatBytesSigned(n: number): string {
  if (n === 0) return "0B";
  const sign = n > 0 ? "+" : "-";
  return sign + formatBytes(Math.abs(n));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}