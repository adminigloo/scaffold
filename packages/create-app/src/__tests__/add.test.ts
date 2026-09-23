import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, writePlan } from "../emit.js";
import {
  ADDABLE_FEATURES,
  addNextSteps,
  applyAdd,
  FeatureAlreadyPresentError,
  ManifestUnreadableError,
  planAdd,
  UnknownFeatureError,
  type FeatureName,
} from "../add.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * `add` is a diff of two generator plans applied to a real directory, so it is
 * tested against a real directory: generate a project, add a feature, and hold
 * the result to the one standard that matters — that it is indistinguishable
 * from having generated the project with that feature on in the first place.
 */

// A project with room to grow: an admin shell (so features with a staff page
// have somewhere to hang it) and none of the addable features on.
const BASE: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "warehouse-app",
  adminShell: "full",
  businessModel: "both",
  includeAi: false,
  includeEmail: false,
  includeFeedback: false,
  includeSeoReports: false,
  includeNotifications: false,
  includeStorage: false,
  includeAssistant: false,
  includeMarketing: false,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "adminigloo-add-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function generate(answers: Answers): Promise<void> {
  await writePlan(await planEmit(TEMPLATE_DIR, dir, answers));
}

/** Every file the generator would write for `answers`, EXCEPT .env.local —
 * which holds secrets and `add` is forbidden from rewriting. */
async function projectFiles(answers: Answers): Promise<Map<string, string>> {
  const plan = await planEmit(TEMPLATE_DIR, dir, answers);
  const files = new Map(plan.files);
  files.delete(".env.local");
  return files;
}

describe("create-adminigloo-app add <feature>", () => {
  // THE INVARIANT. For each feature, adding it to an untouched project must
  // leave the exact bytes generating with it on would have — proof that the
  // router mount, the schema registration, the env fragment, the admin nav and
  // the package pin are ALL replayed, not just the overlay's own files.
  for (const feature of ADDABLE_FEATURES) {
    it(`adds ${feature} exactly as generating with it would`, async () => {
      await generate(BASE);

      const plan = await planAdd(TEMPLATE_DIR, dir, feature);
      await applyAdd(plan);

      const key = ({
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
      } as const)[feature];
      const expected = await projectFiles({ ...BASE, [key]: true });

      const mismatches: string[] = [];
      for (const [relPath, want] of expected) {
        const path = join(dir, relPath);
        if (!existsSync(path)) {
          mismatches.push(`${relPath}: missing after add`);
          continue;
        }
        const got = await readFile(path, "utf8");
        if (got !== want) mismatches.push(`${relPath}: content differs`);
      }
      expect(
        mismatches,
        `add ${feature} did not reproduce a generated-with-${feature} project:\n` +
          mismatches.join("\n"),
      ).toEqual([]);
      // And it left no .new files behind on a clean project — every change was
      // safe to apply in place.
      expect([...plan.conflicts.keys()]).toEqual([]);
    });
  }

  it("mounts the router and registers the schema for a feature with both", async () => {
    await generate(BASE);
    await applyAdd(await planAdd(TEMPLATE_DIR, dir, "notifications"));

    const appRouter = await readFile(
      join(dir, "src", "server", "routers", "_app.ts"),
      "utf8",
    );
    expect(appRouter).toContain("notificationsRouter");

    const schema = await readFile(join(dir, "src", "db", "schema.ts"), "utf8");
    expect(schema).toMatch(/notifications/);
  });

  it("adds the feature's package to package.json", async () => {
    await generate(BASE);
    await applyAdd(await planAdd(TEMPLATE_DIR, dir, "storage"));
    const pkg = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@adminigloo/storage"]).toBeDefined();
  });

  // NEVER CLOBBER AN EDIT. A base file the feature must change, once edited, is
  // preserved and the new version lands beside it as .new.
  it("writes <file>.new instead of overwriting a file you edited", async () => {
    await generate(BASE);
    const routerPath = join(dir, "src", "server", "routers", "_app.ts");
    const edited = `${await readFile(routerPath, "utf8")}\n// my own comment\n`;
    await writeFile(routerPath, edited, "utf8");

    const plan = await planAdd(TEMPLATE_DIR, dir, "notifications");
    await applyAdd(plan);

    // The edit survives untouched...
    expect(await readFile(routerPath, "utf8")).toBe(edited);
    // ...and the wired version is offered for merge.
    expect(plan.conflicts.has(join("src", "server", "routers", "_app.ts"))).toBe(true);
    const dotNew = await readFile(`${routerPath}.new`, "utf8");
    expect(dotNew).toContain("notificationsRouter");
  });

  // MERGE, don't overwrite, package.json — you own your scripts and deps.
  it("keeps your package.json edits and adds only the new dependency", async () => {
    await generate(BASE);
    const pkgPath = join(dir, "package.json");
    const current = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
    (current["scripts"] as Record<string, string>)["mine"] = "echo hi";
    await writeFile(pkgPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    await applyAdd(await planAdd(TEMPLATE_DIR, dir, "storage"));

    const after = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(after.scripts?.["mine"]).toBe("echo hi");
    expect(after.dependencies?.["@adminigloo/storage"]).toBeDefined();
  });

  it("reports the migration step only when the schema changed", async () => {
    await generate(BASE);
    const withTables = await planAdd(TEMPLATE_DIR, dir, "notifications");
    expect(addNextSteps(withTables)).toContain("db:migrate");
  });

  it("refuses an unknown feature", async () => {
    await generate(BASE);
    await expect(
      planAdd(TEMPLATE_DIR, dir, "telepathy" as FeatureName),
    ).rejects.toBeInstanceOf(UnknownFeatureError);
  });

  it("refuses a feature the project already has", async () => {
    await generate({ ...BASE, includeStorage: true });
    await expect(planAdd(TEMPLATE_DIR, dir, "storage")).rejects.toBeInstanceOf(
      FeatureAlreadyPresentError,
    );
  });

  it("refuses a directory that is not a generated project", async () => {
    await expect(planAdd(TEMPLATE_DIR, dir, "storage")).rejects.toBeInstanceOf(
      ManifestUnreadableError,
    );
  });
});
