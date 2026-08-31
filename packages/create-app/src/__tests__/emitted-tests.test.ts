import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { planEmit } from "../emit.js";
import { EVERY_CONFIGURATION, TEMPLATE_DIR } from "./configurations.js";
import generatorConfig from "../../vitest.config.js";
import generatedProjectConfig from "../../template/vitest.config.js";

/**
 * EVERY TEST FILE THIS PACKAGE SHIPS RUNS IN SOME PIPELINE.
 *
 * This is the guard for the defect underneath the other defects. Two
 * integration tests contradicted the code they were testing from the day they
 * were committed, and the reason nobody noticed is not that they were subtle:
 * they executed nowhere. `pnpm -r test` skips `template/` and `overlays/`
 * because to this package they are DATA — text it renders — so their
 * `.test.ts` files ran only if somebody generated a project and ran its suite,
 * and no pipeline did. A test that runs in no pipeline is a comment with
 * assertions in it, and it rots at exactly the rate of a comment.
 *
 * TWO PLACES A SHIPPED TEST CAN RUN, and a file has to reach at least one:
 *
 *   in a GENERATED PROJECT   its emitted path is matched by an include glob in
 *                            `template/vitest.config.ts`, so `pnpm test` there
 *                            collects it. This is where the tests that need a
 *                            rendered `_app.ts`, a `@/db` or a Stripe key run,
 *                            and it is why CI now runs that suite.
 *
 *   in THIS package          its source path is matched by an include glob of
 *                            one of the projects in `vitest.config.ts`, which
 *                            run overlay modules against workspace source. A
 *                            laptop-speed loop that cannot cover everything;
 *                            the comments there say which and why.
 *
 * BOTH SETS OF GLOBS ARE READ FROM THE REAL CONFIGS, never restated here. A
 * copy of the include patterns would go on agreeing with itself after somebody
 * narrowed the originals, which is the exact failure this file exists to make
 * impossible.
 *
 * It also insists the file is EMITTED at all. A test under `overlays/` that no
 * configuration copies into a project runs nowhere for a second, quieter
 * reason — and the maximal configuration selects every overlay there is, so one
 * plan answers that for the whole tree.
 */

