import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, overlayNamesFor } from "../answers.js";
import { parseArgs, collectAnswers } from "../cli.js";
import { assertTargetUsable, planEmit, writePlan } from "../emit.js";
import type { Prompter } from "../prompt.js";
import {
  EVERY_CONFIGURATION,
  TEMPLATE_DIR,
  type Configuration,
} from "./configurations.js";

/**
 * THE GENERATOR CAN PRODUCE EVERY CONFIGURATION — asserted on every commit
 * rather than left as a property that happens to hold.
 *
 * A verifier once watched a twenty-five minute window in which NO project with
 * an admin panel could be generated at all. `CAPABILITY_EVIDENCE` named
 * `overlays/admin-minimal/app/admin/page.tsx` while that file was mid-move, so
 * `planEmit` threw `UnprovableCapabilityError` and the CLI exited 1 for every
 * `--admin minimal` and `--admin full` answer there is. It resolved itself when
 * the move finished, which is the worst way for a fault like that to end: no
 * commit records it, and nothing stops the next one.
 *
 * WHAT WAS ALREADY THERE, and it is more than the incident suggested.
 * `capabilities.test.ts` sweeps a large subset of the answer space through
 * `planEmit`, and it would have been red throughout that window. This file does
 * not replace it. It closes the three things that sweep does not cover.
 *
 *   1. It is EXHAUSTIVE, and exhaustive by construction. The subset over there
 *      fixes `tenantNoun` at two of its five values and is a literal array, so
 *      a sixth noun or a fifth business model reaches it only if somebody
 *      remembers to add it. This one is the cartesian product of the tuples
 *      `cli.ts` validates flags against, so a new option value is swept the
 *      moment it exists.
 *
 *   2. It goes through the CLI. `planEmit` is a function; `create-adminigloo-app
 *      --yes --model both --admin full` is the product. Between them sit flag
 *      parsing and `collectAnswers`, and a configuration the flags cannot
 *      express is one nobody can generate however well the emitter handles it.
 *
 *   3. It WRITES. Everything above stops at a plan held in memory. `writePlan`
 *      and `assertTargetUsable` are the parts that touch a disk, and a plan
 *      that cannot be written is not a generated project.
 *
 * ONE FAILURE LIST, not one failing test per configuration. Two hundred and
 * forty `it`s would report whichever failed first and bury the shape of the
 * fault; a missing overlay file breaks every configuration that selects it, and
 * exactly which ones those are is the diagnosis.
 */

/** A prompter that refuses to be asked. Every answer must come from the flags. */
const refuseToPrompt: Prompter = {
  text: (question: string) => {
    throw new Error(`prompted for "${question}" in a fully-flagged run`);
  },
  select: (question: string) => {
    throw new Error(`prompted for "${question}" in a fully-flagged run`);
  },
  confirm: (question: string) => {
    throw new Error(`prompted for "${question}" in a fully-flagged run`);
  },
  close: () => {},
};

/**
 * Files no configuration may omit.
 *
 * The four that would make the emitted directory something other than a
 * project: nothing to install, no record of what produced it, nothing to
 * typecheck against, and no page to serve. An overlay-specific file has no
 * business in this list — proving those is what the capability evidence table
 * is for.
 */
const ALWAYS = [
  "package.json",
  "adminigloo.json",
  "tsconfig.json",
  join("app", "(site)", "page.tsx"),
] as const;

