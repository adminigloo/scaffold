import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { applyAdd, FeatureAlreadyPresentError, planAdd, ProjectBehindError, projectIsBehind } from "../add.js";
import { planEmit, writePlan } from "../emit.js";
import { buildManifest, MANIFEST_FILENAME, renderManifest, type ProjectManifest } from "../manifest.js";
import {
  applyUpgrade,
  extractTarGz,
  fetchPreviousGenerator,
  loadPreviousGenerator,
  npmCommand,
  planUpgrade,
  PreviousGeneratorError,
  runNpm,
  upgradeNextSteps,
  UpgradeVersionMismatchError,
} from "../upgrade.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * `upgrade` (review BUY-01): a project an OLDER create-app made, brought up
 * to this one. Tested the way `add` is — against a real directory, to the one
 * standard that matters: on a project nobody edited, the result is exactly
 * what generating fresh with this version gives; and an edit is never lost.
 *
 * The "older create-app" is a stand-in package (a dist/index.js whose
 * planEmit answers a fixed plan): this version's plan with the differences a
 * real release has — a file that changed, files this version retired, a file
 * it adds, lower package ranges and a dependency it dropped. The real 2a
 * generator is run the same way by hand (the integrator's upgrade check).
 */

const ANSWERS: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "green-acres-platform",
  tenantNoun: "Company",
  adminShell: "full",
  businessModel: "none",
  includeEmail: true,
  includeComms: true,
  includeScheduling: true,
  includeEstimator: true,
  includeInvoicing: true,
  includeNotifications: true,
  includeStorage: true,
  includeAi: false,
};

const OLD_VERSION = "0.22.0";
const sepPath = (path: string) => join(...path.split("/"));

let project: string;
let previousDir: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "adminigloo-upgrade-project-"));
  previousDir = await mkdtemp(join(tmpdir(), "adminigloo-upgrade-previous-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
});

/** This version's plan for the answers. */
async function currentFiles(): Promise<Map<string, string>> {
  return new Map((await planEmit(TEMPLATE_DIR, project, ANSWERS)).files);
}

/**
 * What the "older" create-app wrote: this version's plan, with an older
 * alerts module, two files this version retired, one file it adds missing,
 * lower ranges, a dependency it dropped, and its own manifest.
 */