/** Every `*.test.ts` under `dir`, as paths relative to it, `/`-separated. */
async function testFilesUnder(dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".test.ts")) {
        found.push(relative(dir, full).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  return found.sort();
}

/**
 * A glob as a regular expression, for the handful of forms these configs use.
 *
 * Deliberately narrow and deliberately LOUD about anything it does not
 * understand. A permissive matcher that quietly treated `{a,b}` as literal text
 * would answer "no file matches this include", and this suite would then report
 * a test as running nowhere when it runs perfectly well — or, far worse, the
 * other way round.
 */
function globToRegExp(glob: string): RegExp {
  if (/[?{}[\]!()]/.test(glob)) {
    throw new Error(
      `globToRegExp does not understand "${glob}". It handles literal ` +
        `segments, "*" and "**" and nothing else, because that is all the two ` +
        `configs use. Teach it the new syntax rather than loosening it.`,
    );
  }
  // Split KEEPING the wildcards, so each token is either a wildcard to
  // translate or literal text to escape. A chain of `.replace` calls would let
  // a later pass re-read the regex an earlier one had just written.
  let body = "";
  for (const token of glob.split(/(\*\*\/|\*\*|\*)/)) {
    if (token === "**/") body += "(?:.*/)?";
    else if (token === "**") body += ".*";
    else if (token === "*") body += "[^/]*";
    else body += token.replace(/[.+^$\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`);
}

interface VitestProject {
  readonly test?: {
    readonly name?: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

/** The inline projects of a vitest config, with their include/exclude globs. */
function projectsOf(config: unknown, which: string): readonly VitestProject[] {
  const projects = (config as { test?: { projects?: unknown } }).test?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(`${which} declares no test.projects — has its shape changed?`);
  }
  return projects as readonly VitestProject[];
}

/** Does some project both include and not exclude this path? */
function runsUnder(projects: readonly VitestProject[], path: string): boolean {
  return projects.some((project) => {
    const include = project.test?.include ?? [];
    const exclude = project.test?.exclude ?? [];
    if (!include.some((glob) => globToRegExp(glob).test(path))) return false;
    return !exclude.some((glob) => globToRegExp(glob).test(path));
  });
}

/** The maximal configuration selects every overlay, so its plan holds them all. */
const MAXIMAL = EVERY_CONFIGURATION.find(
  (c) =>
    c.answers.businessModel === "both" &&
    c.answers.adminShell === "full" &&
    c.answers.includeAi &&
    c.answers.includeEmail,
);

interface ShippedTest {
  /** Where it lives in this repository. */
  readonly source: string;
  /**
   * Where it lands in a generated project. Overlays are copied with their path
   * relative to the overlay directory and the base with its path relative to
   * `template/`, so in both cases this is that same relative path — and if that
   * ever stops being true, the emitted-path lookup below fails rather than
   * silently passing.
   */
  readonly emitted: string;
}

describe("every test file this package ships runs somewhere", () => {
  it("is emitted into a generated project and collected by its suite", async () => {
    if (MAXIMAL === undefined) throw new Error("no maximal configuration");
    const plan = await planEmit(TEMPLATE_DIR, "/out", MAXIMAL.answers);
    const emitted = new Set(
      [...plan.files.keys()].map((path) => path.split(/[\\/]/).join("/")),
    );

    const generated = projectsOf(generatedProjectConfig, "template/vitest.config.ts");
    const own = projectsOf(generatorConfig, "vitest.config.ts");

    const overlaysRoot = join(TEMPLATE_DIR, "..", "overlays");
    const shipped: ShippedTest[] = [];
    for (const path of await testFilesUnder(TEMPLATE_DIR)) {
      shipped.push({ source: `template/${path}`, emitted: path });
    }
    for (const overlay of await readdir(overlaysRoot)) {
      for (const path of await testFilesUnder(join(overlaysRoot, overlay))) {
        shipped.push({ source: `overlays/${overlay}/${path}`, emitted: path });
      }
    }
    expect(
      shipped.length,
      "no test files found under template/ or overlays/ — has the layout moved?",
    ).toBeGreaterThan(0);

    const orphans: string[] = [];
    for (const file of shipped) {
      const alsoHere = runsUnder(own, file.source);

      if (!emitted.has(file.emitted)) {
        // Not shipped by the maximal configuration, which selects every
        // overlay. Acceptable only if this package runs it itself; otherwise it
        // is a file nothing executes and nothing installs.
        if (!alsoHere) {
          orphans.push(
            `${file.source}\n    no configuration emits it and no project in ` +
              `vitest.config.ts includes it. It runs nowhere.`,
          );
        }
        continue;
      }

      if (!runsUnder(generated, file.emitted) && !alsoHere) {
        orphans.push(
          `${file.source}\n    emitted to ${file.emitted}, which no include glob in ` +
            `template/vitest.config.ts matches, and no project in vitest.config.ts ` +
            `runs it either. A generated project ships it and never executes it.`,
        );
      }
    }

    expect(
      orphans,
      `These test files run in no pipeline. That is how two integration tests ` +
        `contradicted the shipped code for a whole release:\n\n${orphans.join("\n")}\n`,
    ).toEqual([]);
  });

  it("has no vitest project pointed at nothing", async () => {
    // The other direction, and the one that rots silently: an overlay is
    // renamed or a suite deleted, the project entry stays behind, and the run
    // reports a cheerful green pass over zero files. Vitest does not object.
    const packageRoot = join(TEMPLATE_DIR, "..");
    const everything = (await testFilesUnder(packageRoot)).filter(
      (path) => path.startsWith("template/") || path.startsWith("overlays/"),
    );

    const dead: string[] = [];
    for (const project of projectsOf(generatorConfig, "vitest.config.ts")) {
      // The generator project declares no `include` — it takes vitest's default
      // and is scoped by `exclude` instead, so there is nothing to point at
      // nothing.
      for (const glob of project.test?.include ?? []) {
        if (!everything.some((path) => globToRegExp(glob).test(path))) {
          dead.push(
            `project "${project.test?.name ?? "?"}" includes "${glob}", which matches ` +
              `no file. Either the suite moved or the entry is left over.`,
          );
        }
      }
    }

    expect(dead, `\n${dead.join("\n")}\n`).toEqual([]);
  });
});
