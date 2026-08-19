/**
 * Static, dependency-free Compare view for two trajectory JSON blobs.
 *
 * The view is intentionally tiny: a single HTML file that loads two JSON
 * payloads (summary A and summary B) and renders them side by side. It pairs
 * steps by index, colors divergences, and surfaces the totals delta.
 *
 * The CLI does not need a build step to serve it. `dsh-trajectory compare --a <a> --b <b>`
 * will write the rendered HTML to a local file or stdout.
 */

export function renderCompareHtml(summaryA: unknown, summaryB: unknown): string {
  const aJson = JSON.stringify(summaryA, null, 2);
  const bJson = JSON.stringify(summaryB, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DSH Trajectory · Compare</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0b1020; color: #d6deeb; }
  header { padding: 12px 16px; border-bottom: 1px solid #2a3554; }
  h1 { margin: 0; font-size: 14px; font-weight: 600; }
  .meta { color: #8aa1c1; font-size: 12px; margin-top: 4px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #2a3554; }
  .col { background: #0b1020; padding: 12px 16px; }
  .col h2 { font-size: 13px; margin: 0 0 8px 0; color: #82aaff; }
  .step { padding: 8px 10px; margin-bottom: 6px; border: 1px solid #243150; border-radius: 4px; background: #11192e; }
  .step.shared { border-color: #2a4d2a; }
  .step.only-a { border-color: #b3504a; }
  .step.only-b { border-color: #4a7fb3; }
  .tool { display: inline-block; padding: 1px 6px; margin: 2px 4px 0 0; border-radius: 3px; background: #1d2a48; color: #c5d4f0; font-size: 11px; }
  .tool.ok { background: #1d482d; color: #c5f0d4; }
  .tool.err { background: #4d1d1d; color: #f0c5c5; }
  .tool.img { background: #2a3a5a; color: #d6e0ff; }
  .sub { display: inline-block; padding: 1px 6px; margin: 2px 4px 0 0; border-radius: 3px; background: #2a3554; color: #a8b8d0; font-size: 11px; }
  .sub.ok { background: #1d482d; color: #c5f0d4; }
  .sub.err { background: #4d1d1d; color: #f0c5c5; }
  .meta-row { color: #8aa1c1; font-size: 11px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #82aaff; }
  pre { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; background: #0e1428; padding: 6px 8px; border-radius: 3px; }
  .delta { font-weight: 600; }
  .delta.pos { color: #ff8a80; }
  .delta.neg { color: #a5d6a7; }
</style>
</head>
<body>
<header>
  <h1>DSH Trajectory · Compare</h1>
  <div class="meta" id="meta">loading…</div>
</header>
<div class="cols">
  <section class="col"><h2 id="titleA">A</h2><div id="stepsA"></div></section>
  <section class="col"><h2 id="titleB">B</h2><div id="stepsB"></div></section>
</div>
<script>
const a = ${aJson};
const b = ${bJson};

function fmt(ms) { return (ms/1000).toFixed(2) + "s"; }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}
function renderSummaryInto(target, summary, titleId) {
  document.getElementById(titleId).textContent = summary.sessionId;
  const root = document.getElementById(target);
  root.innerHTML = "";
  for (const step of summary.steps) {
    const wrap = el("div", { class: "step" });
    const head = el("div", { class: "meta-row" },
      [el("span", { text: "step " + step.index + "  " }),
       el("span", { text: fmt(step.durationMs) + "  errs=" + step.errorCount })]);
    wrap.appendChild(head);
    if (step.user) {
      wrap.appendChild(el("div", {}, [el("span", { class: "meta-row", text: "user: " }), document.createTextNode(step.user.slice(0,400))]));
    }
    if (step.assistant) {
      wrap.appendChild(el("div", {}, [el("span", { class: "meta-row", text: "asst: " }), document.createTextNode(step.assistant.slice(0,400))]));
    }
    for (const t of step.toolCalls) {
      const cls = "tool " + (t.ok === true ? "ok" : t.ok === false ? "err" : "");
      wrap.appendChild(el("span", { class: cls, text: t.name + (t.ok === undefined ? "" : (t.ok ? " ✓" : " ✗")) }));
    }
    for (const im of step.images || []) {
      wrap.appendChild(el("span", { class: "tool img", text: "img " + im.mime + " " + fmtBytes(im.byteLength) }));
    }
    for (const sa of step.subagents || []) {
      const cls = "sub " + (sa.ok === true ? "ok" : sa.ok === false ? "err" : "");
      wrap.appendChild(el("span", { class: cls, text: "sub:" + sa.profile + " " + sa.handle + (sa.ok === undefined ? "" : (sa.ok ? " ✓" : " ✗")) }));
    }
    root.appendChild(wrap);
  }
}
function computeDelta() {
  const tb = b.totals, ta = a.totals;
  const lines = [
    "Δ user=" + (tb.userMessages - ta.userMessages),
    "Δ asst=" + (tb.assistantMessages - ta.assistantMessages),
    "Δ tools=" + (tb.toolCalls - ta.toolCalls),
    "Δ errs=" + (tb.errors - ta.errors),
    "Δ dur=" + fmt(b.totalDurationMs - a.totalDurationMs),
    "Δ imgs=" + (tb.imageCount - ta.imageCount) + "(" + fmtBytes(tb.imageBytes - ta.imageBytes) + ")",
    "Δ subs=" + (tb.subagentSpawns - ta.subagentSpawns) + "(err=" + (tb.subagentErrors - ta.subagentErrors) + ")",
  ];
  document.getElementById("meta").textContent = lines.join("    ");
}
function fmtBytes(n) {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a < 1024) return s + a + "B";
  if (a < 1048576) return s + (a/1024).toFixed(1) + "KB";
  return s + (a/1048576).toFixed(1) + "MB";
}
function pairDivergenceClasses() {
  const aSteps = document.querySelectorAll("#stepsA .step");
  const bSteps = document.querySelectorAll("#stepsB .step");
  const max = Math.max(aSteps.length, bSteps.length);
  for (let i = 0; i < max; i++) {
    if (aSteps[i] && !bSteps[i]) aSteps[i].classList.add("only-a");
    else if (!aSteps[i] && bSteps[i]) bSteps[i].classList.add("only-b");
    else if (aSteps[i] && bSteps[i]) { aSteps[i].classList.add("shared"); bSteps[i].classList.add("shared"); }
  }
}
renderSummaryInto("stepsA", a, "titleA");
renderSummaryInto("stepsB", b, "titleB");
pairDivergenceClasses();
computeDelta();
</script>
</body>
</html>`;
}