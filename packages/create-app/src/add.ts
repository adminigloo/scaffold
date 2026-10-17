import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_ANSWERS,
  deferredUntilDeployedFor,
  optionalEnvFor,
  requiredEnvFor,
  type Answers,
} from "./answers.js";
import { planEmit, type EmitPlan } from "./emit.js";
import { buildManifest, MANIFEST_FILENAME, MANIFEST_VERSION, type ProjectManifest } from "./manifest.js";
import { compareVersions } from "./upgrade-notes.js";

export { compareVersions, parseVersion } from "./upgrade-notes.js";

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
  "analytics",
  "seo",
  "booking",
  "store",
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
  analytics: "includeAnalytics",
  seo: "includeSeo",
  booking: "includeBooking",
  store: "includeStore",
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
  /**
   * `behind` (review BUY-01): the project was made by an older create-app,
   * so "nothing to add" would be false comfort. The feature is there, at the
   * old version, and `upgrade` is what brings it (and every package) forward.
   */
  constructor(feature: FeatureName, behind?: { readonly generatedBy: string; readonly current: string }) {
    super(
      behind
        ? `This project already has ${feature}, as ${madeBy(behind)} wired it. ` +
            `To bring it — and every package — up to this version (${behind.current}), run:\n\n` +
            `  pnpm dlx @adminigloo/create-app@${behind.current} upgrade\n\n` +
            "`upgrade --help` says what it changes and what it leaves for you."
        : `This project already has ${feature}. Nothing to add.`,
    );
  }
}

/**
 * Adding a feature to a project an OLDER create-app made (review BUY-01).
 * The feature's new files are written for THIS version's packages, while the
 * rest of the project — and its package.json — is the old version's: the
 * result installs, and doesn't build. So `add` refuses and names the two
 * commands that work, in order.
 */
export class ProjectBehindError extends Error {
  readonly name = "ProjectBehindError";
  constructor(feature: FeatureName, generatedBy: string, current: string) {
    super(
      `This project was made by ${madeBy({ generatedBy, current })}, and this is create-app ${current}. ` +
        `Bring the project up to date first, then add ${feature}:\n\n` +
        `  pnpm dlx @adminigloo/create-app@${current} upgrade\n` +
        `  pnpm dlx @adminigloo/create-app@${current} add ${feature}\n\n` +
        "`upgrade --help` says what it changes and what it leaves for you.",
    );
  }
}

/** "create-app 0.23.0", or "an earlier build of create-app 0.24.0" when the two say the same number. */
function madeBy(versions: { readonly generatedBy: string; readonly current: string }): string {
  return versions.generatedBy === versions.current ? `an earlier build of create-app ${versions.generatedBy}` : `create-app ${versions.generatedBy}`;
}

/**
 * The stored answers, with any answer THIS generator asks that the one that
 * made the project didn't, at its default — so a manifest from an older
 * version plans with this one.
 */
export function answersFor(manifest: ProjectManifest): Answers {
  return { ...DEFAULT_ANSWERS, ...manifest.answers };
}

/**
 * Was this project made by an OLDER create-app than this one (review BUY-01)?
 * Yes when the manifest names an earlier version, or — the case a version
 * number can't see, an unreleased build — when the package ranges it records
 * aren't the ones this generator writes for the same answers.
 */