async function oldFiles(): Promise<Map<string, string>> {
  const files = await currentFiles();
  files.set(sepPath("src/server/alerts.ts"), "// the old version's alerts\nexport const OLD = true;\n");
  files.set(sepPath("src/env.ts"), "// the old version's env\nexport const env = {};\n");
  files.set(sepPath("src/server/old-inbox.ts"), "export const OLD_INBOX = true;\n");
  files.set(sepPath("src/server/old-blob-store.ts"), "export const OLD_STORE = true;\n");
  files.delete(sepPath("src/server/files-routes.ts"));
  // The old .npmrc: the registry lines only, before pnpm's folder names were shortened.
  files.set(".npmrc", `${(files.get(".npmrc") ?? "").split("\n").slice(0, 2).join("\n")}\n`);
  const pkg = JSON.parse(files.get("package.json") ?? "{}") as { dependencies: Record<string, string> };
  pkg.dependencies["@adminigloo/tenancy"] = "^0.5.0";
  pkg.dependencies["@adminigloo/notifications"] = "^0.1.0";
  delete pkg.dependencies["@adminigloo/notifications-widget"];
  pkg.dependencies["@adminigloo/retired-thing"] = "^0.1.0";
  files.set("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  const manifest = buildManifest(ANSWERS, OLD_VERSION);
  files.set(
    MANIFEST_FILENAME,
    renderManifest({
      ...manifest,
      packages: { ...manifest.packages, "@adminigloo/tenancy": "^0.5.0", "@adminigloo/notifications": "^0.1.0" },
      env: { ...manifest.env, optional: manifest.env.optional.filter((name) => name !== "FILES_LINK_SECRET") },
    }),
  );
  return files;
}

/** The stand-in older create-app: a package folder whose planEmit answers `files`. */
async function writePreviousGenerator(dir: string, files: ReadonlyMap<string, string>, version = OLD_VERSION): Promise<void> {
  await mkdir(join(dir, "dist"), { recursive: true });
  await mkdir(join(dir, "template"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@adminigloo/create-app", version }), "utf8");
  await writeFile(join(dir, "dist", "plan.json"), JSON.stringify(Object.fromEntries(files)), "utf8");
  await writeFile(
    join(dir, "dist", "index.js"),
    [
      'import { readFileSync } from "node:fs";',
      "export async function planEmit(_templateDir, _targetDir, _answers) {",
      '  const files = JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8"));',
      "  return { files: new Map(Object.entries(files)) };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Write a plan's files into the project, as that generator would have. */
async function writeFiles(files: ReadonlyMap<string, string>): Promise<void> {
  for (const [relPath, contents] of files) {
    const full = join(project, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

async function onDisk(path: string): Promise<string | null> {
  const full = join(project, sepPath(path));
  return existsSync(full) ? readFile(full, "utf8") : null;
}

describe("create-adminigloo-app upgrade", () => {
  it("leaves an untouched project exactly as generating fresh with this version would (.env.local excepted)", async () => {
    const old = await oldFiles();
    await writeFiles(old);
    await writePreviousGenerator(previousDir, old);

    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) });
    await applyUpgrade(plan);

    expect(plan.upToDate).toBe(false);
    expect(plan.fromVersion).toBe(OLD_VERSION);
    expect([...plan.conflicts.keys()]).toEqual([]);
    expect([...plan.keptRetired]).toEqual([]);
    const mismatches: string[] = [];
    for (const [relPath, want] of await currentFiles()) {
      if (relPath === ".env.local") continue;
      const got = await onDisk(relPath.split(/[\\/]/).join("/"));
      if (got !== want) mismatches.push(`${relPath}: ${got === null ? "missing" : "differs"}`);
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    // The retired files are gone, and .env.local is the old one, untouched.
    expect(await onDisk("src/server/old-inbox.ts")).toBeNull();
    expect(await onDisk("src/server/old-blob-store.ts")).toBeNull();
    expect(await onDisk(".env.local")).toBe(old.get(".env.local") ?? null);
  });

  it("never loses an edit: a changed file gets <file>.new, a changed retired file is kept and listed, your package.json additions stay", async () => {
    const old = await oldFiles();
    await writeFiles(old);
    await writePreviousGenerator(previousDir, old);
    // The buyer's own work.
    const editedEnv = `${old.get(sepPath("src/env.ts"))}// my own variable\n`;
    await writeFile(join(project, sepPath("src/env.ts")), editedEnv, "utf8");
    const editedRetired = "export const OLD_STORE = true;\n// my change to the old store\n";
    await writeFile(join(project, sepPath("src/server/old-blob-store.ts")), editedRetired, "utf8");
    const pkg = JSON.parse((await onDisk("package.json")) ?? "{}") as { scripts: Record<string, string>; dependencies: Record<string, string> };
    pkg.scripts["mine"] = "echo mine";
    pkg.dependencies["left-pad"] = "^1.3.0";
    await writeFile(join(project, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) });
    await applyUpgrade(plan);
    const current = await currentFiles();

    // The edited file is the buyer's; the new version is beside it.
    expect(await onDisk("src/env.ts")).toBe(editedEnv);
    expect(await onDisk("src/env.ts.new")).toBe(current.get(sepPath("src/env.ts")));
    // An untouched changed file is brought up to date; a new one is written.
    expect(await onDisk("src/server/alerts.ts")).toBe(current.get(sepPath("src/server/alerts.ts")));
    expect(await onDisk("src/server/files-routes.ts")).toBe(current.get(sepPath("src/server/files-routes.ts")));
    // Retired: the untouched one goes, the edited one stays and is listed.
    expect(await onDisk("src/server/old-inbox.ts")).toBeNull();
    expect(await onDisk("src/server/old-blob-store.ts")).toBe(editedRetired);
    expect([...plan.keptRetired].map((path) => path.split(/[\\/]/).join("/"))).toEqual(["src/server/old-blob-store.ts"]);

    // package.json: raised, added, dropped — and the buyer's own kept.
    const after = JSON.parse((await onDisk("package.json")) ?? "{}") as { scripts: Record<string, string>; dependencies: Record<string, string> };
    const want = JSON.parse(current.get("package.json") ?? "{}") as { dependencies: Record<string, string> };
    expect(after.dependencies["@adminigloo/tenancy"]).toBe(want.dependencies["@adminigloo/tenancy"]);
    expect(after.dependencies["@adminigloo/notifications"]).toBe(want.dependencies["@adminigloo/notifications"]);
    expect(after.dependencies["@adminigloo/notifications-widget"]).toBe(want.dependencies["@adminigloo/notifications-widget"]);
    expect(after.dependencies["@adminigloo/retired-thing"]).toBeUndefined();
    expect(after.dependencies["left-pad"]).toBe("^1.3.0");
    expect(after.scripts["mine"]).toBe("echo mine");
    expect(plan.raised).toContainEqual(["@adminigloo/tenancy", "^0.5.0", want.dependencies["@adminigloo/tenancy"]]);

    // The manifest says this version now, and the new variable is listed.
    expect(await onDisk(MANIFEST_FILENAME)).toBe(current.get(MANIFEST_FILENAME));
    expect(plan.newOptionalEnv).toContain("FILES_LINK_SECRET");

    // And the person is told exactly what's left, and what the release asks.
    const steps = upgradeNextSteps(plan);
    expect(steps).toContain(`Upgraded ${project} from create-app ${OLD_VERSION}`);
    expect(steps).toContain("WHAT STILL NEEDS A HAND EDIT");
    expect(steps).toContain(`${sepPath("src/env.ts")}.new  ->  ${sepPath("src/env.ts")}`);
    expect(steps).toContain(sepPath("src/server/old-blob-store.ts"));
    expect(steps).toContain("@adminigloo/tenancy  ^0.5.0 -> ");
    expect(steps).toContain("pnpm db:generate && pnpm db:migrate && pnpm db:seed");
    // The rewritten .npmrc makes pnpm ask once to rebuild node_modules: said beforehand.
    expect(plan.rewrites.has(".npmrc")).toBe(true);
    expect(steps).toContain("it may ask once to remove and reinstall node_modules");
    const words = steps.replace(/\s+/g, " ");
    expect(words).toContain("connect a SECOND Blob store with access Private");
    expect(words).toContain("update stored_files set tenant_id = '<company id>' where tenant_id = '*';");
  });

  it("says a project this version made is up to date, and fetches nothing", async () => {
    await writePlan(await planEmit(TEMPLATE_DIR, project, ANSWERS));
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null });
    expect(plan.upToDate).toBe(true);
    expect(upgradeNextSteps(plan)).toContain("Nothing to upgrade.");
  });

  it("refuses to compare with a create-app other than the one that made the project", async () => {
    const old = await oldFiles();
    await writeFiles(old);
    await writePreviousGenerator(previousDir, old, "0.21.0");
    await expect(planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) })).rejects.toBeInstanceOf(
      UpgradeVersionMismatchError,
    );
  });

  it("refuses a folder that isn't a create-app", async () => {
    await expect(loadPreviousGenerator(previousDir)).rejects.toBeInstanceOf(PreviousGeneratorError);
  });
});

describe("add, on a project an older create-app made (review BUY-01)", () => {
  it("refuses, and names upgrade then add — never a project that installs and doesn't build", async () => {
    const old = await oldFiles();
    // The same project without alerts, so `add notifications` has something to add.
    const without = { ...ANSWERS, includeNotifications: false };
    const manifest = buildManifest(without, OLD_VERSION);
    old.set(MANIFEST_FILENAME, renderManifest({ ...manifest, packages: { ...manifest.packages, "@adminigloo/tenancy": "^0.5.0" } }));
    await writeFiles(old);
    const refused = planAdd(TEMPLATE_DIR, project, "notifications");
    await expect(refused).rejects.toBeInstanceOf(ProjectBehindError);
    await expect(refused).rejects.toThrow(/upgrade\n {2}pnpm dlx @adminigloo\/create-app@[^ ]+ add notifications/);
  });

  it("an EARLIER BUILD of this version (the same number, other package ranges) is behind too: add refuses, and says so", async () => {
    // What this version writes for a project without alerts, so `add notifications` has something to add…
    const without = { ...ANSWERS, includeNotifications: false };
    await writePlan(await planEmit(TEMPLATE_DIR, project, without));
    const path = join(project, MANIFEST_FILENAME);
    const written = JSON.parse(await readFile(path, "utf8")) as ProjectManifest;
    const version = written.generator.version;
    // …which is up to date as written: the same number, the same ranges.
    expect(projectIsBehind(written, version)).toBe(false);

    // An unreleased build of the same number recorded an older range: no
    // version comparison can see it, only the ranges can (review BUY-01).
    const earlier: ProjectManifest = { ...written, packages: { ...written.packages, "@adminigloo/tenancy": "^0.5.0" } };
    expect(earlier.generator.version).toBe(version);
    expect(projectIsBehind(earlier, version)).toBe(true);
    await writeFile(path, renderManifest(earlier), "utf8");
    const refused = planAdd(TEMPLATE_DIR, project, "notifications");
    await expect(refused).rejects.toBeInstanceOf(ProjectBehindError);
    await expect(refused).rejects.toThrow(`This project was made by an earlier build of create-app ${version}, and this is create-app ${version}.`);
    await expect(refused).rejects.toThrow(/upgrade\n {2}pnpm dlx @adminigloo\/create-app@[^ ]+ add notifications/);
  });

  it("an already-present feature on an older project points at upgrade instead of 'Nothing to add'", async () => {
    await writeFiles(await oldFiles());
    const refused = planAdd(TEMPLATE_DIR, project, "storage");
    await expect(refused).rejects.toBeInstanceOf(FeatureAlreadyPresentError);
    await expect(refused).rejects.toThrow(/run:\n\n {2}pnpm dlx @adminigloo\/create-app@[^ ]+ upgrade/);
  });

  it("raises a package range left behind in an edited package.json when it adds a feature", async () => {
    const answers = { ...ANSWERS, includeStorage: false };
    await writePlan(await planEmit(TEMPLATE_DIR, project, answers));
    const pkgPath = join(project, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    const wanted = pkg.dependencies["@adminigloo/tenancy"];
    pkg.dependencies["@adminigloo/tenancy"] = "^0.5.0";
    pkg.scripts["mine"] = "echo mine";
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    await applyAdd(await planAdd(TEMPLATE_DIR, project, "storage"));
    const after = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(after.dependencies["@adminigloo/tenancy"]).toBe(wanted);
    expect(after.dependencies["@adminigloo/storage"]).toBeDefined();
    expect(after.scripts["mine"]).toBe("echo mine");
  });
});

// ---------------------------------------------------------------------------
// Fetching the older create-app: npm's tarball, unpacked without a dependency.
// ---------------------------------------------------------------------------

/** One tar record: a 512-byte ustar header, the data, padding. */
function tarRecord(name: string, data: Uint8Array, type = "0", prefix = ""): Uint8Array[] {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (text: string, offset: number, length: number) => header.set(enc.encode(text).subarray(0, length), offset);
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  header[156] = type.charCodeAt(0);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return [header, data, new Uint8Array((512 - (data.length % 512)) % 512)];
}

/** A PAX record naming `path` (how npm writes a path over 100 characters). */
function paxRecord(path: string): Uint8Array[] {
  const body = (length: number) => `${length} path=${path}\n`;
  let length = body(0).length;
  while (body(length).length !== length) length = body(length).length;
  return tarRecord("PaxHeader", new TextEncoder().encode(body(length)), "x");
}

function tgz(records: Uint8Array[][]): Uint8Array {
  const parts = [...records.flat(), new Uint8Array(1024)];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return gzipSync(out);
}

describe("the older create-app, fetched and unpacked", () => {
  it("unpacks npm's tarball: short names, ustar prefixes and PAX long paths, without the package/ folder", async () => {
    const long = `package/overlays/${"scheduling-companies/".repeat(4)}app/(site)/app/schedule/visits/[id]/files/page.tsx`;
    expect(long.length).toBeGreaterThan(100);
    const bytes = tgz([
      tarRecord("package/package.json", new TextEncoder().encode('{"version":"0.22.0"}')),
      tarRecord("dist/index.js", new TextEncoder().encode("export {};\n"), "0", "package"),
      paxRecord(long),
      tarRecord("package/overlays/long-name-placeholder", new TextEncoder().encode("long one\n")),
    ]);
    const written = await extractTarGz(bytes, previousDir);
    expect(written).toEqual(["package.json", "dist/index.js", long.replace(/^package\//, "")]);
    expect(await readFile(join(previousDir, "dist", "index.js"), "utf8")).toBe("export {};\n");
    expect(await readFile(join(previousDir, ...long.replace(/^package\//, "").split("/")), "utf8")).toBe("long one\n");
  });

  it("refuses a path that would land outside its folder", async () => {
    const bytes = tgz([tarRecord("package/../../escaped.txt", new TextEncoder().encode("no"))]);
    await expect(extractTarGz(bytes, previousDir)).rejects.toBeInstanceOf(PreviousGeneratorError);
  });

  it("fetches the version named in adminigloo.json, loads its planEmit, and cleans up after", async () => {
    const source = await mkdtemp(join(tmpdir(), "adminigloo-upgrade-source-"));
    try {
      await writePreviousGenerator(source, new Map([["README.md", "old\n"]]));
      const records: Uint8Array[][] = [];
      for (const rel of ["package.json", "dist/index.js", "dist/plan.json"]) {
        records.push(tarRecord(`package/${rel}`, await readFile(join(source, ...rel.split("/")))));
      }
      let asked: { spec: string; cwd: string } | null = null;
      const fetched = await fetchPreviousGenerator({ name: "@adminigloo/create-app", version: OLD_VERSION }, project, {
        pack: async (spec, dest, cwd) => {
          asked = { spec, cwd };
          await writeFile(join(dest, "adminigloo-create-app-0.22.0.tgz"), tgz(records));
        },
      });
      expect(asked).toEqual({ spec: `@adminigloo/create-app@${OLD_VERSION}`, cwd: project });
      const loaded = await loadPreviousGenerator(fetched.dir);
      expect(loaded.version).toBe(OLD_VERSION);
      expect([...(await loaded.plan(project, ANSWERS)).keys()]).toEqual(["README.md"]);
      await fetched.cleanup();
      expect(existsSync(fetched.dir)).toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("says what to do when the fetch fails, and leaves nothing behind", async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("adminigloo-upgrade-")).length;
    await expect(
      fetchPreviousGenerator({ name: "@adminigloo/create-app", version: OLD_VERSION }, project, {
        pack: async () => {
          throw new Error("401 Unauthorized");
        },
      }),
    ).rejects.toThrow(/--from <that folder>/);
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("adminigloo-upgrade-")).length;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Starting npm: one command line for cmd on Windows, no shell elsewhere.
// ---------------------------------------------------------------------------

describe("starting npm pack, on Windows and everywhere else (no DEP0190 in the buyer's terminal)", () => {
  const spec = "@adminigloo/create-app@0.22.0";
  const dest = "C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\adminigloo-upgrade-a1B2c3";

  it("on Windows: ONE quoted command line for cmd, and no argument list beside it", () => {
    const npm = npmCommand(["pack", spec, "--pack-destination", dest, "--silent"], "win32");
    expect(npm).toEqual({
      command: `npm "pack" "${spec}" "--pack-destination" "${dest}" "--silent"`,
      args: [],
      shell: true,
    });
  });

  it("elsewhere: npm itself, the arguments as a list, and no shell to read them", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(npmCommand(["pack", spec, "--pack-destination", "/tmp/adminigloo-upgrade-a1B2c3", "--silent"], platform)).toEqual({
        command: "npm",
        args: ["pack", spec, "--pack-destination", "/tmp/adminigloo-upgrade-a1B2c3", "--silent"],
        shell: false,
      });
    }
  });

  it("never hands a shell an argument list, on any platform: that is exactly what Node 24 warns about (DEP0190)", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const npm = npmCommand(["pack", spec, "--pack-destination", dest, "--silent"], platform);
      if (npm.shell) expect(npm.args, platform).toEqual([]);
    }
  });

  it("refuses, on Windows, what cmd would read even inside quotes: a quote, a %, a line break", () => {
    for (const bad of ['C:\\Temp\\a"b', "C:\\Temp\\50%off", "C:\\Temp\\a\nb"]) {
      expect(() => npmCommand(["pack", spec, "--pack-destination", bad], "win32"), JSON.stringify(bad)).toThrow(/cmd/);
    }
    // The same folder is fine where no shell reads it.
    expect(npmCommand(["pack", spec, "--pack-destination", "/tmp/50%off"], "linux").args).toContain("/tmp/50%off");
  });

  it("runs npm for real on this machine, and Node prints no DEP0190", () => {
    const warned: unknown[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    try {
      const result = runNpm(["--version"], { cwd: tmpdir() });
      expect(result.status, `${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(warned)).not.toContain("DEP0190");
  });
});
