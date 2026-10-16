import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { deferredUntilDeployedFor, optionalEnvFor, requiredEnvFor, type Answers } from "./answers.js";
import {
  answersFor,
  currentGeneratorVersion,
  mergePackageJson,
  projectIsBehind,
  readIfExists,
  readProjectManifest,
  writeInto,
  type RaisedPin,
} from "./add.js";
import { planEmit } from "./emit.js";
import { MANIFEST_FILENAME } from "./manifest.js";
import { upgradeNotesFor } from "./upgrade-notes.js";

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
 * The invariant, as `add`'s: on a project nobody edited, `upgrade` leaves
 * byte for byte what generating fresh with this version would (`.env.local`
 * excepted). The suite holds it to that.
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

/** What `upgrade` will do, file by file. Writes nothing. */
export interface UpgradePlan {
  readonly projectDir: string;
  readonly answers: Answers;
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
}

/** Generated records, always rewritten; and the one file never written. */
const ALWAYS_REWRITE = new Set([MANIFEST_FILENAME, "SCAFFOLD.md"]);
const NEVER_WRITE = new Set([".env.local"]);

/**
 * Plan the upgrade. `previous` is the create-app that made the project
 * (`loadPreviousGenerator`); it must be that version.
 */
export async function planUpgrade(
  templateDir: string,
  projectDir: string,
  options: { readonly previous: PreviousGenerator | null },
): Promise<UpgradePlan> {
  const manifest = await readProjectManifest(projectDir);
  const answers = answersFor(manifest);
  const toVersion = await currentGeneratorVersion(templateDir);
  const fromVersion = manifest.generator.version;
  const empty = {
    projectDir,
    answers,
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
  };
  if (!projectIsBehind(manifest, toVersion)) return { ...empty, upToDate: true };
  const previous = options.previous;
  if (!previous) throw new PreviousGeneratorError(`To upgrade from create-app ${fromVersion}, that version is needed to compare with.`);
  if (previous.version !== fromVersion) throw new UpgradeVersionMismatchError(fromVersion, previous.version);

  const oldFiles = await previous.plan(projectDir, manifest.answers);
  const newFiles = (await planEmit(templateDir, projectDir, answers)).files;

  const creates = new Map<string, string>();
  const rewrites = new Map<string, string>();
  const conflicts = new Map<string, string>();
  const deletes = new Set<string>();
  const keptRetired = new Set<string>();
  let packageJson: string | null = null;
  let raised: readonly RaisedPin[] = [];

  for (const [relPath, next] of newFiles) {
    if (NEVER_WRITE.has(relPath)) continue;
    const before = oldFiles.get(relPath);
    if (relPath === "package.json") {
      const merged = await mergePackageJson(projectDir, before ?? "{}", next, answers.scope);
      raised = merged.raised;
      const onDisk = await readIfExists(join(projectDir, relPath));
      if (merged.text !== onDisk) packageJson = merged.text;
      continue;
    }
    const onDisk = await readIfExists(join(projectDir, relPath));
    if (onDisk === next) continue;
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
    if (before === next) continue;
    if (onDisk === null || onDisk === before) rewrites.set(relPath, next);
    else conflicts.set(relPath, next);
  }

  for (const [relPath, before] of oldFiles) {
    if (newFiles.has(relPath) || NEVER_WRITE.has(relPath)) continue;
    const onDisk = await readIfExists(join(projectDir, relPath));
    if (onDisk === null) continue;
    if (onDisk === before) deletes.add(relPath);
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
    notes: upgradeNotesFor(answers, fromVersion),
  };
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
  const lines: string[] = ["", `Upgraded ${plan.projectDir} from create-app ${plan.fromVersion} to ${plan.toVersion}`, ""];
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
  list(
    "  This version no longer uses these, but you had changed them, so they were\n  left. They won't build against the new packages: move your change, then\n  delete each:",
    plan.keptRetired,
    (path) => `  ${path}`,
  );
  if (plan.conflicts.size > 0 || plan.keptRetired.size > 0) {
    lines.push("  And any file of your own that imports one of the removed files.", "");
  }
  lines.push(
    "Then:",
    "  pnpm install",
    // A rewritten .npmrc can change how pnpm names its folders
    // (virtual-store-dir-max-length), and pnpm then asks once to rebuild
    // node_modules — a question nobody should meet unwarned.
    ...(plan.rewrites.has(".npmrc") ? ["    (it may ask once to remove and reinstall node_modules: .npmrc changed how", "    pnpm names its folders. Answer yes.)"] : []),
    "  pnpm db:generate && pnpm db:migrate && pnpm db:seed",
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