export function projectIsBehind(manifest: ProjectManifest, generatorVersion: string): boolean {
  const order = compareVersions(manifest.generator.version, generatorVersion);
  if (order !== null && order < 0) return true;
  const current = buildManifest(answersFor(manifest), generatorVersion);
  return JSON.stringify(manifest.packages) !== JSON.stringify(current.packages);
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
  /**
   * Variables the feature introduces. Reported; `.env.local` is never edited.
   *
   * THE SAME SPLIT A FRESH GENERATION PRINTS (review R2 TB2-08), from the
   * env module's own lists: what a DEPLOYMENT refuses to start without
   * (`deferredUntilDeployedFor`); what only switches the feature on; and
   * what is optional. `add email` used to call RESEND_API_KEY boot-required
   * while a fresh project with email called it optional.
   */
  readonly newRequiredEnv: readonly string[];
  readonly newFeatureEnv: readonly string[];
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
  const generatorVersion = await currentGeneratorVersion(templateDir);
  // Made by an older create-app (review BUY-01): adding to it would mix two
  // versions' files and leave the old package ranges, a project that installs
  // and doesn't build. `upgrade` first.
  const behind = projectIsBehind(manifest, generatorVersion);
  if (oldAnswers[key] === true) {
    throw new FeatureAlreadyPresentError(feature, behind ? { generatedBy: manifest.generator.version, current: generatorVersion } : undefined);
  }
  if (behind) throw new ProjectBehindError(feature, manifest.generator.version, generatorVersion);

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
      packageJson = (await mergePackageJson(projectDir, before, next, newAnswers.scope)).text;
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

  const oldDeferred = new Set(deferredUntilDeployedFor(oldAnswers));
  const oldRequired = new Set(requiredEnvFor(oldAnswers));
  const oldOptional = new Set(optionalEnvFor(oldAnswers));
  const newDeferred = deferredUntilDeployedFor(newAnswers);

  return {
    projectDir,
    feature,
    oldAnswers,
    newAnswers,
    generatedBy: manifest.generator.version,
    generatorVersion,
    creates,
    rewrites,
    conflicts,
    packageJson,
    newRequiredEnv: newDeferred.filter((v) => !oldDeferred.has(v)),
    newFeatureEnv: requiredEnvFor(newAnswers).filter((v) => !oldRequired.has(v) && !newDeferred.includes(v)),
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
  //
  // AND THE SEED, every time (CA-10): a feature that added permission keys
  // grants them to nobody until the catalog is seeded again, and a feature
  // nobody can use reads as a feature that's broken. The seed is idempotent,
  // so running it after a feature that added no keys changes nothing.
  if (plan.rewrites.has(join("src", "db", "schema.ts"))) {
    lines.push("  pnpm db:generate && pnpm db:migrate && pnpm db:seed");
  } else {
    lines.push("  pnpm db:seed");
  }
  lines.push("");

  if (plan.newRequiredEnv.length > 0) {
    lines.push(
      "A deployment refuses to start without these — set them in Vercel (both",
      "scopes) and in .env.local when you need them (it was not touched):",
    );
    for (const v of plan.newRequiredEnv) lines.push(`  ${v}`);
    lines.push("");
  }
  if (plan.newFeatureEnv.length > 0) {
    lines.push("Each of these switches the feature on (it stays off, and says so, until set):");
    for (const v of plan.newFeatureEnv) lines.push(`  ${v}`);
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

export async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

export async function writeInto(
  projectDir: string,
  relPath: string,
  contents: string,
): Promise<void> {
  const full = join(projectDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
}

/** One package range `package.json` was moved to: name, from, to. */
export type RaisedPin = readonly [name: string, from: string, to: string];

/**
 * `package.json` after the generator's change is folded in — a THREE-WAY
 * merge of what the generator wrote before (`generatedBefore`), what it
 * writes now (`generatedAfter`) and the copy on disk.
 *
 * If the copy on disk is exactly what the generator last wrote, use the newly
 * generated one verbatim — that keeps the untouched-project invariant exact. If
 * you have edited it (added a script, a dependency of your own), keep your file
 * and, key by key: take the generator's change wherever your copy still has
 * the value it wrote before (a dependency, a script, `packageManager`…), add
 * what the generator added, drop what it dropped that you never touched, and
 * keep everything you changed.
 *
 * AND RAISE THE PACKAGES' RANGES (review BUY-01). A `${scope}/…` dependency
 * whose range this generator writes HIGHER than the one on disk is raised to
 * it, edited or not: the files this generator writes import what the newer
 * version exports, so leaving `^0.5.0` beside code written for `^0.6.0` is a
 * project that installs and doesn't build. Never lowered. Each raise is
 * reported (`raised`).
 */
export async function mergePackageJson(
  projectDir: string,
  generatedBefore: string,
  generatedAfter: string,
  scope: string,
): Promise<{ readonly text: string; readonly raised: readonly RaisedPin[] }> {
  const onDisk = await readIfExists(join(projectDir, "package.json"));
  const after = JSON.parse(generatedAfter) as PackageJson;
  if (onDisk === null || onDisk === generatedBefore) {
    const before = onDisk === null ? ({} as PackageJson) : (JSON.parse(onDisk) as PackageJson);
    return { text: generatedAfter, raised: raisedBetween(before, after, scope) };
  }

  const current = JSON.parse(onDisk) as PackageJson;
  const before = JSON.parse(generatedBefore) as PackageJson;
  const raised: RaisedPin[] = [];
  const keyed = new Set(["dependencies", "devDependencies", "scripts"]);

  // Every other top-level field: the generator's change where you never
  // changed it (packageManager, engines, the pnpm block…).
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (keyed.has(field)) continue;
    if (JSON.stringify(current[field]) !== JSON.stringify(before[field])) continue;
    if (after[field] === undefined) delete current[field];
    else current[field] = after[field];
  }

  for (const section of ["dependencies", "devDependencies", "scripts"] as const) {
    const was = (before[section] ?? {}) as Record<string, string>;
    const now = (after[section] ?? {}) as Record<string, string>;
    const mine = { ...((current[section] ?? {}) as Record<string, string>) };
    for (const [key, value] of Object.entries(now)) {
      const yours = mine[key];
      if (yours === undefined) {
        // New from the generator (or one you removed that it still writes:
        // a dependency comes back, because the code needs it; a script of
        // yours you removed stays removed).
        if (section !== "scripts" || was[key] === undefined) mine[key] = value;
      } else if (yours === was[key]) {
        mine[key] = value;
      } else if (section !== "scripts" && key.startsWith(`${scope}/`) && compareVersions(yours, value) === -1) {
        mine[key] = value;
      }
      if (section !== "scripts" && yours !== undefined && mine[key] !== yours) raised.push([key, yours, value]);
    }
    for (const [key, value] of Object.entries(was)) {
      // Dropped by the generator, and still exactly what it wrote: dropped.
      if (now[key] === undefined && mine[key] === value) delete mine[key];
    }
    if (Object.keys(mine).length > 0 || current[section] !== undefined) {
      current[section] = section === "scripts" ? mine : sortKeys(mine);
    }
  }
  return { text: `${JSON.stringify(current, null, 2)}\n`, raised };
}

/** The ranges a verbatim rewrite of package.json moved (for the report). */
function raisedBetween(before: PackageJson, after: PackageJson, scope: string): RaisedPin[] {
  const raised: RaisedPin[] = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const was = (before[section] ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries((after[section] ?? {}) as Record<string, string>)) {
      const old = was[key];
      if (old !== undefined && old !== value && key.startsWith(`${scope}/`)) raised.push([key, old, value]);
    }
  }
  return raised;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
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

export async function currentGeneratorVersion(templateDir: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(join(templateDir, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
