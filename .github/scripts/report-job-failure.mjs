#!/usr/bin/env node
//
// Turn a red job into something a person can act on without opening the log.
//
// THREE DAYS OF RED RUNS WENT UNREAD, and that is the defect this file exists
// for. The nightly matrix failed on every entry and CI failed on every push,
// including three tagged releases, and the whole of the signal was an email
// with a workflow name and an exit code in it. Nobody connected it to the work
// because nothing in it said what had broken. A run that cannot say what it
// found is indistinguishable from a run nobody looks at.
//
// So every job that can fail ends with one step that writes the three facts
// needed to act — WHICH configuration, WHICH step, and WHAT it actually said —
// into the job summary, which is the panel GitHub puts at the top of the run
// page and quotes in the notification. Six matrix entries then read as six
// sentences rather than six red dots and an id somebody chose.
//
// WHICH STEP FAILED IS READ FROM THE `steps` CONTEXT rather than recorded by
// each step as it goes. `${{ toJSON(steps) }}` carries the outcome of every
// step that has an `id`, so a step added tomorrow is covered by having an id
// and nothing else — where a breadcrumb file has to be written by the step
// that failed, which is precisely the step that did not get to run its own
// error handling. It is also the only way to name a failure in `Generate` or
// in an assertion step, neither of which has a log file to excerpt.
//
// THE HEADLINE IS PREPENDED, not appended. The route sweep and the steps
// themselves write their detail into the summary as they fail, so appending
// would put "here is what broke" underneath sixty lines of the thing that
// broke. The summary is an ordinary file this job owns, so it is read, and
// rewritten with the headline first.
//
// The log tail is included ONLY when nothing else has written to the summary.
// A step that already explained itself — the route sweep prints the status of
// every route and the tail of the server output — does not need its log
// repeated underneath a second copy of the same sixty lines.
//
//   node .github/scripts/report-job-failure.mjs <label>
//
// Reads from the environment:
//   STEPS      `${{ toJSON(steps) }}` — required; without it nothing can be
//              said about which step failed
//   LOG_DIR    where to look for `<step-id>.log`, if the job writes them
//   REPRODUCE  the commands that reproduce this job locally, verbatim

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_LINES = 60;

const label = process.argv[2] ?? process.env.GITHUB_JOB ?? "this job";
const logDir = process.env.LOG_DIR ?? "";
const reproduce = process.env.REPRODUCE ?? "";

/**
 * Which steps failed, in the order they ran.
 *
 * `outcome` rather than `conclusion`: a step marked `continue-on-error` has an
 * outcome of "failure" and a conclusion of "success", and the outcome is the
 * honest answer to "did this work". Object key order in `toJSON(steps)` follows
 * the order the steps are declared, which is the order they ran.
 */
function failedSteps() {
  let steps;
  try {
    steps = JSON.parse(process.env.STEPS ?? "{}");
  } catch {
    return [];
  }
  return Object.entries(steps)
    .filter(([, state]) => state?.outcome === "failure")
    .map(([id]) => id);
}

/** `what-was-generated` reads as a sentence; `whatWasGenerated` does not. */
function readable(id) {
  return id.replace(/[-_]/g, " ");
}

function tailOf(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(-LOG_LINES).join("\n").trimEnd();
}

/**
 * A fence long enough to hold the content.
 *
 * A three-backtick fence around a log that itself contains three backticks
 * closes early, and the rest of the summary renders as prose with the actual
 * error somewhere inside it. Vitest quotes source, source contains markdown,
 * and this is the one panel that has to stay readable when everything else has
 * gone wrong.
 */
function fence(content) {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Escape a workflow-command PROPERTY value.
 *
 * `,` separates one property from the next and `:` ends the property section,
 * so a job named "generate a project, build it, and run its suite" silently
 * truncates the annotation title at the first comma and turns the rest into
 * properties GitHub does not recognise. The escapes are GitHub's own.
 */
function escapeProperty(value) {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/** The message half. Commas are safe here; a newline would end the command. */
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

const failed = failedSteps();
const step = failed[0];
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const existing =
  summaryPath && existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";

const lines = [];
lines.push(
  step === undefined
    ? `## ${label} — failed, and no step reported it`
    : `## ${label} — failed at \`${readable(step)}\``,
);
lines.push("");

if (step === undefined) {
  // Not a hypothetical: a service container that never becomes healthy, a
  // runner that is evicted, and a `post` action that throws all fail the job
  // without any step of ours going red. Saying so is better than an empty
  // heading, because it tells the reader to look somewhere other than the
  // steps.
  lines.push(
    "Every step with an id either passed or never ran, so the failure is outside them —",
    "a service container, a `post` step, a cancellation, or the runner itself.",
    "",
  );
}

lines.push("| | |", "|---|---|");
lines.push(`| workflow | ${process.env.GITHUB_WORKFLOW ?? "?"} |`);
lines.push(`| job | \`${label}\` |`);
if (step !== undefined) lines.push(`| failed at | \`${readable(step)}\` |`);
if (failed.length > 1) {
  lines.push(`| also failed | ${failed.slice(1).map((id) => `\`${readable(id)}\``).join(", ")} |`);
}
lines.push(`| commit | \`${(process.env.GITHUB_SHA ?? "").slice(0, 8)}\` on \`${process.env.GITHUB_REF_NAME ?? "?"}\` |`);
lines.push("");

if (reproduce.trim().length > 0) {
  lines.push("Reproduce it locally:", "", "```sh", reproduce.trim(), "```", "");
}

// The log, but only when nothing else has spoken. See the note at the top.
if (step !== undefined && existing.trim().length === 0 && logDir) {
  const path = join(logDir, `${step}.log`);
  if (existsSync(path)) {
    const tail = tailOf(path);
    const bars = fence(tail);
    lines.push(`Last ${LOG_LINES} lines of \`${readable(step)}\`:`, "", bars, tail, bars, "");
  }
}

if (summaryPath) {
  writeFileSync(summaryPath, `${lines.join("\n")}\n${existing}`);
}

// The annotation, which is what appears against the job on the run page and in
// the notification. One line only — newlines are not permitted in one — and it
// leads with the entry, because on a matrix of six the entry is the thing that
// distinguishes this failure from the other five.
const title = step === undefined ? `${label}: failed` : `${label}: ${readable(step)} failed`;
let detail = "See the job summary at the top of the run.";
if (step !== undefined && logDir) {
  const path = join(logDir, `${step}.log`);
  if (existsSync(path)) {
    const first = readFileSync(path, "utf8")
      .split("\n")
      .find((line) => /error/i.test(line));
    if (first) detail = first.trim().slice(0, 400);
  }
}
console.log(`::error title=${escapeProperty(title)}::${escapeData(detail)}`);

// Also into the log itself, so somebody reading the raw output of a step that
// scrolled past still meets the summary of it.
console.log(`----- ${title} -----`);
