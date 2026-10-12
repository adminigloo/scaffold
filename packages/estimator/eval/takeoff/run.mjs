#!/usr/bin/env node
/**
 * The photo-reading accuracy eval. SPENDS MONEY (about a tenth of a cent a
 * photo on Claude Haiku 4.5), so it never runs in `pnpm test`, and without
 * `--yes` it only prints what it would send and what that would cost.
 *
 *   pnpm --filter @adminigloo/estimator build
 *   ANTHROPIC_API_KEY=… node eval/takeoff/run.mjs [--model claude-haiku-4-5] [--only porch] [--rates 1000000,5000000] --yes
 *
 * It sends EXACTLY what the package sends in production: each photo shrunk
 * the way the widget shrinks it (≤ 768 px on the long edge, JPEG 0.8 — through
 * `sharp`, a dev dependency of this package; without it the run REFUSES,
 * because a full-size photo reports an accuracy and a cost production never
 * sees, and `--full-size` sends the originals anyway, on purpose), the
 * package's own prompt and strict schema, through
 * `createAnthropicTakeoffRunner` from dist/anthropic.js and
 * `normalizeObservation` from dist/index.js. Then it scores the count (exact)
 * and the height (the read range overlaps the expected one), and reports the
 * tokens and the cost.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planRun } from "./plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? "") : undefined;
};
const confirmed = args.includes("--yes");
const allowFullSize = args.includes("--full-size");
const only = flag("only");

const dist = join(here, "..", "..", "dist");
if (!existsSync(join(dist, "index.js")) || !existsSync(join(dist, "anthropic.js"))) {
  console.error("Build the package first: pnpm --filter @adminigloo/estimator build");
  process.exit(1);
}
const pkg = await import(pathToFileURL(join(dist, "index.js")).href);
const { createAnthropicTakeoffRunner } = await import(pathToFileURL(join(dist, "anthropic.js")).href);

const model = flag("model") || pkg.DEFAULT_TAKEOFF_MODEL;
let rates = pkg.TAKEOFF_MODEL_RATES[model];
const ratesFlag = flag("rates");
if (ratesFlag) {
  const [input, output] = ratesFlag.split(",").map(Number);
  rates = { inputMicrosPerMTok: input, outputMicrosPerMTok: output };
}
if (!rates) {
  console.error(`No price for "${model}". Pass --rates <input>,<output> in micro-dollars per million tokens (Haiku 4.5 is 1000000,5000000).`);
  process.exit(1);
}

const fixtures = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8")).filter(
  (fixture) => !only || fixture.file.includes(only) || (fixture.note ?? "").includes(only),
);
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  sharp = null;
}
// Before anything is asked or sent: what is on disk, how much of it is a real
// photo, and whether the photos can be sent the way production sends them.
const plan = planRun({ fixtures, onDisk: (file) => existsSync(join(here, file)), sharpAvailable: sharp !== null, allowFullSize });
for (const fixture of plan.missing) console.log(`skip ${fixture.file}: not on disk (put your own photo there to include it)`);
for (const line of plan.lines) console.log(line);
if (plan.refusal) {
  console.error(plan.refusal);
  process.exit(1);
}
const present = plan.present;

// A typical reading: a ≤ 768 px photo (≈ 600 tokens), the prompt and the schema, and ~40 tokens back.
const typical = pkg.takeoffCostMicros({ inputTokens: 900, outputTokens: 40 }, rates);
const dollars = (micros) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 5 : 4)}`;
console.log(`\n${present.length} photo(s) on ${model}. About ${dollars(typical)} a photo; this run about ${dollars(typical * present.length)}.`);
if (!confirmed) {
  console.log("Nothing was sent. Add --yes to run it (it calls the API and spends that money).");
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run the eval.");
  process.exit(1);
}

if (!sharp) console.log("--full-size: the photos go as they are, NOT the way production sends them.");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const runner = createAnthropicTakeoffRunner({ client: new Anthropic(), model, rates });

const MEDIA = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const rows = [];
for (const fixture of present) {
  const original = readFileSync(join(here, fixture.file));
  let bytes = original;
  let mediaType = MEDIA[extname(fixture.file).toLowerCase()] ?? "image/jpeg";
  if (sharp) {
    bytes = await sharp(original).rotate().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    mediaType = "image/jpeg";
  }
  const config = pkg.resolveRecipeConfig(fixture.recipe, { photoSubject: fixture.subject, ...(fixture.noun ? { noun: fixture.noun } : {}) });
  let response;
  let failure = null;
  try {
    response = await runner.read({
      system: pkg.TAKEOFF_SYSTEM_PROMPT,
      prompt: pkg.buildTakeoffPrompt(fixture.recipe, config),
      schema: pkg.observationJsonSchema(fixture.recipe),
      image: { base64: bytes.toString("base64"), mediaType },
      maxTokens: 150,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const observation = response ? pkg.normalizeObservation(fixture.recipe, response.output) : null;
  const expect = fixture.expect ?? {};
  const count = fixture.recipe === "count" ? observation?.count : observation?.risers;
  let countOk;
  if (expect.seen === false) countOk = observation !== null && observation.seen === false;
  else countOk = observation !== null && count === (fixture.recipe === "count" ? expect.count : expect.risers);
  let heightOk = null;
  if (Array.isArray(expect.riserHeightIn) && observation?.recipe === "ramp_over_steps") {
    const read = observation.riserHeightIn;
    heightOk = read !== null && read.low <= expect.riserHeightIn[1] && read.high >= expect.riserHeightIn[0];
  }
  const cost = response ? pkg.takeoffCostMicros({ inputTokens: response.inputTokens, outputTokens: response.outputTokens }, rates) : 0;
  rows.push({
    file: fixture.file,
    expected: expect,
    read: observation,
    failure,
    countOk,
    heightOk,
    inputTokens: response?.inputTokens ?? 0,
    outputTokens: response?.outputTokens ?? 0,
    costMicros: cost,
  });
  const readText = failure
    ? `failed: ${failure}`
    : observation
      ? `${observation.seen ? (count ?? "?") : "not seen"}${observation.riserHeightIn ? ` @ ${observation.riserHeightIn.low}–${observation.riserHeightIn.high} in` : ""}`
      : "unusable";
  const expectedText = expect.seen === false ? "not seen" : `${expect.risers ?? expect.count}${Array.isArray(expect.riserHeightIn) ? ` @ ${expect.riserHeightIn[0]}–${expect.riserHeightIn[1]} in` : ""}`;
  console.log(
    [
      fixture.file.padEnd(36),
      `expected ${expectedText}`.padEnd(26),
      `read ${readText}`.padEnd(30),
      (observation?.confidence ?? "-").padEnd(7),
      countOk ? "✓" : "✗",
      heightOk === null ? "-" : heightOk ? "✓" : "✗",
      `${response?.inputTokens ?? 0} in / ${response?.outputTokens ?? 0} out`.padEnd(18),
      dollars(cost),
    ].join("  "),
  );
}

const scored = rows.filter((row) => row.heightOk !== null);
const total = rows.reduce((sum, row) => sum + row.costMicros, 0);
const summary = {
  model,
  photos: rows.length,
  countAccuracy: rows.length ? Math.round((rows.filter((row) => row.countOk).length / rows.length) * 100) : 0,
  heightAccuracy: scored.length ? Math.round((scored.filter((row) => row.heightOk).length / scored.length) * 100) : null,
  averageInputTokens: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.inputTokens, 0) / rows.length) : 0,
  averageCostMicros: rows.length ? Math.round(total / rows.length) : 0,
  totalCostMicros: total,
};
console.log(
  `\nCount right: ${summary.countAccuracy}%. Height in range: ${summary.heightAccuracy ?? "-"}%. ` +
    `Average input ${summary.averageInputTokens} tokens; average ${dollars(summary.averageCostMicros)} a photo; total ${dollars(total)}.`,
);
mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
console.log(`Saved ${file}`);
