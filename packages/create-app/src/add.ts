import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  optionalEnvFor,
  requiredEnvFor,
  type Answers,
} from "./answers.js";
import { planEmit, type EmitPlan } from "./emit.js";
import { MANIFEST_FILENAME, MANIFEST_VERSION, type ProjectManifest } from "./manifest.js";

/**
 * `create-adminigloo-app add <feature>` — turn a feature on in a project that
 * already exists.
 *
 * WHY THIS EXISTS. The generator wires a feature at generation time: its tRPC
 * router is MOUNTED in `src/server/routers/_app.ts`, its tables are REGISTERED
 * in `src/db/schema.ts`, its env fragment lands in `src/env.ts`, its page gets a
 * link in the admin sidebar. None of that is an overlay file — overlays only ADD
 * files and are forbidden from rewriting one the base owns — so all of it is
 * emitted by `renderAppRouter(answers)` and its siblings, as a function of the
 * answers. There was therefore no way to add a feature to a project already
 * generated: a customer who bought feedback now and the assistant next quarter
 * had to hand-edit the files the base owns and substitute the overlay's render
 * tokens by hand. That breaks the hands-off promise on every second sale.
 *
 * HOW IT WORKS, AND WHY IT IS SAFE. `adminigloo.json` stores the COMPLETE
 * answers the project was generated from — deliberately, so the project can be
 * reproduced. So adding a feature is a diff:
 *
 *     old = planEmit(answers)                     // what the project is
 *     new = planEmit({ ...answers, feature: on }) // what it should become
 *
 * and the work is `new − old`. `planEmit` is pure — it computes a file map and
 * writes nothing — so both plans are cheap and this is deterministic. The
 * INVARIANT that makes it trustworthy: on a project nobody has edited,
 * `add(feature)` produces byte-for-byte what generating fresh with that feature
 * on would have produced (`.env.local` excepted — it holds secrets and is never
 * rewritten). The test suite asserts exactly that equivalence.
 *
 * WHAT IT WILL NOT DO. It never clobbers an edit. A generated base file the
 * feature must change is overwritten ONLY when the copy on disk still matches
 * what the generator last wrote; if you have edited it, the new version is
 * written beside it as `<file>.new` and you are told to merge. `package.json`
 * is merged rather than overwritten (you own your scripts and your own deps),
 * and `.env.local` is never touched — the new variables are reported instead.
 */

/** The eight toggleable features, spelled as the CLI flag. */
export const ADDABLE_FEATURES = [
  "ai",
  "email",
  "feedback",
  "seo-reports",
  "notifications",
  "storage",
  "assistant",
  "marketing",
  "estimator",
  "scheduling",
  "invoicing",
  "comms",
  "aeo",
] as const;

export type FeatureName = (typeof ADDABLE_FEATURES)[number];

/** Feature flag -> the boolean in `answers` it turns on. */
const FEATURE_ANSWER: Record<FeatureName, keyof Answers> = {
  ai: "includeAi",
  email: "includeEmail",
  feedback: "includeFeedback",
  "seo-reports": "includeSeoReports",
  notifications: "includeNotifications",
  storage: "includeStorage",
  assistant: "includeAssistant",
  marketing: "includeMarketing",
  estimator: "includeEstimator",
  scheduling: "includeScheduling",
  invoicing: "includeInvoicing",
  comms: "includeComms",
  aeo: "includeAeo",
};

export class UnknownFeatureError extends Error {
  readonly name = "UnknownFeatureError";
  constructor(feature: string) {
    super(
      `"${feature}" is not a feature you can add. One of: ` +
        `${ADDABLE_FEATURES.join(", ")}.\n` +
        `Structural choices — the admin shell, the business model, the tenant ` +
        `noun — are not additive and are not changed by \`add\`; regenerate for ` +
        `those.`,
    );
  }
}

export class ManifestUnreadableError extends Error {
  readonly name = "ManifestUnreadableError";
  constructor(projectDir: string, detail: string) {
    super(
      `Could not read ${join(projectDir, MANIFEST_FILENAME)}: ${detail}. ` +
        `\`add\` needs the manifest an AdminIgloo project is generated with — ` +
        `run this from a generated project's root, or pass --dir <path>.`,
    );
  }
}

export class FeatureAlreadyPresentError extends Error {
  readonly name = "FeatureAlreadyPresentError";
  constructor(feature: FeatureName) {
    super(`This project already has ${feature}. Nothing to add.`);
  }
}

/**
 * Read and validate a project's manifest. Refuses a manifest version this
 * generator does not understand rather than guessing at fields that may have
 * moved — the same contract `manifest.ts` documents for every reader.
 */
