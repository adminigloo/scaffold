/**
 * The 2026-10-12 review's findings that land in the generator: the photo
 * reading notice that names the real fix (EST-R12), a cron that runs to a time
 * budget (ADV-5, ADV-7), a reading that fits inside its route (ADV-6), and the
 * estimator in the CI generator matrix (EST-R15). Each failed before its fix.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, overlayNamesFor, type Answers } from "../answers.js";
import { collectAnswers, parseArgs } from "../cli.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { defaultsOnlyPrompter } from "../prompt.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");
const REPO = join(__dirname, "..", "..", "..", "..");

const FULL: Partial<Answers> = {
  includeComms: true,
  includeEmail: true,
  includeStorage: true,
  includeAi: true,
  includeScheduling: true,
  includeInvoicing: true,
};

const plan = (overrides: Partial<Answers> = {}) =>
  // The single-business estimator these fixes were made to (--tenant-noun none).
  planEmit(TEMPLATE_DIR, "/out", { ...DEFAULT_ANSWERS, projectName: "summit-ramps", tenantNoun: "none", adminShell: "minimal", includeEstimator: true, ...overrides });

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PUBLIC_ROUTE = ["app", "api", "estimator", "[...path]", "route.ts"];
const ADMIN_ROUTE = ["app", "api", "admin", "estimator", "[...path]", "route.ts"];
const CRON_ROUTE = ["app", "api", "cron", "estimator", "route.ts"];
const SERVICES = ["src", "server", "estimator-services.ts"];

describe("EST-R12: why photo reading is off, in words that name the fix", () => {
  it("the staff route passes the reason the services worked out", async () => {
    expect(code(file(await plan(FULL), ...ADMIN_ROUTE))).toContain("photoReadingOff: estimatorPhotoReadingOff");
  });

  it("with --ai: no key, or a model with no price; without it: not installed", async () => {
    const services = code(file(await plan(FULL), ...SERVICES));
    expect(services).toContain("export const estimatorPhotoReadingOff: PhotoReadingOffReason | undefined = takeoffSetup.off;");
    expect(services).toContain('if (!anthropic) return { takeoff: undefined, off: "no_key" };');
    expect(services).toContain('return { takeoff: undefined, off: "model_unpriced" };');
    const bare = code(file(await plan({ ...FULL, includeAi: false }), ...SERVICES));
    expect(bare).toContain('export const estimatorPhotoReadingOff: PhotoReadingOffReason | undefined = "not_installed";');
  });
});

describe("ADV-5, ADV-7: the cron keeps going until the work is done or its time is up", () => {
  it("expires (and announces) quotes and clears photos to a time budget inside maxDuration, and reports what it announced", async () => {
    const cron = file(await plan(FULL), ...CRON_ROUTE);
    expect(cron).toContain("export const maxDuration = 60;");
    const body = code(cron);
    expect(body).toMatch(/expireQuotes\(db, tenantId, \{ onEvent: onEstimatorEvent, timeBudgetMs: [\d_]+ \}\)/);
    expect(body).toMatch(/purgeOrphanPhotos\(db, estimatorPhotoStore, \{ timeBudgetMs: [\d_]+ \}\)/);
    const budgets = [...body.matchAll(/timeBudgetMs: (\d[\d_]*)/g)].map((m) => Number(m[1]!.replace(/_/g, "")));
    // Both together, with room for the rest of the request, inside the 60 s.
    expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(50_000);
    expect(body).toContain("announced: expired.announced");
  });
});

describe("ADV-6: a photo reading fits inside its route", () => {
  it("the public route gives the reading more than its 12 s, and says so", async () => {
    const route = file(await plan(FULL), ...PUBLIC_ROUTE);
    expect(route).toContain("export const maxDuration = 30;");
    expect(route).toContain("12 seconds");
    expect(route).not.toContain("20 seconds");
  });
});

describe("EST-R15: the estimator is in the CI generator matrix", () => {
  const workflow = readFileSync(join(REPO, ".github", "workflows", "generator-matrix.yml"), "utf8");
  const entries = [...workflow.matchAll(/- id: (\S+)\n\s+flags: ([^\n]+)\n\s+overlays: ([^\n]+)/g)].map((m) => ({
    id: m[1]!,
    flags: m[2]!.trim().split(/\s+/),
    overlays: m[3]!.trim(),
  }));

  it("builds the full field-service estimator and the smallest one", () => {
    const flagSets = entries.map((e) => e.flags.join(" "));
    expect(flagSets).toContain("--estimator --scheduling --invoicing --comms --email --storage --ai --admin full");
    expect(flagSets).toContain("--estimator --admin minimal --no-comms --no-storage");
  });

  it("every entry's declared overlays are what those flags generate", async () => {
    expect(entries.length).toBeGreaterThan(0);
    const asSet = (names: readonly string[]) =>
      names
        .map((n) => n.trim())
        .filter((n) => n !== "" && n !== "none")
        .sort()
        .join(", ") || "none";
    for (const entry of entries) {
      const answers = await collectAnswers(parseArgs(["app", "--yes", ...entry.flags]), defaultsOnlyPrompter());
      expect(asSet(overlayNamesFor(answers)), entry.id).toBe(asSet(entry.overlays.split(",")));
    }
  });
});
