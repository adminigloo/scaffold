import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  ADMIN_SHELLS,
  AUDIENCES,
  BUSINESS_MODELS,
  DEFAULT_ANSWERS,
  IncompatibleAnswersError,
  TENANT_NOUNS,
  assertAnswersCompatible,
  consumerProduct,
  deferredUntilDeployedFor,
  optionalEnvFor,
  requiredEnvFor,
  tenantLabelPlural,
  type Answers,
} from "./answers.js";
import {
  answersFor,
  currentGeneratorVersion,
  mergePackageJson,
  projectIsBehind,
  readIfExists,
  readProjectManifest,
  sameText,
  writeInto,
  type RaisedPin,
} from "./add.js";
import { PERSONAL_ACCOUNT_RETIRED } from "./consumer-emit.js";
import { planEmit } from "./emit.js";
import { MANIFEST_FILENAME } from "./manifest.js";
import { planRecordSwitchNote, switchNotesFor, upgradeNotesFor } from "./upgrade-notes.js";
import {
  NO_LOSSES,
  SCHEMA_MODULE_PATH,
  describeLosses,
  droppedTableNames,
  losesAnything,
  lossRefusal,
  upgradeLosses,
  type UpgradeLosses,
} from "./upgrade-losses.js";

/**
 * `create-adminigloo-app upgrade` — bring a project an OLDER create-app made
 * up to this version (review BUY-01: a Tenancy 2a project had no way to reach
 * 2b-1; `add` refused, or wrote a project that didn't build).
 *
 * WHY IT NEEDS THE OLD GENERATOR. `add` can tell a file you edited from one
 * you didn't because it can regenerate what it wrote before: the same answers
 * through the same generator. Across versions that's no longer true — this
 * version's output for your answers isn't what the old version wrote, so
 * every file the template changed would look like your edit. So `upgrade`
 * runs THE VERSION THAT MADE THE PROJECT (named in adminigloo.json, fetched
 * with `npm pack` through the project's own .npmrc, or given with `--from`)
 * to get exactly what it wrote, and then it is the same three-way as `add`:
 *
 *     old  = that version's planEmit(answers)   // what it wrote
 *     new  = this version's planEmit(answers)   // what it writes now
 *     disk = the project
 *
 *   - in new, not on disk                → written
 *   - on disk exactly as old wrote it    → rewritten with new (you never touched it)
 *   - on disk, and you changed it        → new written beside it as <file>.new
 *   - in old, not in new, as old wrote it → deleted (this version doesn't use it)
 *   - in old, not in new, and changed    → left, and listed: move your change, then delete it
 *   - package.json                        → three-way merged, the packages raised
 *   - .env.local                          → never touched; new variables are listed
 *
 * "Exactly as old wrote it" is line endings aside (`sameText`): git checks a
 * project out under its own `* text=auto eol=lf`, and a CRLF file an older
 * create-app wrote is still untouched when it comes back as LF.
 *
 * AND NOTHING IS LOST WITHOUT BEING ASKED (review): an upgrade that would drop
 * tables (a package leaving src/db/schema.ts), change what an account is, or
 * stop a plan check is refused before it writes anything, unless
 * `--allow-data-loss` is given — and then every loss is listed, the dropped
 * tables by name, above the steps.
 *
 * The invariant, as `add`'s: on a project nobody edited, `upgrade` leaves
 * byte for byte what generating fresh with this version would (`.env.local`
 * excepted, and src/plans.ts on an answer switch). The suite holds it to that.
 */

/** A create-app version the project was made by, loaded so its planEmit can run. */
export interface PreviousGenerator {
  readonly version: string;
  /** The folder it was loaded from (dist/, template/, overlays/). */
  readonly dir: string;
  /** What that version writes for these answers, as a map of path → contents. */
  plan(projectDir: string, answers: Answers): Promise<ReadonlyMap<string, string>>;
}

export class PreviousGeneratorError extends Error {
  readonly name = "PreviousGeneratorError";
}

export class UpgradeVersionMismatchError extends Error {
  readonly name = "UpgradeVersionMismatchError";
  constructor(madeBy: string, given: string) {
    super(
      `This project was made by create-app ${madeBy}, but the create-app given to compare with is ${given}. ` +
        `Point --from at create-app ${madeBy} (npm pack @adminigloo/create-app@${madeBy}, then unpack it), ` +
        "or leave --from out and it is fetched.",
    );
  }
}