export async function readProjectManifest(
  projectDir: string,
): Promise<ProjectManifest> {
  const path = join(projectDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ManifestUnreadableError(
      projectDir,
      error instanceof Error ? error.message : String(error),
    );
  }
  let parsed: ProjectManifest;
  try {
    parsed = JSON.parse(raw) as ProjectManifest;
  } catch (error) {
    throw new ManifestUnreadableError(
      projectDir,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.manifestVersion !== MANIFEST_VERSION) {
    throw new ManifestUnreadableError(
      projectDir,
      `manifest version ${String(parsed.manifestVersion)} — this generator ` +
        `writes and understands version ${MANIFEST_VERSION}. Upgrade the CLI, ` +
        `or regenerate the project`,
    );
  }
  if (parsed.answers === undefined || typeof parsed.answers !== "object") {
    throw new ManifestUnreadableError(projectDir, "no answers block");
  }
  return parsed;
}

/** What each changed file will have done to it when the plan is applied. */
export interface AddPlan {
  readonly projectDir: string;
  readonly feature: FeatureName;
  readonly oldAnswers: Answers;
  readonly newAnswers: Answers;
  /** The generator version on disk, and this generator's — a drift warning. */
  readonly generatedBy: string;
  readonly generatorVersion: string;
  /** Files the feature adds that are not on disk yet. */
  readonly creates: ReadonlyMap<string, string>;
  /** Generated base files safe to overwrite — unchanged since generation. */
  readonly rewrites: ReadonlyMap<string, string>;
  /**
   * Generated base files that differ on disk from what the generator last
   * wrote. Written as `<path>.new`; the human merges. This is the only place a
   * local edit can turn into manual work, and it is the price of never losing
   * one.
   */
  readonly conflicts: ReadonlyMap<string, string>;
  /** `package.json` after merging the feature's new dependencies into yours. */
  readonly packageJson: string | null;
  /** Variables the feature introduces. Reported; `.env.local` is never edited. */
  readonly newRequiredEnv: readonly string[];
  readonly newOptionalEnv: readonly string[];
}

/**
 * Files that are generated records, never hand-edited, and therefore always
 * rewritten so they keep telling the truth about the project.
 */
const ALWAYS_REWRITE = new Set([MANIFEST_FILENAME, "SCAFFOLD.md"]);

/** Holds secrets. Never written by `add`; its new variables are reported. */
const NEVER_WRITE = new Set([".env.local"]);

function featureKey(feature: FeatureName): keyof Answers {
  return FEATURE_ANSWER[feature];
}

/**
 * Plan the addition. Reads the manifest and — for base files the feature
 * changes — the copies on disk, to tell an untouched file from an edited one.
 * Writes nothing.
 */
export async function planAdd(
  templateDir: string,
  projectDir: string,
  feature: FeatureName,
): Promise<AddPlan> {
  if (!ADDABLE_FEATURES.includes(feature)) throw new UnknownFeatureError(feature);

  const manifest = await readProjectManifest(projectDir);
  const oldAnswers = manifest.answers;
  const key = featureKey(feature);
  if (oldAnswers[key] === true) throw new FeatureAlreadyPresentError(feature);

  const newAnswers: Answers = { ...oldAnswers, [key]: true };

  const oldPlan = await planEmit(templateDir, projectDir, oldAnswers);
  const newPlan = await planEmit(templateDir, projectDir, newAnswers);

  const creates = new Map<string, string>();
  const rewrites = new Map<string, string>();
  const conflicts = new Map<string, string>();
  let packageJson: string | null = null;

  for (const [relPath, next] of newPlan.files) {
    if (NEVER_WRITE.has(relPath)) continue;

    const before = oldPlan.files.get(relPath);

    // A file the feature ADDS — the base plan never had it.
    if (before === undefined) {
      const onDisk = await readIfExists(join(projectDir, relPath));
      if (onDisk === null) creates.set(relPath, next);
      else if (onDisk === next) continue; // already there, identical
      else conflicts.set(relPath, next); // something else wrote it first
      continue;
    }

    // A file both plans produce with the SAME content — the feature does not
    // touch it. Nothing to do.
    if (before === next) continue;

    // A generated base file the feature CHANGES.
    if (relPath === "package.json") {
      packageJson = await mergePackageJson(projectDir, before, next);
      continue;
    }
    if (ALWAYS_REWRITE.has(relPath)) {
      rewrites.set(relPath, next);
      continue;
    }
    // Overwrite only if the copy on disk is still what the generator wrote.
    const onDisk = await readIfExists(join(projectDir, relPath));
    if (onDisk === null || onDisk === before) rewrites.set(relPath, next);
    else conflicts.set(relPath, next);
  }

  const oldRequired = new Set(requiredEnvFor(oldAnswers));
  const oldOptional = new Set(optionalEnvFor(oldAnswers));

  return {
    projectDir,
    feature,
    oldAnswers,
    newAnswers,
    generatedBy: manifest.generator.version,
    generatorVersion: await currentGeneratorVersion(templateDir),
    creates,
    rewrites,
    conflicts,
    packageJson,
    newRequiredEnv: requiredEnvFor(newAnswers).filter((v) => !oldRequired.has(v)),
    newOptionalEnv: optionalEnvFor(newAnswers).filter((v) => !oldOptional.has(v)),
  };
}

/** Write everything the plan resolved. Creates and rewrites land in place;
 * conflicts land as `<path>.new`; `package.json` is replaced with the merge. */
export async function applyAdd(plan: AddPlan): Promise<void> {
  for (const [relPath, contents] of plan.creates) {
    await writeInto(plan.projectDir, relPath, contents);
  }
  for (const [relPath, contents] of plan.rewrites) {
    await writeInto(plan.projectDir, relPath, contents);
  }
  for (const [relPath, contents] of plan.conflicts) {
    await writeInto(plan.projectDir, `${relPath}.new`, contents);
  }
  if (plan.packageJson !== null) {
    await writeInto(plan.projectDir, "package.json", plan.packageJson);
  }
}

/** What the person has to do next, and why — same voice as `nextSteps`. */
export function addNextSteps(plan: AddPlan): string {
  const lines: string[] = [
    "",
    `Added ${plan.feature} to ${plan.projectDir}`,
    "",
  ];

  if (plan.creates.size > 0) {
    lines.push("New files:");
    for (const relPath of [...plan.creates.keys()].sort()) lines.push(`  ${relPath}`);
    lines.push("");
  }
  if (plan.rewrites.size > 0) {
    lines.push("Rewired (these were unchanged since generation):");
    for (const relPath of [...plan.rewrites.keys()].sort()) lines.push(`  ${relPath}`);
    lines.push("");
  }
  if (plan.packageJson !== null) {
    lines.push("Merged the feature's dependency into package.json.", "");
  }
  if (plan.conflicts.size > 0) {
    lines.push(
      "MERGE THESE BY HAND. You had edited them, so the new version was written",
      "beside each rather than over it — diff and fold in the change:",
    );
    for (const relPath of [...plan.conflicts.keys()].sort()) {
      lines.push(`  ${relPath}.new  ->  ${relPath}`);
    }
    lines.push("");
  }
  if (plan.generatedBy !== plan.generatorVersion) {
    lines.push(
      `Note: this project was generated by ${plan.generatedBy} and you are`,
      `adding with ${plan.generatorVersion}. Where the base template moved`,
      `between the two, more files may land as .new than a same-version add`,
      `would produce — that is the version gap, not your edits.`,
      "",
    );
  }

  lines.push("Then:", "  pnpm install");
  // The schema changed whenever a feature with tables was added, and a schema
  // the migrations do not know about is a table that does not exist.
  if (plan.rewrites.has(join("src", "db", "schema.ts"))) {
    lines.push("  pnpm db:generate && pnpm db:migrate");
  }
  lines.push("");

  if (plan.newRequiredEnv.length > 0) {
    lines.push(
      "This feature needs these before the app will boot once deployed — add",
      "them to .env.local (it was not touched):",
    );
    for (const v of plan.newRequiredEnv) lines.push(`  ${v}`);
    lines.push("");
  }
  if (plan.newOptionalEnv.length > 0) {
    lines.push(
      "Optional — the feature degrades to a notice until each is set:",
    );
    for (const v of plan.newOptionalEnv) lines.push(`  ${v}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

async function writeInto(
  projectDir: string,
  relPath: string,
  contents: string,
): Promise<void> {
  const full = join(projectDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
}

/**
 * `package.json` after the feature's new dependencies are folded in.
 *
 * If the copy on disk is exactly what the generator last wrote, use the newly
 * generated one verbatim — that keeps the untouched-project invariant exact. If
 * you have edited it (added a script, a dependency of your own), keep your file
 * and add only the dependency keys the new plan introduced, so a feature-add
 * never reverts your work.
 */
async function mergePackageJson(
  projectDir: string,
  generatedBefore: string,
  generatedAfter: string,
): Promise<string> {
  const onDisk = await readIfExists(join(projectDir, "package.json"));
  if (onDisk === null || onDisk === generatedBefore) return generatedAfter;

  const current = JSON.parse(onDisk) as PackageJson;
  const after = JSON.parse(generatedAfter) as PackageJson;
  for (const section of ["dependencies", "devDependencies"] as const) {
    const incoming = after[section];
    if (incoming === undefined) continue;
    const existing = current[section] ?? {};
    for (const [dep, range] of Object.entries(incoming)) {
      if (existing[dep] === undefined) existing[dep] = range;
    }
    current[section] = sortKeys(existing);
  }
  return `${JSON.stringify(current, null, 2)}\n`;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

async function currentGeneratorVersion(templateDir: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(join(templateDir, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