describe("the generator can produce every configuration", () => {
  it("plans, and the plan is a project", async () => {
    const problems: string[] = [];

    for (const config of EVERY_CONFIGURATION) {
      let plan;
      try {
        plan = await planEmit(TEMPLATE_DIR, "/out", config.answers);
      } catch (error) {
        problems.push(
          `${config.label}\n    generation FAILED: ` +
            `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
        continue;
      }

      for (const required of ALWAYS) {
        if (!plan.files.has(required)) {
          problems.push(`${config.label}\n    emitted no ${required}`);
        }
      }

      // The manifest is the project's own account of itself, and every
      // downstream job reads it rather than re-deriving the flags. A
      // configuration whose manifest disagrees with the functions that produced
      // it is one where the matrix would check the wrong thing and pass.
      const manifest: unknown = JSON.parse(plan.files.get("adminigloo.json") ?? "null");
      const claimed = (manifest as { capabilities?: unknown }).capabilities;
      if (!Array.isArray(claimed)) {
        problems.push(`${config.label}\n    adminigloo.json has no capabilities array`);
      } else if (claimed.join("|") !== capabilitiesFor(config.answers).join("|")) {
        problems.push(
          `${config.label}\n    adminigloo.json claims [${claimed.join(", ")}] and ` +
            `capabilitiesFor says [${capabilitiesFor(config.answers).join(", ")}]`,
        );
      }

      // THE DATABASE HANDLE IS BUILT FROM AN OBJECT, NEVER FROM THE MODULE
      // NAMESPACE. Drizzle calls `Object.keys` on whatever `createDb` is given,
      // and under Turbopack a module whose exports are all re-exports —
      // `src/db/schema.ts` exactly — compiles to a namespace backed by a Proxy
      // over a non-extensible target, which throws on that call. It throws only
      // once a real DATABASE_URL makes drizzle build the relational API rather
      // than the unconfigured stand-in, so it is invisible to every check that
      // does not point a generated project at a database: this cost a project
      // that built and served perfectly with none, and failed `next build`
      // outright with one.
      const dbModule = plan.files.get(join("src", "db", "index.ts")) ?? "";
      const schemaModule = plan.files.get(join("src", "db", "schema.ts")) ?? "";
      if (dbModule.includes("import * as schema")) {
        problems.push(
          `${config.label}\n    src/db/index.ts imports the schema module's ` +
            `NAMESPACE. Drizzle will call Object.keys on it and throw.`,
        );
      }
      if (!schemaModule.includes("export const schema = {")) {
        problems.push(
          `${config.label}\n    src/db/schema.ts exports no plain \`schema\` ` +
            `object for createDb to be given.`,
        );
      }

      const overlays = (manifest as { overlays?: unknown }).overlays;
      if (
        !Array.isArray(overlays) ||
        overlays.join("|") !== overlayNamesFor(config.answers).join("|")
      ) {
        problems.push(
          `${config.label}\n    adminigloo.json overlays [${String(overlays)}] do not ` +
            `match overlayNamesFor [${overlayNamesFor(config.answers).join(", ")}]`,
        );
      }
    }

    expect(
      problems,
      `${problems.length} of ${EVERY_CONFIGURATION.length} configurations cannot be ` +
        `generated. Each entry starts with the exact flags that reproduce it:\n\n` +
        `${problems.join("\n")}\n`,
    ).toEqual([]);
  });

  it("is reachable through the flags, with nothing left to a prompt", async () => {
    const problems: string[] = [];

    for (const config of EVERY_CONFIGURATION) {
      try {
        const flags = parseArgs(["acme", "--yes", ...config.flags]);
        const answers = await collectAnswers(flags, refuseToPrompt);
        if (JSON.stringify(answers) !== JSON.stringify(config.answers)) {
          problems.push(
            `${config.label}\n    parsed to ${JSON.stringify(answers)}\n` +
              `    expected  ${JSON.stringify(config.answers)}`,
          );
        }
      } catch (error) {
        problems.push(
          `${config.label}\n    ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
});

/**
 * The disk half, on two configurations rather than all of them.
 *
 * Writing 240 projects is minutes of I/O to re-prove one thing — that
 * `writePlan` puts the bytes of a plan onto a disk — and that does not vary
 * with the answers. What varies is the plan, and the plan is covered
 * exhaustively above. So this takes the corners: the emptiest project the
 * generator can produce, and the fullest.
 */
describe("and can write one", () => {
  const corner = (predicate: (c: Configuration) => boolean): Configuration => {
    const found = EVERY_CONFIGURATION.find(predicate);
    if (found === undefined) throw new Error("no configuration matched");
    return found;
  };

  const corners = [
    corner(
      (c) =>
        c.answers.businessModel === "none" &&
        c.answers.adminShell === "none" &&
        !c.answers.includeAi &&
        !c.answers.includeEmail,
    ),
    corner(
      (c) =>
        c.answers.businessModel === "both" &&
        c.answers.adminShell === "full" &&
        c.answers.includeAi &&
        c.answers.includeEmail,
    ),
  ] as const;

  it.each(corners.map((c) => [c.label, c] as const))(
    "writes every planned file for %s",
    async (_label, config) => {
      const dir = await mkdtemp(join(tmpdir(), "adminigloo-emit-"));
      try {
        const target = join(dir, config.answers.projectName);
        await assertTargetUsable(target);
        const plan = await planEmit(TEMPLATE_DIR, target, config.answers);
        await writePlan(plan);

        // Two reads rather than an existence check over all of them. What this
        // step can get wrong is a path whose directory component was never
        // created, and `app/(site)/page.tsx` is the deepest one every project
        // has. The manifest is read back PARSED, because a truncated write is
        // still a file.
        const page = await readFile(join(target, "app", "(site)", "page.tsx"), "utf8");
        expect(page.length).toBeGreaterThan(0);
        const manifest: unknown = JSON.parse(
          await readFile(join(target, "adminigloo.json"), "utf8"),
        );
        expect((manifest as { answers?: { projectName?: unknown } }).answers?.projectName).toBe(
          config.answers.projectName,
        );

        // Generating into it a second time must refuse, rather than merge two
        // projects into one directory.
        await expect(assertTargetUsable(target)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