/**
 * Load an earlier create-app from a folder holding its published files
 * (`dist/index.js`, `template/`, `overlays/`, `package.json`). Its CLI must
 * not run when imported, so the guard its index.js has always had is set.
 */
export async function loadPreviousGenerator(dir: string): Promise<PreviousGenerator> {
  const root = resolve(dir);
  let version: string;
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version !== "string") throw new Error("it names no version");
    version = pkg.version;
  } catch (error) {
    throw new PreviousGeneratorError(
      `${join(root, "package.json")} isn't a create-app package.json (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const guard = process.env["ADMINIGLOO_CREATE_APP_NO_AUTORUN"];
  process.env["ADMINIGLOO_CREATE_APP_NO_AUTORUN"] = "1";
  let mod: { planEmit?: unknown };
  try {
    mod = (await import(pathToFileURL(join(root, "dist", "index.js")).href)) as { planEmit?: unknown };
  } catch (error) {
    throw new PreviousGeneratorError(
      `Couldn't load create-app ${version} from ${root} (${error instanceof Error ? error.message : String(error)}).`,
    );
  } finally {
    if (guard === undefined) delete process.env["ADMINIGLOO_CREATE_APP_NO_AUTORUN"];
    else process.env["ADMINIGLOO_CREATE_APP_NO_AUTORUN"] = guard;
  }
  const planEmitOld = mod.planEmit;
  if (typeof planEmitOld !== "function") {
    throw new PreviousGeneratorError(`create-app ${version} in ${root} has no planEmit to compare with.`);
  }
  return {
    version,
    dir: root,
    async plan(projectDir, answers) {
      const plan = (await planEmitOld(join(root, "template"), projectDir, answers)) as { files?: unknown };
      if (!(plan.files instanceof Map)) throw new PreviousGeneratorError(`create-app ${version}'s planEmit answered no file map.`);
      return plan.files as ReadonlyMap<string, string>;
    },
  };
}

/** How a package is fetched: `npm pack <spec> --pack-destination <dest>`, run in the project. */
export type PackFn = (spec: string, dest: string, cwd: string) => Promise<void>;

/** How npm is started: what `spawnSync` is given. */
export interface NpmCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

/**
 * How to start `npm <args>` on `platform`.
 *
 * Windows runs npm through its .cmd shim, which only a shell can start. Node
 * 24 prints DEP0190 ("Passing args to a child process with shell option true
 * can lead to security vulnerabilities…") whenever a shell is handed an
 * argument LIST, since it only joins them — in the buyer's own terminal, in
 * the middle of `upgrade`. So on Windows cmd gets ONE command line, each
 * argument quoted here, and no list; everywhere else npm is started itself,
 * with the list and no shell, so nothing reads the arguments at all.
 *
 * The arguments are a validated package spec, flags and a temp folder. cmd
 * still acts on a double quote, a % (variables expand inside quotes) and a
 * line break, so an argument holding one is refused rather than passed: the
 * caller's error then says to fetch the package by hand and use --from.
 */
export function npmCommand(args: readonly string[], platform: NodeJS.Platform = process.platform): NpmCommand {
  if (platform !== "win32") return { command: "npm", args: [...args], shell: false };
  for (const arg of args) {
    if (/["%\r\n]/.test(arg)) {
      throw new Error(`${JSON.stringify(arg)} can't be passed to npm through cmd (it holds a quote, a % or a line break)`);
    }
  }
  return { command: ["npm", ...args.map((arg) => `"${arg}"`)].join(" "), args: [], shell: true };
}

/** `npm <args>` in `cwd`, started as `npmCommand` says, its output read as text. */
export function runNpm(args: readonly string[], options: { readonly cwd: string }): SpawnSyncReturns<string> {
  const npm = npmCommand(args);
  return spawnSync(npm.command, [...npm.args], { cwd: options.cwd, encoding: "utf8", shell: npm.shell });
}

const npmPack: PackFn = async (spec, dest, cwd) => {
  const result = runNpm(["pack", spec, "--pack-destination", dest, "--silent"], { cwd });
  if (result.status !== 0) {
    const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-3).join(" ");
    throw new Error(said || (result.error ? result.error.message : `npm pack exited ${String(result.status)}`));
  }
};

/**
 * Fetch the create-app version that made the project, unpacked into a temp
 * folder (the caller removes it with `cleanup`). Uses the project's own
 * .npmrc, so the same registry and token `pnpm install` uses.
 */
export async function fetchPreviousGenerator(
  generator: { readonly name: string; readonly version: string },
  projectDir: string,
  options: { readonly pack?: PackFn } = {},
): Promise<{ readonly dir: string; cleanup(): Promise<void> }> {
  if (!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(generator.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(generator.version)) {
    throw new PreviousGeneratorError(`adminigloo.json names "${generator.name}@${generator.version}", which isn't a package version to fetch.`);
  }
  const work = await mkdtemp(join(tmpdir(), "adminigloo-upgrade-"));
  const cleanup = () => rm(work, { recursive: true, force: true });
  try {
    const spec = `${generator.name}@${generator.version}`;
    try {
      await (options.pack ?? npmPack)(spec, work, projectDir);
    } catch (error) {
      throw new PreviousGeneratorError(
        `Couldn't fetch ${spec}, the version that made this project, to see which files you changed ` +
          `(${error instanceof Error ? error.message : String(error)}). Check GITHUB_TOKEN can read the packages, ` +
          `or fetch it yourself (npm pack ${spec}), unpack it, and run upgrade again with --from <that folder>.`,
      );
    }
    const tarball = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new PreviousGeneratorError(`npm pack ${spec} wrote no tarball.`);
    const dir = join(work, "generator");
    await extractTarGz(await readFile(join(work, tarball)), dir);
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Unpack an npm tarball (gzip + ustar, with the PAX and GNU long-name records
 * npm writes for paths over 100 characters) into `dest`, dropping the
 * leading `package/`. Small and dependency-free on purpose: create-app ships
 * with no dependencies. Refuses a path that would land outside `dest`.
 */
export async function extractTarGz(gz: Uint8Array, dest: string): Promise<readonly string[]> {
  const buf = gunzipSync(gz);
  const root = resolve(dest);
  const written: string[] = [];
  let offset = 0;
  let longName: string | null = null;
  const text = (from: number, length: number) => {
    const bytes = buf.subarray(from, from + length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
  };
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(offset + 345, 155);
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // PAX: "<len> key=value\n" records; only the path matters here.
      const records = new TextDecoder().decode(data);
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records);
      longName = path?.[1] ?? longName;
      continue;
    }
    if (type === "L") {
      longName = text(dataStart, size);
      continue;
    }
    if (type === "g") continue;
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type !== "0" && type !== "\0" && type !== "5") continue; // links and devices: never in a create-app tarball
    const rel = full.replace(/^package\//, "").replace(/\/+$/, "");
    if (rel === "" || rel === "package") continue;
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) throw new PreviousGeneratorError(`The tarball has a path outside its folder: ${full}`);
    if (type === "5") {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written.push(rel);
  }
  return written;
}

/**
 * SWITCHING AN ANSWER (create-app 0.39): `upgrade --audience consumers`, or
 * `upgrade --set <answer>=<value>` for any structural answer — the tenant
 * noun, the audience, the business model, the admin shell, or a feature on or
 * off. The project is re-planned with the new answer and brought to it by the
 * same three-way as a version upgrade: new files written, files you never
 * changed rewritten, files the new answer doesn't have deleted (when you never
 * changed them), and `<file>.new` beside every file you did change. On a
 * project nobody edited the result is byte for byte a fresh generation with
 * the new answers — but for src/plans.ts, which a switch never rewrites (the
 * new sample goes beside it as src/plans.ts.new: its tiers are the ones
 * people pay for). A switch that drops tables, changes what an account is or
 * stops a plan check needs --allow-data-loss.
 */
export type AnswerOverrides = Partial<Omit<Answers, "projectName" | "scope">>;

export class AnswerSwitchError extends Error {
  readonly name = "AnswerSwitchError";
}

/**
 * An upgrade that would drop tables, change what an account is (companies or
 * one person each) or stop a plan check, given without `--allow-data-loss`
 * (review). Thrown before anything is written; the message lists every loss.
 */
export class UpgradeLosesDataError extends Error {
  readonly name = "UpgradeLosesDataError";
  constructor(
    message: string,
    readonly losses: UpgradeLosses,
  ) {
    super(message);
  }
}

/** The answers `--set` may change, and how each one's value is read. */
const SWITCHABLE: Readonly<Record<string, readonly string[] | "boolean">> = {
  tenantNoun: TENANT_NOUNS,
  audience: AUDIENCES,
  businessModel: BUSINESS_MODELS,
  adminShell: ADMIN_SHELLS,
  ...Object.fromEntries(
    Object.keys(DEFAULT_ANSWERS)
      .filter((key) => key.startsWith("include"))
      .map((key) => [key, "boolean" as const]),
  ),
};

/** The flag spellings people type, for the answer keys (`--model` is `businessModel`). */
const ALIASES: Readonly<Record<string, string>> = {
  "tenant-noun": "tenantNoun",
  noun: "tenantNoun",
  model: "businessModel",
  "business-model": "businessModel",
  admin: "adminShell",
  "admin-shell": "adminShell",
};

/**
 * One `--set key=value` (or `--audience value`), checked: the key must be a
 * structural answer and the value one that answer takes. `include*` keys also
 * take the feature's flag name (`--set feedback=true`).
 */
export function parseAnswerOverride(assignment: string): AnswerOverrides {
  const at = assignment.indexOf("=");
  if (at <= 0) throw new AnswerSwitchError(`--set wants <answer>=<value>, like --set audience=consumers; got "${assignment}".`);
  const rawKey = assignment.slice(0, at).trim();
  const value = assignment.slice(at + 1).trim();
  if (rawKey === "projectName" || rawKey === "scope") {
    throw new AnswerSwitchError(`${rawKey} can't be switched by upgrade: it names the project's packages and folder. Generate a new project for that.`);
  }
  const camel = ALIASES[rawKey] ?? rawKey;
  const key =
    SWITCHABLE[camel] !== undefined
      ? camel
      : SWITCHABLE[`include${camel.charAt(0).toUpperCase()}${camel.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`] !== undefined
        ? `include${camel.charAt(0).toUpperCase()}${camel.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`
        : null;
  if (key === null) {
    throw new AnswerSwitchError(
      `"${rawKey}" isn't an answer upgrade can switch. One of: ${Object.keys(SWITCHABLE).join(", ")}.`,
    );
  }
  const allowed = SWITCHABLE[key];
  if (allowed === "boolean") {
    if (value !== "true" && value !== "false") throw new AnswerSwitchError(`--set ${key} takes true or false; got "${value}".`);
    return { [key]: value === "true" } as AnswerOverrides;
  }
  if (allowed === undefined || !allowed.includes(value)) {
    throw new AnswerSwitchError(`--set ${key} takes one of: ${(allowed ?? []).join(", ")}; got "${value}".`);
  }
  return { [key]: value } as AnswerOverrides;
}

/** Which answers the overrides really change, as [key, from, to]. */
export function switchedAnswers(before: Answers, after: Answers): readonly (readonly [key: string, from: string, to: string])[] {
  const out: [string, string, string][] = [];
  for (const key of Object.keys(after) as (keyof Answers)[]) {
    if (before[key] !== after[key]) out.push([key, String(before[key]), String(after[key])]);
  }
  return out;
}

/** What `upgrade` will do, file by file. Writes nothing. */
export interface UpgradePlan {
  readonly projectDir: string;
  readonly answers: Answers;
  /** The answers the project had before this upgrade (adminigloo.json's). */
  readonly storedAnswers: Answers;
  /** Answers switched by this upgrade (`--audience`, `--set`), as [key, from, to]. Empty for a version upgrade alone. */
  readonly switched: readonly (readonly [key: string, from: string, to: string])[];
  /** The version that made the project, and this one. */
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Nothing to do: the project is this version's already. */
  readonly upToDate: boolean;
  readonly creates: ReadonlyMap<string, string>;
  readonly rewrites: ReadonlyMap<string, string>;
  /** Changed by you AND by this version: written as `<file>.new`. */
  readonly conflicts: ReadonlyMap<string, string>;
  /** No longer part of the project, and exactly as the old version wrote them. */
  readonly deletes: ReadonlySet<string>;
  /** No longer part of the project, but changed by you: left, and listed. */
  readonly keptRetired: ReadonlySet<string>;
  readonly packageJson: string | null;
  readonly raised: readonly RaisedPin[];
  readonly newRequiredEnv: readonly string[];
  readonly newFeatureEnv: readonly string[];
  readonly newOptionalEnv: readonly string[];
  /** What this version changes that a person has to act on (the notes for the versions crossed). */
  readonly notes: readonly string[];
  /**
   * What the upgrade loses — tables `pnpm db:generate` will DROP, accounts
   * that change kind, plan checks that stop (review). Only ever non-empty when
   * `--allow-data-loss` let it go ahead; without it, planning refuses.
   */
  readonly losses: UpgradeLosses;
}

/** Generated records, always rewritten; and the one file never written. */
const ALWAYS_REWRITE = new Set([MANIFEST_FILENAME, "SCAFFOLD.md"]);
const NEVER_WRITE = new Set([".env.local"]);

/**
 * THE PLAN RECORD IS THE OWNER'S ON A SWITCH (review): src/plans.ts holds the
 * tiers people are subscribed to and the prices they pay. A switch writes a
 * different sample (the consumer one has other tiers), and rewriting an
 * untouched copy dropped tiers with live subscribers on them — whose next
 * Stripe event then failed, every time, because the tier was gone. So a switch
 * never rewrites it: the new sample goes beside it as src/plans.ts.new.
 */
const PLAN_RECORD = join("src", "plans.ts");

/**
 * Plan the upgrade. `previous` is the create-app that made the project
 * (`loadPreviousGenerator`); it must be that version.
 */
export async function planUpgrade(
  templateDir: string,
  projectDir: string,
  options: {
    readonly previous: PreviousGenerator | null;
    readonly overrides?: AnswerOverrides;
    /**
     * `--allow-data-loss`: go ahead with an upgrade that drops tables,
     * changes what an account is, or stops a plan check. Without it, any of
     * those is refused before anything is written (UpgradeLosesDataError).
     */
    readonly allowDataLoss?: boolean;
  },
): Promise<UpgradePlan> {
  const manifest = await readProjectManifest(projectDir);
  const stored = answersFor(manifest);
  // The answers switched by this upgrade (create-app 0.39), refused here, in
  // plain words, when the combination can't be generated.
  const answers: Answers = { ...stored, ...(options.overrides ?? {}) };
  const switched = switchedAnswers(stored, answers);
  if (switched.length > 0) {
    // A COMPANIES PROJECT ASKED FOR CONSUMERS (review). The generator's own
    // refusal says "use it with --tenant-noun none", which is right for a new
    // project and wrong here: on this one, that switch ends every company.
    if (answers.audience === "consumers" && answers.tenantNoun !== "none") {
      throw new IncompatibleAnswersError(companiesAreNotConsumers(answers));
    }
    assertAnswersCompatible(answers);
  }
  const toVersion = await currentGeneratorVersion(templateDir);
  const fromVersion = manifest.generator.version;
  const empty = {
    projectDir,
    answers,
    storedAnswers: stored,
    switched,
    fromVersion,
    toVersion,
    creates: new Map<string, string>(),
    rewrites: new Map<string, string>(),
    conflicts: new Map<string, string>(),
    deletes: new Set<string>(),
    keptRetired: new Set<string>(),
    packageJson: null,
    raised: [] as RaisedPin[],
    newRequiredEnv: [] as string[],
    newFeatureEnv: [] as string[],
    newOptionalEnv: [] as string[],
    notes: [] as string[],
    losses: NO_LOSSES,
  };
  const behind = projectIsBehind(manifest, toVersion);
  if (!behind && switched.length === 0) return { ...empty, upToDate: true };
  // What was written: by the version that made the project when it's behind;
  // by THIS version, with the old answers, when only an answer is switching.
  let oldFiles: ReadonlyMap<string, string>;
  if (behind) {
    const previous = options.previous;
    if (!previous) throw new PreviousGeneratorError(`To upgrade from create-app ${fromVersion}, that version is needed to compare with.`);
    if (previous.version !== fromVersion) throw new UpgradeVersionMismatchError(fromVersion, previous.version);
    oldFiles = await previous.plan(projectDir, manifest.answers);
  } else {
    oldFiles = (await planEmit(templateDir, projectDir, stored)).files;
  }
  const newFiles = (await planEmit(templateDir, projectDir, answers)).files;

  // WHAT IT LOSES (review), before a single file is planned: tables the next
  // `pnpm db:generate` would DROP, accounts that change kind, plan checks that
  // stop. Refused unless --allow-data-loss says so — and listed either way.
  const losses = upgradeLosses({
    stored,
    answers,
    oldSchema: oldFiles.get(SCHEMA_MODULE_PATH),
    newSchema: newFiles.get(SCHEMA_MODULE_PATH),
  });
  if (losesAnything(losses) && options.allowDataLoss !== true) {
    throw new UpgradeLosesDataError(lossRefusal(stored, answers, losses, switched.length > 0 && !behind), losses);
  }

  const creates = new Map<string, string>();
  const rewrites = new Map<string, string>();
  const conflicts = new Map<string, string>();
  const deletes = new Set<string>();
  const keptRetired = new Set<string>();
  let packageJson: string | null = null;
  let raised: readonly RaisedPin[] = [];

  // Every "is this still what the generator wrote?" below is `sameText`, never
  // `===`: a project kept in git comes back from `git checkout` with LF where
  // an older create-app wrote CRLF, and that is not an edit (review).
  for (const [relPath, next] of newFiles) {
    if (NEVER_WRITE.has(relPath)) continue;
    const before = oldFiles.get(relPath);
    if (relPath === "package.json") {
      const merged = await mergePackageJson(projectDir, before ?? "{}", next, answers.scope);
      raised = merged.raised;
      const onDisk = await readIfExists(join(projectDir, relPath));
      if (!sameText(onDisk, merged.text)) packageJson = merged.text;
      continue;
    }
    const onDisk = await readIfExists(join(projectDir, relPath));
    if (sameText(onDisk, next)) continue;
    if (ALWAYS_REWRITE.has(relPath)) {
      rewrites.set(relPath, next);
      continue;
    }
    if (before === undefined) {
      // New in this version.
      if (onDisk === null) creates.set(relPath, next);
      else conflicts.set(relPath, next); // something of yours is at that path
      continue;
    }
    // Unchanged by this version: whatever is on disk (your edit, or a file
    // you deleted on purpose) is yours.
    if (sameText(before, next)) continue;
    // The plan record on a switch: yours, always (see PLAN_RECORD).
    if (relPath === PLAN_RECORD && switched.length > 0 && onDisk !== null) {
      conflicts.set(relPath, next);
      continue;
    }
    if (onDisk === null || sameText(onDisk, before)) rewrites.set(relPath, next);
    else conflicts.set(relPath, next);
  }

  for (const [relPath, before] of oldFiles) {
    if (newFiles.has(relPath) || NEVER_WRITE.has(relPath)) continue;
    const onDisk = await readIfExists(join(projectDir, relPath));
    if (onDisk === null) continue;
    if (sameText(onDisk, before)) deletes.add(relPath);
    else keptRetired.add(relPath);
  }

  const oldRequired = new Set(manifest.env.required);
  const oldOptional = new Set(manifest.env.optional);
  const deferred = deferredUntilDeployedFor(answers);
  const required = requiredEnvFor(answers).filter((v) => !oldRequired.has(v));
  return {
    ...empty,
    upToDate: false,
    creates,
    rewrites,
    conflicts,
    deletes,
    keptRetired,
    packageJson,
    raised,
    newRequiredEnv: required.filter((v) => deferred.includes(v)),
    newFeatureEnv: required.filter((v) => !deferred.includes(v)),
    newOptionalEnv: optionalEnvFor(answers).filter((v) => !oldOptional.has(v)),
    // The version's notes and the switch's, each said once (a note both give —
    // one person per account — is the same sentence).
    notes: [
      ...new Set([
        ...(behind ? upgradeNotesFor(answers, fromVersion) : []),
        ...switchNotesFor(stored, answers),
        ...(switched.length > 0 && conflicts.has(PLAN_RECORD) ? [planRecordSwitchNote(answers)] : []),
      ]),
    ],
    losses,
  };
}

/** Why a companies project isn't switched to consumers (review: never pointing at a tenantNoun switch). */
function companiesAreNotConsumers(answers: Answers): string {
  const plural = tenantLabelPlural(answers).toLowerCase();
  return (
    `--audience consumers is for a project whose customers sign up as themselves, with no ${plural}. This project's customers are ` +
    `${plural}: each person works inside one, and it pays for its own plan. upgrade won't turn ` +
    `that into a project where every account is one person's — the ${plural}, their members and their plans would all be left ` +
    "behind. Leave --audience out to keep it as it is: a product for people is a new project, generated with " +
    "--audience consumers and no companies."
  );
}

/** Write the plan: creates and rewrites in place, conflicts as `.new`, deletes (and the folders they empty). */
export async function applyUpgrade(plan: UpgradePlan): Promise<void> {
  for (const [relPath, contents] of plan.creates) await writeInto(plan.projectDir, relPath, contents);
  for (const [relPath, contents] of plan.rewrites) await writeInto(plan.projectDir, relPath, contents);
  for (const [relPath, contents] of plan.conflicts) await writeInto(plan.projectDir, `${relPath}.new`, contents);
  if (plan.packageJson !== null) await writeInto(plan.projectDir, "package.json", plan.packageJson);
  const root = resolve(plan.projectDir);
  for (const relPath of plan.deletes) {
    const full = resolve(root, relPath);
    await unlink(full);
    // The folders it leaves empty go too (app/api/files/, once its route is gone).
    for (let dir = dirname(full); dir.startsWith(root + sep); dir = dirname(dir)) {
      if ((await readdir(dir)).length > 0) break;
      await rmdir(dir);
    }
  }
}

/** What the person has to do next, and why — `add`'s voice. */
export function upgradeNextSteps(plan: UpgradePlan): string {
  if (plan.upToDate) {
    return `\n${plan.projectDir} is already create-app ${plan.toVersion}'s. Nothing to upgrade.\n`;
  }
  const lines: string[] = [
    "",
    plan.fromVersion === plan.toVersion
      ? `Switched ${plan.projectDir} (create-app ${plan.toVersion})`
      : `Upgraded ${plan.projectDir} from create-app ${plan.fromVersion} to ${plan.toVersion}`,
    "",
  ];
  if (plan.switched.length > 0) {
    lines.push("Answers switched (adminigloo.json records them):");
    for (const [key, from, to] of plan.switched) lines.push(`  ${key}: ${from} -> ${to}`);
    lines.push("");
  }
  // WHAT IT LOSES, first and in full (review): only ever here because
  // --allow-data-loss let it go ahead.
  if (losesAnything(plan.losses)) {
    lines.push("WHAT THIS UPGRADE LOSES (you allowed it with --allow-data-loss):", "");
    for (const line of describeLosses(plan.storedAnswers, plan.answers, plan.losses)) lines.push(...wrap(`- ${line}`, "  "));
    lines.push("");
  }
  const list = (title: string, paths: Iterable<string>, show: (path: string) => string = (path) => path) => {
    const sorted = [...paths].sort();
    if (sorted.length === 0) return;
    lines.push(title);
    for (const path of sorted) lines.push(`  ${show(path)}`);
    lines.push("");
  };
  list("New files:", plan.creates.keys());
  list("Brought up to date (you hadn't changed them):", plan.rewrites.keys());
  list("Removed (this version doesn't use them, and you hadn't changed them):", plan.deletes);
  if (plan.raised.length > 0) {
    lines.push("Package versions raised in package.json:");
    for (const [name, from, to] of plan.raised) lines.push(`  ${name}  ${from} -> ${to}`);
    lines.push("");
  } else if (plan.packageJson !== null) {
    lines.push("package.json brought up to date.", "");
  }
  if (plan.conflicts.size > 0 || plan.keptRetired.size > 0) {
    lines.push("WHAT STILL NEEDS A HAND EDIT (and only this):", "");
  }
  list(
    "  You had changed these, so the new version was written beside each as\n  <file>.new. Fold your change into it, then replace the file with it:",
    plan.conflicts.keys(),
    (path) => `  ${path}.new  ->  ${path}`,
  );
  // Kept is not dead (review): a page or route left here is still served at
  // its address, whether or not it builds against the new packages.
  const servesSomething = [...plan.keptRetired].some((path) => /(^|[\\/])(page|route)\.tsx?$/.test(path));
  list(
    servesSomething
      ? "  This version no longer uses these, but you had changed them, so they were\n  left — and a page among them is still served at its address until you\n  delete it (it may also no longer build). Move your change, then delete each:"
      : "  This version no longer uses these, but you had changed them, so they were\n  left (they may no longer build against the new packages). Move your change,\n  then delete each:",
    plan.keptRetired,
    (path) => `  ${path}`,
  );
  // In a project that just became one person per account, a kept team page is
  // worse than dead code: it still offers an invite form.
  const keptTeamPages = consumerProduct(plan.answers)
    ? [...plan.keptRetired].filter((path) => PERSONAL_ACCOUNT_RETIRED.some((retired) => join(...retired.split("/")) === path) && path.endsWith("page.tsx"))
    : [];
  if (keptTeamPages.length > 0) {
    lines.push(
      ...indented(
        `Delete ${keptTeamPages.join(" and ")} now: ${keptTeamPages.length === 1 ? "it is" : "they are"} still served (the team page ` +
          "with its invite form), and in this project nobody may invite anyone — every invitation is refused on the server, so " +
          `${keptTeamPages.length === 1 ? "it" : "they"} can only show people an error.`,
        "  ",
      ),
      "",
    );
  }
  if (plan.conflicts.size > 0 || plan.keptRetired.size > 0) {
    lines.push("  And any file of your own that imports one of the removed files.", "");
  }
  // NEVER `db:generate && db:migrate` (review): the migration is read before
  // it runs, and one that drops tables says so here, by name.
  const dropped = droppedTableNames(plan.losses);
  lines.push(
    "Then:",
    "  pnpm install",
    // A rewritten .npmrc can change how pnpm names its folders
    // (virtual-store-dir-max-length), and pnpm then asks once to rebuild
    // node_modules — a question nobody should meet unwarned.
    ...(plan.rewrites.has(".npmrc") ? ["    (it may ask once to remove and reinstall node_modules: .npmrc changed how", "    pnpm names its folders. Answer yes.)"] : []),
    "  pnpm db:generate",
    ...(dropped.length > 0
      ? indented(
          `It writes a migration that DROPS ${dropped.length} table${dropped.length === 1 ? "" : "s"}, with every row in ` +
            `${dropped.length === 1 ? "it" : "them"}: ${dropped.join(", ")}. Export anything you want to keep first — ` +
            "once `pnpm db:migrate` has run, it is gone.",
          "    ",
        )
      : [
          "    Read the migration it writes (the newest file in drizzle/) before you",
          "    apply it. This upgrade drops no table, so it should only add; if it",
          "    drops anything, stop there and find out why.",
        ]),
    dropped.length > 0 ? "  pnpm db:migrate        only once you have" : "  pnpm db:migrate        once you have read it",
    "  pnpm db:seed",
    "  pnpm exec tsc --noEmit && pnpm test",
    "",
  );
  if (plan.notes.length > 0) {
    lines.push("What this version changes that you act on:");
    for (const note of plan.notes) lines.push(...wrap(`- ${note}`, "  "));
    lines.push("");
  }
  if (plan.newRequiredEnv.length > 0) {
    lines.push("A deployment refuses to start without these — set them in Vercel (both scopes):");
    for (const v of plan.newRequiredEnv) lines.push(`  ${v}`);
    lines.push("");
  }
  if (plan.newFeatureEnv.length > 0) {
    lines.push("Each of these switches a feature on (it stays off, and says so, until set):");
    for (const v of plan.newFeatureEnv) lines.push(`  ${v}`);
    lines.push("");
  }
  if (plan.newOptionalEnv.length > 0) {
    lines.push("New, optional (.env.local was not touched; /setup says what each does):");
    for (const v of plan.newOptionalEnv) lines.push(`  ${v}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Wrap a paragraph at 78 columns, every line indented (the first one too). */
function indented(text: string, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line !== "" && line.length + word.length + 1 > 78) {
      out.push(line);
      line = `${indent}${word}`;
    } else {
      line = line === "" ? `${indent}${word}` : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** Wrap a paragraph at 78 columns, continuation lines indented. */
function wrap(text: string, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line !== "" && line.length + word.length + 1 > 78) {
      out.push(line);
      line = `${indent}${word}`;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

