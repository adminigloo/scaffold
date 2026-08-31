import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  DEFAULT_ANSWERS,
  InvalidProjectNameError,
  isPersonalWorkspaceOnly,
  optionalEnvFor,
  overlayNamesFor,
  packagesFor,
  requiredEnvFor,
  tenantLabel,
  tenantLabelPlural,
  validateProjectName,
  type Answers,
} from "../answers.js";
import {
  buildManifest,
  MANIFEST_FILENAME,
  renderManifest,
} from "../manifest.js";
import {
  collectAnswers,
  nextSteps,
  parseArgs,
  targetDirFor,
  UnknownFlagValueError,
} from "../cli.js";
import { defaultsOnlyPrompter } from "../prompt.js";
import {
  assertTargetUsable,
  type EmitPlan,
  planEmit,
  renderAdminDashboard,
  renderEnvExample,
  renderPackageJson,
  renderScaffoldRecord,
  renderEnvModule,
  renderHomePage,
  renderPermissionsCatalog,
  renderSchemaModule,
  renderSiteNav,
  renderTokens,
  targetNameFor,
  TargetNotEmptyError,
  writePlan,
} from "../emit.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

describe("validateProjectName", () => {
  it.each(["acme", "acme-app", "acme_app", "a", "acme.io", "app2"])(
    "accepts %s",
    (name) => {
      expect(validateProjectName(name)).toBe(name);
    },
  );

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(validateProjectName("  acme  ")).toBe("acme");
  });

  it.each([
    ["", "empty"],
    ["Acme", "uppercase is legal in a folder and illegal in a package name"],
    [".acme", "leading dot makes a hidden directory"],
    ["_acme", "leading underscore"],
    ["my app", "space"],
    ["my/app", "slash would nest"],
    ["a".repeat(215), "npm caps at 214"],
  ])("rejects %j — %s", (name) => {
    expect(() => validateProjectName(name)).toThrow(InvalidProjectNameError);
  });

  it("says what is wrong, not just that something is", () => {
    expect(() => validateProjectName("Acme")).toThrow(/lowercase/);
  });
});

describe("packagesFor — the only structural branch", () => {
  it("always installs the base", () => {
    const base = packagesFor(answers());
    for (const name of ["env", "db", "auth", "tenancy", "permissions", "trpc"]) {
      expect(base).toContain(`@adminigloo/${name}`);
    }
  });

  it("depends only on packages that are actually published", async () => {
    // A generated project whose very first `pnpm install` 404s is worse than
    // one missing a feature. Keep this list in step with the registry.
    const PUBLISHED = new Set([
      "@adminigloo/env",
      "@adminigloo/db",
      "@adminigloo/auth",
      "@adminigloo/tenancy",
      "@adminigloo/permissions",
      "@adminigloo/trpc",
      "@adminigloo/observability",
      "@adminigloo/stripe",
      "@adminigloo/catalog",
      "@adminigloo/commerce",
      "@adminigloo/billing",
      "@adminigloo/ai",
      "@adminigloo/email",
    ]);
    for (const model of ["none", "one-time", "subscription", "both"] as const) {
      for (const pkg of packagesFor(answers({ businessModel: model }))) {
        expect(PUBLISHED.has(pkg), `${pkg} is not published yet`).toBe(true);
      }
    }
  });

  it("installs no payment package when the project takes no money", () => {
    const none = packagesFor(answers({ businessModel: "none" }));
    expect(none).not.toContain("@adminigloo/stripe");
    expect(none).not.toContain("@adminigloo/commerce");
    expect(none).not.toContain("@adminigloo/billing");
  });

  it("adds stripe for every money-taking model", () => {
    for (const model of ["one-time", "subscription", "both"] as const) {
      expect(packagesFor(answers({ businessModel: model }))).toContain(
        "@adminigloo/stripe",
      );
    }
  });

  it("installs the whole money stack together, for every paying model", () => {
    // Splitting these by business model generated projects that could not
    // resolve their own imports: fulfilPurchase writes an order (commerce),
    // grants an entitlement (billing), reads a price from a variant (catalog)
    // and charges through stripe — on BOTH paths.
    for (const model of ["one-time", "subscription", "both"] as const) {
      const p = packagesFor(answers({ businessModel: model }));
      for (const pkg of ["stripe", "catalog", "commerce", "billing"]) {
        expect(p, `${model} is missing ${pkg}`).toContain(`@adminigloo/${pkg}`);
      }
    }
  });

  it("installs none of it when the project takes no money", () => {
    const p = packagesFor(answers({ businessModel: "none" }));
    for (const pkg of ["stripe", "catalog", "commerce", "billing"]) {
      expect(p).not.toContain(`@adminigloo/${pkg}`);
    }
  });

  it("always installs observability — logging and audit are not optional", () => {
    expect(packagesFor(answers())).toContain("@adminigloo/observability");
  });

  it("never lists a package twice", () => {
    const p = packagesFor(answers({ businessModel: "both", includeAi: true, includeEmail: true }));
    expect(new Set(p).size).toBe(p.length);
  });

  it("adds ai and email only when asked", () => {
    expect(packagesFor(answers())).not.toContain("@adminigloo/ai");
    expect(packagesFor(answers({ includeAi: true }))).toContain("@adminigloo/ai");
    expect(packagesFor(answers({ includeEmail: true }))).toContain(
      "@adminigloo/email",
    );
  });
});

describe("requiredEnvFor", () => {
  it("never asks for a key the project has no use for", () => {
    const vars = requiredEnvFor(answers({ businessModel: "none" }));
    expect(vars.some((v) => v.includes("STRIPE"))).toBe(false);
    expect(vars.some((v) => v.includes("RESEND"))).toBe(false);
  });

  it("asks for Stripe once money is involved", () => {
    const vars = requiredEnvFor(answers({ businessModel: "subscription" }));
    expect(vars).toContain("STRIPE_SECRET_KEY");
    expect(vars).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("always needs both database urls — pooled and direct do different jobs", () => {
    const vars = requiredEnvFor(answers());
    expect(vars).toContain("DATABASE_URL");
    expect(vars).toContain("DATABASE_URL_UNPOOLED");
  });
});

describe("tenant labelling", () => {
  it("uses the chosen noun", () => {
    expect(tenantLabel(answers({ tenantNoun: "Company" }))).toBe("Company");
  });

  it("still has a label for a consumer project — tenancy is always on", () => {
    const b2c = answers({ tenantNoun: "none" });
    expect(tenantLabel(b2c)).toBe("Workspace");
    expect(isPersonalWorkspaceOnly(b2c)).toBe(true);
  });

  /**
   * "Companys" was on screen in the admin sidebar, in the /admin/tenants
   * heading, in its empty state and in two permission categories, because the
   * plural was `${label}s`. Every noun the CLI offers is checked here, not just
   * the one that broke: the table is a `Record<TenantNoun, string>`, so this
   * suite and the type checker together are what make a sixth noun impossible
   * to add without deciding its plural.
   */
  it.each([
    ["Organization", "Organizations", "organizations"],
    ["Company", "Companies", "companies"],
    ["Workspace", "Workspaces", "workspaces"],
    ["Team", "Teams", "teams"],
    // A consumer project has no customer-facing noun, and its singular is
    // already "Workspace". Both forms have to agree, or one screen says
    // Workspace and the next says Nones.
    ["none", "Workspaces", "workspaces"],
  ] as const)("pluralises %s as %s", (noun, expected, lowered) => {
    const chosen = answers({ tenantNoun: noun });
    expect(tenantLabelPlural(chosen)).toBe(expected);
    expect(tenantLabelPlural(chosen).toLowerCase()).toBe(lowered);
  });

  it("never produces a plural by adding s to a word ending in y", () => {
    // The specific defect, stated as a rule rather than as one string. A future
    // noun ending in "y" — "Agency", "Charity" — would otherwise reintroduce it
    // in a project nobody has generated yet.
    for (const noun of ["Organization", "Company", "Workspace", "Team", "none"] as const) {
      const chosen = answers({ tenantNoun: noun });
      const naive = `${tenantLabel(chosen)}s`;
      if (tenantLabel(chosen).endsWith("y")) {
        expect(tenantLabelPlural(chosen)).not.toBe(naive);
      }
    }
  });
});

describe("renderTokens", () => {
  it("substitutes every occurrence, not just the first", () => {
    expect(renderTokens("__PROJECT_NAME__ and __PROJECT_NAME__", answers())).toBe(
      "acme and acme",
    );
  });

  it("expands the scope in both forms", () => {
    expect(renderTokens("__SCOPE__/db and __SCOPE_NAME__", answers())).toBe(
      "@adminigloo/db and adminigloo",
    );
  });

  it("pluralises the tenant label for headings", () => {
    expect(
      renderTokens("__TENANT_LABEL_PLURAL__", answers({ tenantNoun: "Company" })),
    ).toBe("Companies");
  });

  it("has a lowercase plural, so template copy never spells one itself", () => {
    // The token exists because the only way to write this before was
    // `__TENANT_LABEL_LOWER__s`, which is the same broken suffix rule hidden in
    // a template file where no test could see it. It produced "No companys yet"
    // on the /admin/tenants empty state.
    expect(
      renderTokens(
        "__TENANT_LABEL_PLURAL_LOWER__",
        answers({ tenantNoun: "Company" }),
      ),
    ).toBe("companies");
  });

  it("leaves unknown tokens alone rather than blanking them", () => {
    expect(renderTokens("__NOT_A_TOKEN__", answers())).toBe("__NOT_A_TOKEN__");
  });
});

describe("targetNameFor", () => {
  it("renames the underscore-prefixed files npm would have stripped", () => {
    expect(targetNameFor("_gitignore")).toBe(".gitignore");
    expect(targetNameFor("_npmrc")).toBe(".npmrc");
  });

  it("renames a leading underscore at every depth", () => {
    expect(targetNameFor(join("_github", "workflows", "ci.yml"))).toBe(
      join(".github", "workflows", "ci.yml"),
    );
  });

  it("does NOT hide a source file that legitimately starts with an underscore", () => {
    // The generator originally renamed every leading underscore, which turned
    // src/server/routers/_app.ts into .app.ts — a hidden file the app then
    // could not import. Caught by generating for real, not by a unit test.
    expect(targetNameFor(join("src", "server", "routers", "_app.ts"))).toBe(
      join("src", "server", "routers", "_app.ts"),
    );
  });

  it("leaves ordinary paths untouched", () => {
    expect(targetNameFor(join("app", "page.tsx"))).toBe(join("app", "page.tsx"));
  });
});

describe("renderPackageJson", () => {
  it("marks the project private so it cannot be published by accident", () => {
    expect(JSON.parse(renderPackageJson(answers())).private).toBe(true);
  });

  it("runs the Stripe listener beside next dev through one supervisor", () => {
    const withMoney = JSON.parse(
      renderPackageJson(answers({ businessModel: "one-time" })),
    );

    // NOT a command line with the port written into it twice. `next dev` with
    // no --port silently moves to 3001 when 3000 is taken, while the listener
    // keeps forwarding to 3000 — Stripe reports every delivery as delivered,
    // nothing arrives, and no order is ever written. `scripts/dev.ts` resolves
    // the port once from NEXT_PUBLIC_APP_URL and tells both halves.
    expect(withMoney.scripts.dev).toBe("tsx scripts/dev.ts");
    expect(withMoney.scripts.dev).not.toContain("3000");

    // `concurrently -k` stopped every process when one exited, so a machine
    // with no Stripe CLI could not start the dev server at all. The supervisor
    // replaces it, and the dependency goes with it.
    expect(withMoney.devDependencies).not.toHaveProperty("concurrently");
  });

  it("gives a money-taking project a separate shop seed it can re-run", () => {
    const withMoney = JSON.parse(
      renderPackageJson(answers({ businessModel: "both" })),
    );
    // THE THING THAT WAS MISSING. With no catalogue, /products is empty,
    // /checkout is unreachable and the simulated purchase cannot be clicked by
    // anybody — so the demo seed has to produce one, and it must be re-runnable
    // on its own once you have bought everything in it.
    expect(withMoney.scripts["db:seed:demo"]).toContain("scripts/seed-shop.ts");
    expect(withMoney.scripts["db:seed:shop"]).toBe(
      "tsx --env-file=.env.local scripts/seed-shop.ts",
    );
  });

  it("has no shop seed in a project that sells nothing", () => {
    const plain = JSON.parse(renderPackageJson(answers()));
    // The script would name a file the stripe overlay never copied in.
    expect(plain.scripts).not.toHaveProperty("db:seed:shop");
    expect(plain.scripts["db:seed:demo"]).not.toContain("seed-shop");
  });

  it("keeps dev simple when there is no Stripe", () => {
    const plain = JSON.parse(renderPackageJson(answers()));
    expect(plain.scripts.dev).toBe("next dev");
    expect(plain.devDependencies).not.toHaveProperty("concurrently");
  });

  it("depends on exactly the packages the answers selected", () => {
    const parsed = JSON.parse(renderPackageJson(answers({ businessModel: "both" })));
    for (const pkg of packagesFor(answers({ businessModel: "both" }))) {
      expect(parsed.dependencies).toHaveProperty(pkg);
    }
  });

  it("is valid JSON ending in a newline", () => {
    const out = renderPackageJson(answers());
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("renderEnvExample", () => {
  it("lists every required variable as an empty assignment", () => {
    const out = renderEnvExample(answers({ businessModel: "subscription" }));
    for (const name of requiredEnvFor(answers({ businessModel: "subscription" }))) {
      expect(out).toContain(`${name}=`);
    }
  });

  it("says plainly that live keys do not belong here", () => {
    expect(renderEnvExample(answers())).toMatch(/TEST-MODE KEYS ONLY/);
  });
});

describe("renderScaffoldRecord", () => {
  const manifest = (overrides: Partial<Answers> = {}) =>
    buildManifest(answers(overrides), "9.9.9");

  it("records every answer, so a later diff has something to diff against", () => {
    const out = renderScaffoldRecord(
      manifest({ businessModel: "both", adminShell: "full" }),
    );
    expect(out).toContain("both");
    expect(out).toContain("full");
    expect(out).toContain("Forked modules");
  });

  it("names the generator version, which is what a later diff needs", () => {
    expect(renderScaffoldRecord(manifest())).toContain("9.9.9");
  });

  it("says nothing the manifest does not", () => {
    // The whole reason this takes a manifest. Every package, overlay and
    // capability it prints has to come from the object it was handed, or the
    // two files can disagree — and this is the one people read.
    const m = manifest({
      businessModel: "both",
      adminShell: "full",
      includeAi: true,
      includeEmail: true,
    });
    const out = renderScaffoldRecord(m);
    for (const name of Object.keys(m.packages)) expect(out).toContain(name);
    for (const overlay of m.overlays) expect(out).toContain(overlay);
    for (const key of m.capabilities) expect(out).toContain(key);
  });

  it("says so plainly when no overlay was applied", () => {
    const out = renderScaffoldRecord(
      manifest({ adminShell: "none", businessModel: "none" }),
    );
    expect(out).toMatch(/this project is the base template only/);
  });

  it("marks the fork list as the one section a person maintains", () => {
    // Deliberately NOT in adminigloo.json: a manifest with one hand-written
    // field can no longer be rebuilt and compared against itself, which is the
    // only reason the manifest is worth having.
    expect(renderScaffoldRecord(manifest())).toMatch(
      /THE ONE SECTION A PERSON MAINTAINS/,
    );
  });
});

describe("adminigloo.json — the project manifest", () => {
  it("is written at the project root", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.has(MANIFEST_FILENAME)).toBe(true);
    expect(MANIFEST_FILENAME).toBe("adminigloo.json");
  });

  it("is valid JSON ending in a newline", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const raw = plan.files.get(MANIFEST_FILENAME) ?? "";
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("tells whoever opens it not to maintain it by hand", async () => {
    // JSON has no comments and this file will be opened by people. A generated
    // file that does not say it is generated is a file somebody edits.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
      "//": string[];
    };
    expect(parsed["//"].join(" ")).toMatch(/GENERATED FILE/);
    expect(parsed["//"].join(" ")).toMatch(/by hand/);
  });

  it("carries the complete answers, so the project can be reproduced", () => {
    const a = answers({
      tenantNoun: "Team",
      businessModel: "subscription",
      adminShell: "full",
      includeAi: true,
      includeEmail: true,
    });
    expect(buildManifest(a, "0.0.0").answers).toEqual(a);
  });

  it("records the version of the generator that produced it", async () => {
    // Read from the package.json beside template/ rather than hardcoded, so it
    // cannot go stale on a release nobody remembered to hand-edit.
    const ownVersion = (
      JSON.parse(
        await readFile(join(__dirname, "..", "..", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
      generator: { name: string; version: string };
    };
    expect(parsed.generator).toEqual({
      name: "@adminigloo/create-app",
      version: ownVersion,
    });
  });

  it("lists the same packages, at the same ranges, as package.json", async () => {
    // Two files stating the same dependency set is exactly the drift this
    // manifest exists to remove, so they had better agree.
    const a = answers({
      businessModel: "both",
      includeAi: true,
      includeEmail: true,
    });
    const plan = await planEmit(TEMPLATE_DIR, "/out", a);
    const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
      packages: Record<string, string>;
    };
    const pkg = JSON.parse(plan.files.get("package.json") ?? "") as {
      dependencies: Record<string, string>;
    };
    for (const [name, range] of Object.entries(parsed.packages)) {
      expect(pkg.dependencies[name], `${name} range`).toBe(range);
    }
    expect(Object.keys(parsed.packages).sort()).toEqual([...packagesFor(a)].sort());
  });

  it("records the overlays that were actually copied", async () => {
    const a = answers({
      businessModel: "both",
      adminShell: "full",
      includeEmail: true,
    });
    const plan = await planEmit(TEMPLATE_DIR, "/out", a);
    const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
      overlays: string[];
    };
    expect(parsed.overlays).toEqual([
      "admin-minimal",
      "admin-full",
      "stripe",
      "catalog-admin",
      "account",
      "email",
    ]);
  });

  it("records no overlay for the emptiest project there is", async () => {
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ adminShell: "none", businessModel: "none" }),
    );
    const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
      overlays: string[];
    };
    expect(parsed.overlays).toEqual([]);
  });

  it("is rebuildable — the whole point of nothing in it being hand-written", async () => {
    // A `doctor` command detects drift by regenerating this and diffing. That
    // only works while every field is derived, so this is the property to break
    // loudly rather than the file contents.
    const a = answers({ businessModel: "one-time", adminShell: "minimal" });
    const plan = await planEmit(TEMPLATE_DIR, "/out", a);
    const ownVersion = (
      JSON.parse(
        await readFile(join(__dirname, "..", "..", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    expect(plan.files.get(MANIFEST_FILENAME)).toBe(
      renderManifest(buildManifest(a, ownVersion)),
    );
  });

  it("separates variables that block boot from variables that do not", () => {
    const a = answers({ businessModel: "both", includeEmail: true });
    const m = buildManifest(a, "0.0.0");
    expect(m.env.required).toEqual([...requiredEnvFor(a)]);
    expect(m.env.optional).toEqual([...optionalEnvFor(a)]);
    // The distinction is load-bearing: the closing CLI summary says the app
    // will not boot until the required ones are set, and mixing the optional
    // ones in makes that sentence false.
    for (const name of m.env.optional) expect(m.env.required).not.toContain(name);
  });
});

describe("capabilities", () => {
  it("are sorted, so two manifests for the same answers compare equal", () => {
    const keys = capabilitiesFor(
      answers({ businessModel: "both", adminShell: "full", includeAi: true }),
    );
    expect([...keys]).toEqual([...keys].sort());
  });

  it("name the base every project has, rather than leaving it implied", () => {
    const keys = capabilitiesFor(
      answers({ adminShell: "none", businessModel: "none" }),
    );
    for (const key of [
      "auth.clerk",
      "permissions.two-layer",
      "trpc.procedure-ladder",
      "tenancy.invitations",
      "observability.error-log",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("distinguish an invisible personal workspace from a visible organisation", () => {
    expect(capabilitiesFor(answers({ tenantNoun: "none" }))).toContain(
      "tenancy.personal-workspace",
    );
    expect(capabilitiesFor(answers({ tenantNoun: "Team" }))).toContain(
      "tenancy.organizations",
    );
  });

  it("claim no admin surface in a project generated with --admin none", () => {
    // The bug every part of this manifest is downstream of: a hardcoded /admin
    // link in a project that has no /admin route.
    const keys = capabilitiesFor(
      answers({ adminShell: "none", businessModel: "both" }),
    );
    expect(keys.filter((k) => k.startsWith("admin."))).toEqual([]);
  });

  it("claim no product builder without an admin shell to put it in", () => {
    expect(
      capabilitiesFor(answers({ adminShell: "none", businessModel: "both" })),
    ).not.toContain("admin.product-builder");
    expect(
      capabilitiesFor(answers({ adminShell: "minimal", businessModel: "both" })),
    ).toContain("admin.product-builder");
  });

  it("claim orders and entitlements on BOTH money paths, not one each", () => {
    // An order is the record of any purchase, recurring or not; entitlements
    // are how either kind grants something. Splitting them by business model
    // was a real bug in the package set once already.
    for (const businessModel of ["one-time", "subscription", "both"] as const) {
      const keys = capabilitiesFor(answers({ businessModel }));
      expect(keys).toContain("commerce.orders");
      expect(keys).toContain("billing.entitlements");
    }
  });

  it("claim nothing about money in a project that takes none", () => {
    const keys = capabilitiesFor(
      answers({ businessModel: "none", adminShell: "full" }),
    );
    for (const key of keys) {
      expect(key).not.toMatch(/^(payments|catalog|commerce|billing|storefront)/);
    }
  });

  it("track the optional packages", () => {
    expect(capabilitiesFor(answers({ includeAi: true }))).toContain("ai.streaming");
    expect(capabilitiesFor(answers({ includeAi: false }))).not.toContain(
      "ai.streaming",
    );
    expect(capabilitiesFor(answers({ includeEmail: true }))).toContain(
      "email.transactional",
    );
    expect(capabilitiesFor(answers({ includeEmail: false }))).not.toContain(
      "email.transactional",
    );
  });
});

describe("overlayNamesFor", () => {
  it("selects the same names planEmit copies", async () => {
    // The manifest records the names; planEmit copies the directories. If the
    // two ever disagree, the manifest is lying about the project.
    for (const adminShell of ["none", "minimal", "full"] as const) {
      for (const businessModel of ["none", "one-time", "both"] as const) {
        for (const includeEmail of [false, true]) {
          const a = answers({ adminShell, businessModel, includeEmail });
          const plan = await planEmit(TEMPLATE_DIR, "/out", a);
          const parsed = JSON.parse(plan.files.get(MANIFEST_FILENAME) ?? "") as {
            overlays: string[];
          };
          expect(parsed.overlays).toEqual([...overlayNamesFor(a)]);
        }
      }
    }
  });

  it("stacks admin-full on top of admin-minimal rather than replacing it", () => {
    expect(overlayNamesFor(answers({ adminShell: "full" }))).toEqual([
      "admin-minimal",
      "admin-full",
    ]);
  });
});

describe("parseArgs", () => {
  it("takes the first bare argument as the name", () => {
    expect(parseArgs(["acme"]).name).toBe("acme");
  });

  it("ignores a second bare argument rather than silently using it", () => {
    expect(parseArgs(["acme", "other"]).name).toBe("acme");
  });

  it("accepts --dir in both spellings", () => {
    expect(parseArgs(["--dir", "/tmp/x"]).dir).toBe("/tmp/x");
    expect(parseArgs(["--dir=/tmp/y"]).dir).toBe("/tmp/y");
  });

  it("recognises the short flags", () => {
    expect(parseArgs(["-y"]).yes).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("defaults to interactive with no flags", () => {
    expect(parseArgs([]).yes).toBe(false);
  });
});

describe("collectAnswers", () => {
  it("takes the CLI name over prompting for one", async () => {
    const result = await collectAnswers(
      { name: "from-flag", yes: true, help: false },
      defaultsOnlyPrompter(),
    );
    expect(result.projectName).toBe("from-flag");
  });

  it("validates a name supplied by flag, not only a typed one", async () => {
    await expect(
      collectAnswers({ name: "Bad Name", yes: true, help: false }, defaultsOnlyPrompter()),
    ).rejects.toThrow(InvalidProjectNameError);
  });
});

describe("targetDirFor", () => {
  it("defaults to a directory named after the project", () => {
    expect(targetDirFor({ yes: true, help: false }, answers(), "/work")).toMatch(
      /acme$/,
    );
  });

  it("honours --dir", () => {
    expect(
      targetDirFor({ yes: true, help: false, dir: "elsewhere" }, answers(), "/work"),
    ).toMatch(/elsewhere$/);
  });
});

describe("assertTargetUsable", () => {
  it("accepts a directory that does not exist yet", async () => {
    await expect(assertTargetUsable(join(tmpdir(), `nope-${Date.now()}`))).resolves
      .toBeUndefined();
  });

  it("accepts a directory holding only a git repo and a README", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usable-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "notes");
    await expect(assertTargetUsable(dir)).resolves.toBeUndefined();
  });

  it("refuses a directory with real work in it, and names what it found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "occupied-"));
    await writeFile(join(dir, "index.ts"), "export {}");
    await expect(assertTargetUsable(dir)).rejects.toThrow(TargetNotEmptyError);
    await expect(assertTargetUsable(dir)).rejects.toThrow(/index\.ts/);
  });
});

describe("planEmit — against the real template", () => {
  it("plans every template file plus the generated ones", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.has("package.json")).toBe(true);
    expect(plan.files.has(".env.example")).toBe(true);
    expect(plan.files.has("SCAFFOLD.md")).toBe(true);
    expect(plan.files.has(".gitignore")).toBe(true);
    expect(plan.files.has(".npmrc")).toBe(true);
    expect(plan.files.has(join("src", "env.ts"))).toBe(true);
    expect(plan.files.has(join("app", "layout.tsx"))).toBe(true);
  });

  it("leaves no unsubstituted token anywhere in the output", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ tenantNoun: "Company" }));
    for (const [path, contents] of plan.files) {
      expect(contents, `${path} still has a token`).not.toMatch(/__[A-Z_]+__/);
    }
  });

  it("writes the scope into .npmrc so a fresh clone can install", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.get(".npmrc")).toContain("@adminigloo:registry=");
  });

  it("points drizzle-kit at the UNPOOLED url", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.get("drizzle.config.ts")).toContain("DATABASE_URL_UNPOOLED");
  });
});

describe("writePlan — end to end", () => {
  it("produces a directory that matches the plan exactly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generated-"));
    const target = join(dir, "acme");
    const plan = await planEmit(TEMPLATE_DIR, target, answers());
    await writePlan(plan);

    const written = await readdir(target);
    expect(written).toContain("package.json");
    expect(written).toContain(".gitignore");
    expect(written).toContain("src");

    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(manifest.name).toBe("acme");

    const env = await readFile(join(target, "src", "env.ts"), "utf8");
    expect(env).toContain('from "@adminigloo/env"');
    expect(env).not.toMatch(/__[A-Z_]+__/);
  });
});

describe("nextSteps", () => {
  it("lists only the variables this project actually needs", () => {
    const out = nextSteps(answers({ businessModel: "none" }), "/out/acme");
    expect(out).toContain("DATABASE_URL");
    expect(out).not.toContain("STRIPE_SECRET_KEY");
  });

  it("warns about key mode only when there are keys to get wrong", () => {
    expect(nextSteps(answers({ businessModel: "none" }), "/o")).not.toMatch(/TEST mode/);
    expect(nextSteps(answers({ businessModel: "both" }), "/o")).toMatch(/TEST mode/);
  });
});

describe("non-interactive flags", () => {
  it("parses each answer flag in both spellings", () => {
    expect(parseArgs(["--model", "both"]).businessModel).toBe("both");
    expect(parseArgs(["--model=subscription"]).businessModel).toBe("subscription");
    expect(parseArgs(["--admin", "full"]).adminShell).toBe("full");
    expect(parseArgs(["--tenant-noun=Company"]).tenantNoun).toBe("Company");
    expect(parseArgs(["--ai"]).ai).toBe(true);
    expect(parseArgs(["--no-ai"]).ai).toBe(false);
    expect(parseArgs(["--email"]).email).toBe(true);
  });

  it("does not mistake a flag's value for the project name", () => {
    // `--admin full acme` must yield name=acme, not name=full.
    expect(parseArgs(["--admin", "full", "acme"]).name).toBe("acme");
    expect(parseArgs(["--model", "both", "acme"]).name).toBe("acme");
    expect(parseArgs(["acme", "--admin", "full"]).name).toBe("acme");
  });

  it("rejects an unknown value instead of silently defaulting", () => {
    expect(() => parseArgs(["--model", "freemium"])).toThrow(UnknownFlagValueError);
    expect(() => parseArgs(["--admin", "huge"])).toThrow(/none, minimal, full/);
  });

  it("uses a flag verbatim and prompts only for the rest", async () => {
    const result = await collectAnswers(
      {
        name: "acme",
        yes: true,
        help: false,
        businessModel: "both",
        adminShell: "full",
        ai: true,
      },
      defaultsOnlyPrompter(),
    );
    expect(result.businessModel).toBe("both");
    expect(result.adminShell).toBe("full");
    expect(result.includeAi).toBe(true);
    // Not supplied, so it fell through to the default.
    expect(result.tenantNoun).toBe(DEFAULT_ANSWERS.tenantNoun);
  });
});

describe("admin shell overlays", () => {
  it("adds no admin SHELL when it is declined", async () => {
    // Narrowed from "no path contains admin". The admin tRPC router lives in the
    // BASE template on purpose — routers stay in runtime packages so a security
    // fix reaches every client without a re-copy. Only the copied-source shell
    // is optional.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "none" }));
    const paths = [...plan.files.keys()];
    expect(paths.some((p) => p.startsWith(join("app", "admin")))).toBe(false);
    expect(paths.some((p) => p.includes(join("components", "admin")))).toBe(false);
  });

  it("copies the minimal shell as source", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "minimal" }));
    const paths = [...plan.files.keys()];
    expect(paths).toContain(join("app", "admin", "layout.tsx"));
    expect(paths).toContain(join("app", "admin", "page.tsx"));
    expect(paths).toContain(
      join("src", "components", "admin", "PermissionChecklist.tsx"),
    );
  });

  it("layers full on top of minimal rather than replacing it", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    const paths = [...plan.files.keys()];
    // From minimal…
    expect(paths).toContain(join("app", "admin", "layout.tsx"));
    // …plus full's additions.
    expect(paths).toContain(join("app", "admin", "roles", "page.tsx"));
    expect(paths).toContain(join("app", "admin", "people", "page.tsx"));
  });

  it("filters a nav item whose package is absent rather than breaking", async () => {
    // Without commerce there is no catalog package and no `catalog.*` key. The
    // nav still lists Products; the permission filter removes it. That is the
    // designed behaviour, not an oversight — assert it so nobody "fixes" it by
    // declaring a key for a capability the project does not have.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    const catalog = plan.files.get(join("src", "permissions", "catalog.ts")) ?? "";
    expect(catalog).not.toContain("catalogPermissions");
    expect(plan.files.has(join("app", "admin", "products", "page.tsx"))).toBe(false);
  });

  it("leaves no unsubstituted token in the overlay files either", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    for (const [path, contents] of plan.files) {
      expect(contents, `${path} still has a token`).not.toMatch(/__[A-Z_]+__/);
    }
  });

  it("declares every staff permission the admin nav gates on", async () => {
    // A nav item whose permission is missing from the catalog is invisible to
    // everyone, forever, with no error anywhere.
    //
    // Checked against a FULLY-featured project on purpose. The nav is a
    // superset: an item like Products is gated on a key that only exists once
    // the catalog package is installed, and in a leaner project it is simply
    // filtered out — harmless, and the assertion below covers that separately.
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ adminShell: "full", businessModel: "both", includeAi: true, includeEmail: true }),
    );
    const nav = plan.files.get(
      join("src", "components", "admin", "AdminNav.tsx"),
    );
    const catalog = plan.files.get(join("src", "permissions", "catalog.ts"));
    expect(nav).toBeDefined();
    expect(catalog).toBeDefined();

    const referenced = [...(nav ?? "").matchAll(/permission: "([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(referenced.length).toBeGreaterThan(0);

    // A key reaches the catalog one of two ways: written literally in the app's
    // own block, or spread in from a package fragment. Grepping only for the
    // literal would fail every package-contributed key while the app works
    // perfectly — so map the namespace to the fragment that supplies it.
    //
    // IN THE STAFF CATALOG SPECIFICALLY, not merely somewhere in the file. The
    // sidebar filters against `loadStaffPermissions`, so a key that reached the
    // tenant catalog instead is one nobody in the admin can hold: the item is
    // invisible to every staff user, forever, and nothing errors. Checking the
    // whole file passed happily while `commercePermissions` was in the wrong
    // scope, which is the failure this narrowing exists to make impossible.
    const FRAGMENT_FOR_NAMESPACE: Record<string, string> = {
      catalog: "catalogPermissions",
    };
    const staffCall = /definePermissions\(\s*"staff",\s*\{([^}]*)\}/.exec(
      catalog ?? "",
    );
    const staffSpreads = staffCall?.[1] ?? "";
    const appStaffBlock = (catalog ?? "").slice(
      (catalog ?? "").indexOf("const appStaffPermissions = {"),
      (catalog ?? "").indexOf('export const staffCatalog'),
    );
    expect(staffSpreads, "no staff catalog found — has the emitter moved?").not.toBe("");

    for (const key of referenced) {
      const namespace = key.split(".")[0] ?? "";
      const fragment = FRAGMENT_FOR_NAMESPACE[namespace];
      const satisfied = fragment
        ? staffSpreads.includes(fragment)
        : appStaffBlock.includes(`"${key}"`);
      expect(
        satisfied,
        fragment
          ? `the sidebar gates on ${key} and the STAFF catalog never spreads ` +
            `${fragment} — a key in the other scope can be held by nobody the ` +
            `sidebar asks about`
          : `the sidebar gates on ${key} and the STAFF catalog never declares it`,
      ).toBe(true);
    }
  });
});

describe("derived modules", () => {
  it("composes only the env fragments the project installed", async () => {
    const plain = renderEnvModule(answers({ businessModel: "none" }));
    expect(plain).not.toContain("stripeServer");
    expect(plain).not.toContain("STRIPE_SECRET_KEY");

    const paid = renderEnvModule(answers({ businessModel: "subscription" }));
    expect(paid).toContain("stripeServer()");
    expect(paid).toContain("STRIPE_MODE_BOUND_KEYS");
    expect(paid).toContain("STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY");
  });

  it("registers Stripe keys as mode-bound, not merely as variables", () => {
    // Listing the key without registering it would validate its prefix and
    // then happily run a live key in staging.
    const paid = renderEnvModule(answers({ businessModel: "both" }));
    expect(paid).toMatch(/modeBoundKeys:.*STRIPE_MODE_BOUND_KEYS/);
  });

  it("re-exports a schema for EVERY package that owns a table", async () => {
    // drizzle.config points at this one file, so a package omitted here has its
    // tables silently excluded from every migration: the app compiles, boots,
    // and fails on the first insert against a table nobody created.
    const full = renderSchemaModule(
      answers({ businessModel: "both", includeAi: true, includeEmail: true }),
    );
    for (const pkg of [
      "auth",
      "tenancy",
      "permissions",
      "observability",
      "stripe",
      "catalog",
      "commerce",
      "billing",
      "ai",
      "email",
    ]) {
      expect(full, `missing ${pkg}/schema`).toContain(`@adminigloo/${pkg}/schema"`);
    }
  });

  it("composes an env fragment for every package that declares one", () => {
    const full = renderEnvModule(
      answers({ businessModel: "both", includeAi: true, includeEmail: true }),
    );
    for (const fragment of ["aiServer()", "emailServer()", "stripeServer()"]) {
      expect(full, `missing ${fragment}`).toContain(fragment);
    }
    // .env.example asks for these, so env.ts must actually read them.
    for (const v of ["ANTHROPIC_API_KEY", "EMAIL_FROM", "RESEND_API_KEY"]) {
      expect(full).toContain(`${v}: process.env.${v}`);
    }
  });

  it("asks only for env vars the installed packages declare", () => {
    const withEmail = requiredEnvFor(answers({ includeEmail: true }));
    expect(withEmail).toContain("EMAIL_FROM");
    // Nothing reads RESEND_FROM_EMAIL; asking for it taught people to ignore
    // the list, and the variable that IS required went unmentioned.
    expect(withEmail).not.toContain("RESEND_FROM_EMAIL");
  });

  it("re-exports the stripe schema only when stripe is installed", () => {
    expect(renderSchemaModule(answers({ businessModel: "none" }))).not.toContain(
      "stripe/schema",
    );
    expect(renderSchemaModule(answers({ businessModel: "one-time" }))).toContain(
      '@adminigloo/stripe/schema"',
    );
  });

  it("always re-exports the three base schemas so one migration covers all", () => {
    const out = renderSchemaModule(answers());
    for (const pkg of ["auth", "tenancy", "permissions"]) {
      expect(out).toContain(`@adminigloo/${pkg}/schema"`);
    }
  });
});

describe("stripe overlay", () => {
  it("is absent from a project that takes no money", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "none" }));
    expect(plan.files.has(join("app", "api", "webhooks", "stripe", "route.ts"))).toBe(
      false,
    );
    expect(plan.files.has(join("src", "server", "stripe.ts"))).toBe(false);
  });

  it("is present once money is involved", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    expect(plan.files.has(join("app", "api", "webhooks", "stripe", "route.ts"))).toBe(
      true,
    );
  });

  it("implements the release-on-failure step, not just the claim", async () => {
    // Claiming without releasing is the wedge: every retry then sees an
    // unfinished row and defers forever.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    const route = plan.files.get(
      join("app", "api", "webhooks", "stripe", "route.ts"),
    );
    expect(route).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(route).toContain("claimedAt: null");
    expect(route).toContain("lastError:");
    expect(route).toMatch(/status: 500/);
  });

  it("reads the raw body, never req.json()", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    const route =
      plan.files.get(join("app", "api", "webhooks", "stripe", "route.ts")) ?? "";

    expect(route).toContain("await req.text()");

    // Strip comments before asserting. The doc comment deliberately NAMES
    // req.json() to explain why it must not be used, and a naive substring
    // check would fail on the very warning that prevents the bug.
    const code = route
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("req.json()");
  });

  it("the clerk route reads the raw body too", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const route =
      plan.files.get(join("app", "api", "webhooks", "clerk", "route.ts")) ?? "";
    const code = route
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(route).toContain("await req.text()");
    expect(code).not.toContain("req.json()");
  });
});

/**
 * The shop was live, correct, and linked to by nothing.
 *
 * A product sat in the database, `/products` rendered it, and no page in the
 * generated app pointed there — which to the person who had just created it was
 * indistinguishable from the shop not existing. Every case below is a
 * configuration that was never generated while the only one anyone tried was
 * the full one.
 */
const SELLING_MODELS = ["one-time", "subscription", "both"] as const;

describe("the public nav", () => {
  it.each(SELLING_MODELS)("lists the storefront for --model %s", (businessModel) => {
    const nav = renderSiteNav(answers({ businessModel }));
    expect(nav).toContain(`{ href: "/products", label: "Products" }`);
  });

  it("omits it entirely when the project sells nothing", () => {
    // Not an empty label or a disabled entry — no entry. The route does not
    // exist in a project without the stripe overlay, so a link to it is a 404.
    const nav = renderSiteNav(answers({ businessModel: "none" }));
    expect(nav).not.toContain("/products");
    expect(nav).not.toContain("Products");
  });

  it("always exports the same shape, so no consumer tests for null", () => {
    for (const businessModel of [...SELLING_MODELS, "none"] as const) {
      const nav = renderSiteNav(answers({ businessModel }));
      expect(nav).toContain("export interface SiteLink {");
      expect(nav).toMatch(/export const SITE_LINKS: readonly SiteLink\[\] = \[/);
    }
  });

  it("is never empty, in any configuration", () => {
    // The admin sidebar renders this list under a heading. An empty list there
    // is a heading with nothing under it, in exactly the configuration nobody
    // generates — which is how the bug this file fixes shipped in the first
    // place. Every project has a public landing page.
    for (const businessModel of [...SELLING_MODELS, "none"] as const) {
      const nav = renderSiteNav(answers({ businessModel }));
      expect(nav).toContain(`{ href: "/", label: "Home" }`);
    }
  });
});

describe("the landing page", () => {
  it.each(SELLING_MODELS)("links to the shop for --model %s", (businessModel) => {
    const page = renderHomePage(answers({ businessModel }));
    expect(page).toContain('href="/products"');
    // Prominent, from the design system. A bare text link next to six file
    // paths is a link nobody reads as "your shop is here".
    expect(page).toContain('buttonClass("primary")');
    expect(page).toContain("buttonClass");
  });

  it("has no shop section when there is nothing to sell", () => {
    const page = renderHomePage(answers({ businessModel: "none" }));
    expect(page).not.toContain("/products");
    // And imports nothing it no longer uses.
    expect(page).not.toContain("buttonClass");
  });

  it("keeps what the page was already for", () => {
    for (const businessModel of [...SELLING_MODELS, "none"] as const) {
      const page = renderHomePage(answers({ businessModel }));
      expect(page).toContain("<HealthCheck />");
      expect(page).toContain('href="/setup"');
      expect(page).toContain("Where to start");
      expect(page).toContain("src/server/routers/_app.ts");
    }
  });

  it("interpolates the project name rather than leaving a token", () => {
    const page = renderHomePage(answers({ projectName: "acme" }));
    expect(page).toContain('title="acme"');
    expect(page).not.toMatch(/__[A-Z_]+__/);
  });
});

describe("nothing links to the shop — end to end", () => {
  it.each(SELLING_MODELS)("plans a reachable shop for --model %s", async (businessModel) => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel }));
    expect(plan.files.get(join("src", "nav.ts")) ?? "").toContain('href: "/products"');
    expect(plan.files.get(join("app", "(site)", "page.tsx")) ?? "").toContain(
      'href="/products"',
    );
    // The route the link points at has to be in the same plan.
    expect(plan.files.has(join("app", "(site)", "products", "page.tsx"))).toBe(true);
  });

  it("plans a nav and a landing page even with nothing to sell", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "none" }));
    expect(plan.files.has(join("src", "nav.ts"))).toBe(true);
    expect(plan.files.get(join("app", "(site)", "page.tsx")) ?? "").not.toContain(
      "/products",
    );
    expect(plan.files.has(join("app", "(site)", "products", "page.tsx"))).toBe(false);
  });

  it("renders the public links in every header state, signed out included", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    const header = plan.files.get(join("src", "components", "AuthHeader.tsx")) ?? "";
    expect(header).toContain('from "@/nav"');
    expect(header).toContain("SITE_LINKS.map");

    // Once per branch: Clerk unconfigured, signed out, signed in. A shop only
    // account holders can see is the same bug one level up.
    expect(header.match(/<SiteLinks \/>/g)).toHaveLength(3);

    // Before the signed-in destinations, not after them.
    expect(header.indexOf("<SiteLinks />")).toBeLessThan(header.indexOf("<AppLinks />"));
  });

  it("keeps the Clerk Core 3 warning, and does not do the thing it warns about", async () => {
    // BOTH HALVES, and the second is the one that was missing. The assertion
    // used to read `expect(header).toContain("<SignedIn>")` against the raw
    // file, which the warning satisfies on its own — so the day somebody
    // reintroduced a real `<SignedIn>` wrapper, the test that exists to stop
    // exactly that would have gone green on the sentence forbidding it.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const header = plan.files.get(join("src", "components", "AuthHeader.tsx")) ?? "";
    expect(commentsIn(header)).toContain("<SignedIn>");
    expect(commentsIn(header)).toContain("removed");
    expect(withoutComments(header)).not.toContain("<SignedIn>");
    expect(withoutComments(header)).not.toContain("<SignedOut>");
  });
});

/**
 * The Admin link was hardcoded into the header that `SITE_LINKS` was written to
 * fix. A project generated with `--admin none` emits no `app/admin` at all, so
 * every signed-in user in that configuration saw a link to a 404 — the exact
 * bug, in the exact file, one branch further down.
 */
const ADMIN_SHELLS = ["minimal", "full"] as const;

describe("the signed-in nav", () => {
  it.each(ADMIN_SHELLS)("carries /admin for --admin %s", (adminShell) => {
    const nav = renderSiteNav(answers({ adminShell }));
    expect(nav).toContain(`{ href: "/admin", label: "Admin" }`);
  });

  it("drops /admin, and only /admin, when no admin shell was generated", () => {
    // The array itself is not conditional — every consumer maps over the same
    // shape in every configuration, which is the only reason no emitted file
    // has to ask whether an admin panel exists. What varies is what is IN it.
    //
    // It used to be empty here, and the assertion was that it rendered `[]`.
    // /members is in the base template now and appears in every project, so
    // the property worth pinning moved: the panel that was declined is absent
    // and the page that always exists is not.
    const nav = renderSiteNav(answers({ adminShell: "none" }));
    expect(nav).toContain('{ href: "/members", label: "Members" }');
    expect(nav).not.toContain('label: "Admin"');
    expect(nav).not.toContain('"/admin"');
  });

  it("carries /members in every configuration, tenant noun included", () => {
    // A personal workspace is a tenant like any other, so a consumer-shaped
    // project gets the same member list. Branching this on `--tenant none`
    // would put back the is-there-an-organisation-yet fork that personal
    // workspaces exist to delete — and it would leave app/(site)/members with
    // nothing linking to it, which is the bug this whole file is about.
    for (const tenantNoun of ["Organization", "Team", "none"] as const) {
      for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
        const nav = renderSiteNav(answers({ tenantNoun, adminShell }));
        expect(nav, `--tenant ${tenantNoun} --admin ${adminShell}`).toContain(
          '{ href: "/members", label: "Members" }',
        );
      }
    }
  });

  it("always exports the same shape, so no consumer tests for null", () => {
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      const nav = renderSiteNav(answers({ adminShell }));
      expect(nav).toMatch(/export const APP_LINKS: readonly SiteLink\[\] = /);
    }
  });

  it("emits an array literal that parses, in every configuration", () => {
    // The empty case is the one that gets this wrong: joining nothing with a
    // trailing comma renders `[\n  ,\n]`, and a generated file that does not
    // compile is a worse failure than the dead link it was replacing.
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      for (const businessModel of [...SELLING_MODELS, "none"] as const) {
        const nav = renderSiteNav(answers({ adminShell, businessModel }));
        expect(nav, `--admin ${adminShell} --model ${businessModel}`).not.toMatch(
          /\[\s*,/,
        );
        expect(nav).not.toMatch(/,\s*,/);
      }
    }
  });

  it("keeps the public links separate from the signed-in ones", async () => {
    // Different audiences. SITE_LINKS renders signed out, APP_LINKS does not —
    // folding them together is how a link to the admin panel ends up in front
    // of people who have no account.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    const header = plan.files.get(join("src", "components", "AuthHeader.tsx")) ?? "";
    expect(header).toContain("SITE_LINKS.map");
    expect(header).toContain("APP_LINKS.map");
    // Three public renders, one signed-in render.
    expect(header.match(/<SiteLinks \/>/g)).toHaveLength(3);
    expect(header.match(/<AppLinks \/>/g)).toHaveLength(1);
  });

  it("has no hardcoded admin link left in the header", async () => {
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell }));
      // Comments stripped first. The doc comment on AppLinks deliberately NAMES
      // the route to explain why it is no longer written here, and a naive
      // substring check would fail on the warning that prevents the bug.
      const code = withoutComments(
        plan.files.get(join("src", "components", "AuthHeader.tsx")) ?? "",
      );
      expect(code, `--admin ${adminShell}`).not.toContain('href="/admin"');
      expect(code, `--admin ${adminShell}`).not.toContain("/admin");
    }
  });
});

describe("the footer", () => {
  it("carries /setup in every configuration", () => {
    // A diagnostics page that is only linked from the landing page is a page
    // you cannot reach from whatever just broke.
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      for (const businessModel of [...SELLING_MODELS, "none"] as const) {
        const nav = renderSiteNav(answers({ adminShell, businessModel }));
        expect(nav).toMatch(
          /export const FOOTER_LINKS: readonly SiteLink\[\] = \[[\s\S]*href: "\/setup"/,
        );
      }
    }
  });

  it("keeps the diagnostics page out of the primary nav", () => {
    const nav = renderSiteNav(answers());
    const site = nav.slice(
      nav.indexOf("export const SITE_LINKS"),
      nav.indexOf("export const APP_LINKS"),
    );
    expect(site).not.toContain('href: "/setup"');
  });

  it("shares no href with the primary nav", () => {
    // `SiteFooter` renders `[...SITE_LINKS, ...FOOTER_LINKS]` and keys on href.
    // An overlap is a duplicate React key AND a link rendered twice in one row.
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      for (const businessModel of [...SELLING_MODELS, "none"] as const) {
        const nav = renderSiteNav(answers({ adminShell, businessModel }));
        const site = hrefsIn(sectionOf(nav, "SITE_LINKS"));
        const footer = hrefsIn(sectionOf(nav, "FOOTER_LINKS"));
        for (const href of footer) {
          expect(site, `${href} is in both lists`).not.toContain(href);
        }
      }
    }
  });

  it("renders on every page in the group, not on one of them", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const layout = plan.files.get(join("app", "(site)", "layout.tsx")) ?? "";
    expect(layout).toContain("<SiteFooter />");

    // Comments stripped: the footer's own doc comment explains why APP_LINKS is
    // absent, which a plain substring check would read as it being present.
    const footer = withoutComments(
      plan.files.get(join("src", "components", "SiteFooter.tsx")) ?? "",
    );
    expect(footer).toContain("FOOTER_LINKS");
    expect(footer).toContain("SITE_LINKS");
    // Signed-in destinations are NOT advertised to signed-out visitors.
    expect(footer).not.toContain("APP_LINKS");
  });

  it("names no page the scaffold does not generate", () => {
    // The instruction that produced this list was "do not invent legal pages or
    // social links". Nothing generates a privacy policy, so nothing may link to
    // one — a footer full of 404s is worse than a short footer.
    const nav = renderSiteNav(answers({ businessModel: "both", adminShell: "full" }));
    const footer = sectionOf(nav, "FOOTER_LINKS");
    for (const invented of ["/privacy", "/terms", "/about", "/contact", "/blog"]) {
      expect(footer).not.toContain(`href: "${invented}"`);
    }
  });
});

/**
 * The nav existed on exactly one page.
 *
 * `AuthHeader` was mounted inside `app/page.tsx` and nowhere else, so the
 * storefront, a product page, the checkout, `/setup` and the Clerk pages all
 * rendered with no navigation at all — a customer who arrived at a product from
 * a link had no route to the rest of the site.
 */
describe("the site chrome", () => {
  it("wraps the public pages in a route group, in every configuration", async () => {
    for (const adminShell of [...ADMIN_SHELLS, "none"] as const) {
      for (const businessModel of [...SELLING_MODELS, "none"] as const) {
        const plan = await planEmit(
          TEMPLATE_DIR,
          "/out",
          answers({ adminShell, businessModel }),
        );
        expect(plan.files.has(join("app", "(site)", "layout.tsx"))).toBe(true);
        expect(plan.files.has(join("app", "(site)", "page.tsx"))).toBe(true);
        expect(plan.files.has(join("app", "(site)", "setup", "page.tsx"))).toBe(true);
        // A second root page.tsx would be a route conflict with (site)/page.tsx:
        // both serve `/`, and Next refuses to build.
        expect(plan.files.has(join("app", "page.tsx"))).toBe(false);
      }
    }
  });

  it("puts every public page under it, base and overlay alike", async () => {
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "both", adminShell: "full" }),
    );
    for (const route of [
      join("app", "(site)", "page.tsx"),
      join("app", "(site)", "setup", "page.tsx"),
      join("app", "(site)", "sign-in", "[[...sign-in]]", "page.tsx"),
      join("app", "(site)", "sign-up", "[[...sign-up]]", "page.tsx"),
      join("app", "(site)", "products", "page.tsx"),
      join("app", "(site)", "products", "[slug]", "page.tsx"),
      join("app", "(site)", "checkout", "page.tsx"),
      join("app", "(site)", "checkout", "success", "page.tsx"),
    ]) {
      expect(plan.files.has(route), `${route} is not under the site layout`).toBe(true);
    }
  });

  it("leaves the admin shell outside it", async () => {
    // The admin layout is a full-height sticky sidebar with its own wordmark,
    // its own nav and its own signed-in-as strip. A second header stacked above
    // it pushes the sidebar out of the viewport and gives the page two
    // competing navigations.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    for (const path of plan.files.keys()) {
      if (!path.startsWith(join("app", "admin"))) continue;
      expect(path.startsWith(join("app", "(site)"))).toBe(false);
    }
    expect(plan.files.has(join("app", "admin", "layout.tsx"))).toBe(true);
  });

  it("stays additive — the base owns the layout, the overlay owns pages", async () => {
    // `planEmit` throws OverlayCollisionError if an overlay writes a path the
    // base already owns. Moving the shop into (site) is only safe because the
    // overlay contributes pages beneath a layout it does not touch.
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "both", adminShell: "full" }),
    );
    const base = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "none", adminShell: "none" }),
    );
    expect(base.files.get(join("app", "(site)", "layout.tsx"))).toBe(
      plan.files.get(join("app", "(site)", "layout.tsx")),
    );
  });
});

/**
 * The general form of every bug in this file.
 *
 * `/admin` in the header, `/products` in the nav, `/products/${slug}` typed out
 * by hand in the product list: each one was a URL written somewhere that could
 * not see whether the route had been installed. This walks the other way —
 * every link the plan emits has to resolve against the pages the SAME plan
 * writes — so it fails on the next hardcoded link rather than on these three.
 */
function sectionOf(navSource: string, name: string): string {
  const start = navSource.indexOf(`export const ${name}`);
  if (start < 0) return "";
  const end = navSource.indexOf("];", start);
  return end < 0 ? navSource.slice(start) : navSource.slice(start, end);
}

function hrefsIn(source: string): string[] {
  return [...source.matchAll(/href: "([^"]+)"/g)].flatMap((m) => m[1] ?? []);
}

/**
 * The emitted file with every comment removed — what the project actually RUNS.
 *
 * Almost every assertion in this suite wants this rather than the raw text, and
 * the two that did not know it were tautologies. `toContain("escapeHtml")` was
 * meant to prove the invitation body escapes what it interpolates; the only
 * `escapeHtml` left in that file is in the paragraph explaining that the helper
 * was DELETED, so the assertion passed on the strength of its own obituary and
 * would have gone on passing had the file been replaced with raw string
 * concatenation. This is a suite whose entire method is grepping generated
 * source, so that failure is available to every line of it — `assertions are
 * about code, not about prose` below is what keeps it from happening again.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The other half: only the comments.
 *
 * For the handful of assertions whose subject genuinely IS a comment — a
 * warning that has to survive an edit, because the code around it is shaped by
 * something no reader could infer. Spelling it out at the call site is the
 * point: a check written against the raw source cannot tell the reader, or the
 * guard, which of the two it meant.
 */
function commentsIn(source: string): string {
  return [
    ...source.matchAll(/\/\*[\s\S]*?\*\//g),
    ...source.matchAll(/^\s*\/\/.*$/gm),
  ]
    .map((m) => m[0])
    .join("\n");
}

/**
 * Every URL the router will actually serve, as segments.
 *
 * A `(group)` directory is dropped, because that is precisely what a route
 * group is: a folder the router ignores when it builds the path. `[slug]`,
 * `[...rest]` and `[[...optional]]` are kept as wildcards.
 */
function routePatternsIn(plan: EmitPlan): string[][] {
  const patterns: string[][] = [];
  for (const path of plan.files.keys()) {
    const segments = path.split(sep);
    const leaf = segments[segments.length - 1];
    if (segments[0] !== "app") continue;
    if (leaf !== "page.tsx" && leaf !== "route.ts") continue;
    patterns.push(
      segments.slice(1, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")"))),
    );
  }
  return patterns;
}

function matchesPattern(pattern: readonly string[], url: readonly string[]): boolean {
  const head = pattern[0];
  if (head === undefined) return url.length === 0;
  // An optional catch-all is always last and swallows the rest, zero included.
  if (head.startsWith("[[...")) return true;
  if (head.startsWith("[...")) return url.length > 0;
  const first = url[0];
  if (first === undefined) return false;
  if (head.startsWith("[")) return matchesPattern(pattern.slice(1), url.slice(1));
  return head === first && matchesPattern(pattern.slice(1), url.slice(1));
}

function resolves(href: string, patterns: readonly string[][]): boolean {
  const path = href.split(/[?#]/)[0] ?? "";
  const url = path.split("/").filter((s) => s.length > 0);
  return patterns.some((pattern) => matchesPattern(pattern, url));
}

describe("every generated link points at a route in the same plan", () => {
  const CONFIGURATIONS = [...SELLING_MODELS, "none"].flatMap((businessModel) =>
    [...ADMIN_SHELLS, "none"].map(
      (adminShell) =>
        [`--model ${businessModel} --admin ${adminShell}`, { businessModel, adminShell }] as const,
    ),
  ) as readonly (readonly [string, Partial<Answers>])[];

  it.each(CONFIGURATIONS)("nav.ts is honest for %s", async (_label, overrides) => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    const nav = plan.files.get(join("src", "nav.ts")) ?? "";
    const patterns = routePatternsIn(plan);

    const hrefs = hrefsIn(nav);
    // Guard against the regex silently matching nothing and passing forever.
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      expect(resolves(href, patterns), `${href} is in nav.ts with no route`).toBe(true);
    }
  });

  it.each(CONFIGURATIONS)("no emitted page links nowhere for %s", async (_label, overrides) => {
    // BOTH SPELLINGS, over every emitted module — and the second one is why
    // this test used to miss the bug it exists to catch. It scanned `href="/…"`
    // in JSX only, while `nav.ts is honest` scanned `href: "…"` only inside
    // src/nav.ts, so a const array of link objects in any OTHER file fell
    // between the two. `AdminNav.tsx` was exactly that file: it wrote
    // `href: "/admin/people"` and `href: "/admin/roles"` in an overlay that
    // ships no such pages, and four configurations shipped a sidebar with two
    // dead links in it while both tests stayed green.
    //
    // Still literal hrefs only. A template literal is a URL built at runtime —
    // that is what `productHref` exists for, and the storefront route is
    // unit-tested on its own. What this catches is somebody typing a path in.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    const patterns = routePatternsIn(plan);
    let checked = 0;

    for (const [path, contents] of plan.files) {
      if (!path.endsWith(".tsx") && !path.endsWith(".ts")) continue;
      for (const match of withoutComments(contents).matchAll(/href\s*[:=]\s*"(\/[^"]*)"/g)) {
        const href = match[1];
        if (href === undefined) continue;
        checked += 1;
        expect(resolves(href, patterns), `${path} links to ${href}, which is not a route`).toBe(
          true,
        );
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it.each(CONFIGURATIONS)("scans the admin sidebar too, for %s", async (_label, overrides) => {
    // The widened scan above is only as good as the files it reaches, and its
    // count is a whole-plan total that would stay comfortably above zero if the
    // sidebar stopped being emitted, stopped being a .tsx, or moved. The bug it
    // was widened for lived in ONE file, so that file is named here.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    const sidebar = plan.files.get(join("src", "components", "admin", "AdminNav.tsx"));
    const adminShell = answers(overrides).adminShell;

    if (adminShell === "none") {
      expect(sidebar, "a project with no admin shell needs no sidebar").toBeUndefined();
      return;
    }

    const hrefs = hrefsIn(withoutComments(sidebar ?? ""));
    expect(hrefs.length, "AdminNav.tsx carries no href — has it moved?").toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(
        resolves(href, routePatternsIn(plan)),
        `the admin sidebar links to ${href}, which this configuration does not generate`,
      ).toBe(true);
    }
  });
});


/**
 * The admin dashboard, which is generated for the same reason the sidebar is.
 *
 * THE FAILURE THESE GUARD AGAINST is not a broken build. It is a first screen
 * that shows a client either eighteen of their own permission keys or a wall of
 * numbers nobody can defend — and both of those compile perfectly. So the
 * assertions here are about what the emitted page COUNTS and what it refuses to
 * invent, rather than about whether it renders.
 */
describe("renderAdminDashboard", () => {
  /**
   * The same grid the link audit walks, built again here because that one is a
   * local inside its own describe. Every model against every shell: the page is
   * absent for four of them and has to be right for the rest.
   */
  const SHAPES = [...SELLING_MODELS, "none"].flatMap((businessModel) =>
    [...ADMIN_SHELLS, "none"].map(
      (adminShell) =>
        [
          `--model ${businessModel} --admin ${adminShell}`,
          { businessModel, adminShell },
        ] as const,
    ),
  ) as readonly (readonly [string, Partial<Answers>])[];

  it("is written wherever there is a shell, and nowhere else", async () => {
    for (const adminShell of ["minimal", "full"] as const) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell }));
      expect(plan.files.has(join("app", "admin", "page.tsx"))).toBe(true);
    }

    const none = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ adminShell: "none" }),
    );
    expect(none.files.has(join("app", "admin", "page.tsx"))).toBe(false);
  });

  it("counts orders only where there is an orders table to count", () => {
    const sells = renderAdminDashboard(
      answers({ businessModel: "both", adminShell: "full" }),
    );
    expect(sells).toContain("@adminigloo/commerce/schema");
    expect(sells).toContain("from(orderShipments)");

    // THE REASON THIS FILE IS GENERATED AT ALL. A `--model none` project never
    // installs @adminigloo/commerce, so a dashboard carrying that import would
    // not compile — and one that asked at runtime whether commerce was present
    // would be the conditional the artifact is forbidden to hold.
    const plain = renderAdminDashboard(
      answers({ businessModel: "none", adminShell: "full" }),
    );
    expect(plain).not.toContain("@adminigloo/commerce/schema");
    expect(plain).not.toContain("from(orders)");
    expect(plain).not.toContain("FULFILMENT_KEY_PREFIX");
  });

  it("invents no number the schema cannot answer", () => {
    // Against the CODE, not the prose: the doc comment on the emitted page
    // names MRR and churn in order to refuse them, and a check over raw source
    // would pass on the strength of that refusal alone.
    const code = withoutComments(
      renderAdminDashboard(answers({ businessModel: "both", adminShell: "full" })),
    );
    for (const invented of ["Math.random", "MRR", "churn", "ARPU", "trend"]) {
      expect(code, `the dashboard renders ${invented}`).not.toContain(invented);
    }
  });

  it("keeps the permission chips, and keeps them off the dashboard", async () => {
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ adminShell: "minimal" }),
    );
    const dashboard = plan.files.get(join("app", "admin", "page.tsx")) ?? "";

    // `toArray()` is how the old page listed every key the viewer holds. It is
    // a genuinely useful debug view and a terrible first screen, so it moved
    // rather than being deleted — and a page nothing links to is a page nobody
    // finds, so the sidebar has to name it.
    expect(dashboard).not.toContain("toArray()");
    expect(plan.files.has(join("app", "admin", "access", "page.tsx"))).toBe(true);
    expect(
      plan.files.get(join("src", "components", "admin", "AdminNav.tsx")) ?? "",
    ).toContain('href: "/admin/access"');
  });

  it("gates every query on the key its tile names", () => {
    const code = withoutComments(
      renderAdminDashboard(answers({ businessModel: "both", adminShell: "full" })),
    );

    const queried = [...code.matchAll(/counted\(can\.can\("([^"]+)"\)/g)].flatMap(
      (m) => m[1] ?? [],
    );
    const shown = [...code.matchAll(/permission: "([^"]+)"/g)].flatMap(
      (m) => m[1] ?? [],
    );

    // One query per tile, and the same keys on both sides. A tile whose key
    // guards nothing is a number a viewer sees without holding the permission;
    // a query whose key guards no tile is a read nobody asked for.
    expect(queried).toHaveLength(shown.length);
    expect(new Set(shown)).toEqual(new Set(queried));
    expect(shown.length).toBeGreaterThan(0);
  });

  it.each(SHAPES)(
    "names no permission key the project has not installed, for %s",
    async (_label, overrides) => {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      const dashboard = plan.files.get(join("app", "admin", "page.tsx"));
      if (dashboard === undefined) return;

      const catalog = plan.files.get(join("src", "permissions", "catalog.ts")) ?? "";
      const declared = [...catalog.matchAll(/"(staff\.[a-z.]+)":/g)].flatMap(
        (m) => m[1] ?? [],
      );
      const used = [
        ...withoutComments(dashboard).matchAll(/can\.can\("([^"]+)"\)/g),
      ].flatMap((m) => m[1] ?? []);

      expect(used.length).toBeGreaterThan(0);
      for (const key of used) {
        if (key.startsWith("staff.")) {
          // A key the app declares itself. In the wrong scope it would match
          // nothing, deny everybody and error nowhere.
          expect(declared, `${key} is not in the generated staff catalog`).toContain(
            key,
          );
        } else {
          // Everything else comes from a package fragment, and the only one
          // this page uses is @adminigloo/catalog's — which a project selling
          // nothing does not install.
          expect(key.startsWith("catalog.")).toBe(true);
          expect(answers(overrides).businessModel).not.toBe("none");
        }
      }
    },
  );
});

/**
 * Invitations: the one feature that spans tenancy, permissions, mail and audit.
 *
 * Three of the four ways to get this wrong are silent. A permission key in the
 * wrong scope matches nothing and errors nowhere. A router mounted only in some
 * configurations compiles in all of them. A mail module importing a package the
 * project did not install fails at build time in exactly the configuration
 * nobody generates. The fourth — the token reaching a log — is silent until it
 * is not.
 */
describe("the invitations router", () => {
  const INVITATIONS = join("src", "server", "routers", "invitations.ts");

  it.each(ALL_CONFIGURATIONS)("is emitted and mounted for %s", async (_label, o) => {
    // Tenancy is in the base package set, so there is no configuration in which
    // this feature is absent. A project generated without `--email` still
    // issues invitations; it hands the link back instead of posting it.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
    expect(plan.files.has(INVITATIONS)).toBe(true);
    const root = plan.files.get(join("src", "server", "routers", "_app.ts")) ?? "";
    expect(root).toContain("invitations: invitationsRouter");
    expect(root).toContain('from "./invitations"');
  });

  it("is mounted exactly where the tenancy package is", async () => {
    // The router is the app half of the tenancy package. If one is ever made
    // conditional the other has to be, and this is what notices.
    for (const [, overrides] of ALL_CONFIGURATIONS) {
      const a = answers(overrides);
      const plan = await planEmit(TEMPLATE_DIR, "/out", a);
      const hasTenancy = packagesFor(a).includes(`${a.scope}/tenancy`);
      const mounted = (
        plan.files.get(join("src", "server", "routers", "_app.ts")) ?? ""
      ).includes("invitations: invitationsRouter");
      expect(mounted).toBe(hasTenancy);
    }
  });

  it("puts inviting on the tenant rung and accepting one rung below it", async () => {
    // THE SCOPE IS THE WHOLE THING. Inviting somebody into an organisation is
    // that organisation's business, not the firm's, so it is `requireTenant`
    // and never `requireStaff` — a key checked on the wrong rung matches
    // nothing, the control is invisible to everybody including the owner, and
    // nothing errors anywhere.
    //
    // Accepting cannot be tenant-scoped at all: `tenantProcedure` denies
    // non-members, and an invitee is a non-member by definition. It runs on
    // `protectedProcedure`, and the token is the authorisation.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const source = withoutComments(plan.files.get(INVITATIONS) ?? "");

    expect(source).not.toContain("requireStaff");
    expect(source.match(/requireTenant\("members\.invite"\)/g)).toHaveLength(4);
    expect(source).toMatch(
      /accept: protectedProcedure\s*\n\s*\.meta\(\{ scope: "authenticated" \}\)/,
    );
    // Every procedure declares one, or the scope audit cannot see it.
    expect(source.match(/\.meta\(\{ scope: "(tenant|authenticated)" \}\)/g)).toHaveLength(5);
  });

  it.each(ALL_CONFIGURATIONS)(
    "declares members.invite in the TENANT catalog for %s",
    async (_label, o) => {
      // The key comes from `tenancyPermissions`, which the generated catalog
      // spreads into the tenant scope. Spread into staff instead — the mistake
      // this repository has already made once — and `requireTenant` resolves it
      // against a catalog that has never heard of it.
      const catalog = renderPermissionsCatalog(answers(o));
      const tenant = catalog.slice(
        catalog.indexOf("export const tenantCatalog"),
        catalog.indexOf("const appStaffPermissions"),
      );
      const staff = catalog.slice(catalog.indexOf("export const staffCatalog"));
      expect(tenant).toContain("...tenancyPermissions");
      expect(staff).not.toContain("tenancyPermissions");
    },
  );

  it("never writes the token to the audit log", async () => {
    // `metadata` is jsonb in the one table deliberately kept longer than
    // everything else, and `redactValue` redacts by string SHAPE, not by key
    // name — an opaque base64url token looks like nothing in particular and
    // would survive. The only defence is not putting it there.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const source = withoutComments(plan.files.get(INVITATIONS) ?? "");
    const metadataBlocks = source.match(/metadata: \{[\s\S]*?\},\n/g) ?? [];
    expect(metadataBlocks.length).toBeGreaterThan(0);
    for (const block of metadataBlocks) {
      expect(block).not.toContain("token");
      expect(block).not.toContain("url");
    }
  });

  it("returns the link only when nothing was posted", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const source = withoutComments(plan.files.get(INVITATIONS) ?? "");
    expect(source).toContain("link: delivery.delivered ? null : url");
  });
});

describe("the invitation accept route", () => {
  const PAGE = join("app", "(site)", "invite", "[token]", "page.tsx");

  it.each(ALL_CONFIGURATIONS)("exists under the site chrome for %s", async (_l, o) => {
    // Under `(site)`, so the invitee sees the product's own header and footer
    // rather than a bare page on an unfamiliar domain asking them to sign up.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
    expect(plan.files.has(PAGE)).toBe(true);
  });

  it("resolves nothing before the visitor has signed in", async () => {
    // A GET carrying a bearer token is fetched by prefetchers, mail scanners
    // and preview bots. Looking the token up here would tell any of them that
    // an invitation exists and who it is from; ACCEPTING here would let a
    // scanner join the organisation on the invitee's behalf.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const page = withoutComments(plan.files.get(PAGE) ?? "");
    expect(page).not.toContain("invitations.accept");
    expect(page).not.toContain('from "@/db"');
    expect(page).not.toContain("listForTenant");
  });

  it("carries the invitation back through sign-up rather than losing it", async () => {
    // Without a return path Clerk drops a new account on the landing page, the
    // tab holding the token is gone, and nobody can re-send the same link —
    // only a hash of it was ever stored.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const page = plan.files.get(PAGE) ?? "";
    expect(page).toContain("/sign-up?redirect_url=");
    expect(page).toContain("/sign-in?redirect_url=");

    for (const route of ["sign-up", "sign-in"]) {
      const clerkPage =
        plan.files.get(join("app", "(site)", route, `[[...${route}]]`, "page.tsx")) ?? "";
      expect(clerkPage, `${route} drops the return path`).toContain("forceRedirectUrl");
      // Through the guard, never straight from the query string: an unchecked
      // return path is an open redirect into a copy of the sign-in page.
      expect(clerkPage).toContain("safeReturnPath");
    }
    expect(plan.files.has(join("src", "redirect.ts"))).toBe(true);
  });
});

describe("the invitation mailer", () => {
  const MAILER = join("src", "server", "invitation-mail.ts");

  it("is emitted in both variants with the same exported surface", async () => {
    // The point of generating it: the router calls `sendInvitationEmail` and
    // holds no `if` asking whether a mail package was installed.
    for (const includeEmail of [true, false]) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail }));
      const source = plan.files.get(MAILER) ?? "";
      expect(source, `--email ${includeEmail}`).toMatch(
        /export (async )?function sendInvitationEmail/,
      );
      expect(source).toContain("export interface InvitationMailRequest");
      expect(source).toContain("export interface InvitationMailOutcome");
    }
  });

  it("imports the mail package only where the mail package exists", async () => {
    const without = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: false }));
    expect(without.files.get(MAILER) ?? "").not.toContain('from "@adminigloo/email"');

    const withMail = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const source = withMail.files.get(MAILER) ?? "";
    expect(source).toContain('from "@adminigloo/email"');
    expect(source).toContain('from "@adminigloo/email/schema"');
    // Every send is written to the delivery log, including the skipped ones —
    // which are the rows somebody debugging "why did they not get the email"
    // actually needs, and the ones a provider dashboard by definition lacks.
    expect(source).toContain("emailEvents");
  });

  it("still boots with no EMAIL_FROM, which is the default state", async () => {
    // EMAIL_FROM is deferred until deployment, and `createEmailSender` throws
    // at construction for a From it cannot parse. At module scope that means
    // the whole app fails to import.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    expect(plan.files.get(MAILER) ?? "").toContain("env.EMAIL_FROM ??");
  });

  it("degrades to a real outcome rather than a throw with no mail package", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: false }));
    const source = plan.files.get(MAILER) ?? "";
    expect(source).toContain('status: "skipped"');
    expect(source).not.toContain("throw");
  });
});

describe("the email overlay", () => {
  const PREVIEW = join("app", "(site)", "setup", "email", "page.tsx");
  const BODY = join("src", "emails", "invitation.ts");

  it("ships the templates and the preview only with --email", async () => {
    const without = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: false }));
    expect(without.files.has(PREVIEW)).toBe(false);
    expect(without.files.has(BODY)).toBe(false);

    const withMail = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    expect(withMail.files.has(PREVIEW)).toBe(true);
    expect(withMail.files.has(BODY)).toBe(true);
  });

  it("links the preview from the footer exactly when the page exists", async () => {
    // Both directions. A link with no page is a 404 in every footer; a page
    // with no link is a preview nobody ever opens, which is the same as not
    // having written it.
    for (const includeEmail of [true, false]) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail }));
      const nav = plan.files.get(join("src", "nav.ts")) ?? "";
      expect(hrefsIn(nav).includes("/setup/email")).toBe(includeEmail);
      expect(plan.files.has(PREVIEW)).toBe(includeEmail);
    }
  });

  it("previews from sample data and reads nothing", async () => {
    // Safe to leave reachable on a deployment precisely because there is no
    // invitation here to leak and no token to spend. A preview that took an id
    // from the URL would be exactly such a leak.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const page = withoutComments(plan.files.get(PREVIEW) ?? "");
    expect(page).not.toContain("@/db");
    expect(page).not.toContain("searchParams");
    expect(page).not.toContain("currentPrincipal");
    // An email body is a whole document. Injected into the page it would apply
    // its own background and font to the app around it.
    expect(page).toContain("srcDoc");
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders both bodies, because a message with no text part scores as spam", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const code = withoutComments(plan.files.get(BODY) ?? "");
    expect(code).toContain("readonly html: string;");
    expect(code).toContain("readonly text: string;");
    // Three separate calls, which is what makes this file the seam it claims to
    // be: rewording the subject is an edit to one of them. A single
    // `renderInvitationEmail(props)` passed straight through would satisfy the
    // two assertions above and leave nothing here to edit.
    expect(code).toContain("invitationSubject(props)");
    expect(code).toContain("renderInvitationHtml(props)");
    expect(code).toContain("invitationPlainText(props)");
  });

  it("builds no markup of its own, so there is nothing here to forget to escape", async () => {
    // THE ASSERTION THIS REPLACES WAS `toContain("escapeHtml")`, and it tested
    // nothing. The file mentions `escapeHtml` exactly once, in the block
    // comment recording that the hand-rolled template literal and its escaping
    // helper were removed — so the check passed on prose, and would have gone
    // on passing if the body had been replaced with raw concatenation, which is
    // the one thing it was written to catch.
    //
    // So: assert the absence instead. A generated invitation body that contains
    // no markup cannot interpolate a customer-typed organisation name
    // into markup, whether or not anybody remembered a helper. Escaping stops
    // being a discipline because there is nothing here to escape.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const code = withoutComments(plan.files.get(BODY) ?? "");
    expect(code).not.toContain("escapeHtml");
    // A closing tag and a doctype, because those are what markup has and a
    // TypeScript generic does not — `Array<string>` must not read as HTML here.
    expect(code).not.toMatch(/<\/[A-Za-z]/);
    expect(code).not.toContain("<!");
    // And the entity, which is the fingerprint of escaping done by hand.
    expect(code).not.toContain("&amp;");
  });

  it("composes the message synchronously, because the caller's signature is fixed", async () => {
    // `src/server/invitation-mail.ts` calls this inside a function whose shape
    // the router depends on, and @adminigloo/email deliberately renders through
    // `renderToStaticMarkup` rather than react-email's promise-returning
    // `render` for that reason. An await creeping in here ripples out into
    // every caller, so it is cheaper to notice it in the emitted file.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const code = withoutComments(plan.files.get(BODY) ?? "");
    expect(code).toContain("): RenderedEmail {");
    expect(code).not.toContain("async ");
    expect(code).not.toContain("await ");
    expect(code).not.toContain("Promise<");
  });
});

/**
 * The one setting in the generated project that is about the BUNDLER rather
 * than about the product, and the reason `next.config.ts` is generated at all.
 */
describe("next.config.ts", () => {
  const CONFIG = "next.config.ts";

  it("keeps the email renderer out of the RSC graph exactly when it is installed", async () => {
    // THE REGRESSION THIS EXISTS FOR. `@adminigloo/email/emails` renders the
    // bodies with React Email, so it imports `react-dom/server` — and React's
    // `react-server` export condition for that module is a file whose whole
    // body is a throw. Every module a bundler pulls into the RSC graph, server
    // components and route handlers alike, resolves under that condition, and
    // the trace runs from `src/emails/invitation.ts` through the invitations
    // router into `src/trpc/server.ts`, which every server component calling
    // `api()` imports. It is not one template that is at stake.
    //
    // Naming the package here moves it out of the bundle and into a runtime
    // require, where `react-dom/server` resolves to the real renderer. Nothing
    // about WHERE the render happens changes: it is server work either way, and
    // it stays synchronous. Turbopack does exempt node_modules from the rule,
    // so an installed project builds without this line — by a heuristic about a
    // path, which is what naming the package replaces with an instruction.
    const withMail = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    expect(withMail.files.get(CONFIG) ?? "").toContain(
      'serverExternalPackages: ["@neondatabase/serverless", "@adminigloo/email"]',
    );

    // And absent when there is no such package installed. An external naming a
    // package that is not in node_modules is not an error, which is precisely
    // why it would sit there unnoticed.
    const without = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: false }));
    expect(without.files.get(CONFIG) ?? "").toContain(
      'serverExternalPackages: ["@neondatabase/serverless"]',
    );
  });

  it("is emitted for every configuration, and states its answer as a literal", async () => {
    // Conditionals are allowed in the generator and forbidden in the artifact.
    // The list is what varies, so the list is computed here and written out
    // flat; a config file that asked `if (hasEmail)` would be the generator
    // leaking into the project it generated.
    for (const [label, overrides] of ALL_CONFIGURATIONS) {
      for (const includeEmail of [true, false]) {
        const plan = await planEmit(
          TEMPLATE_DIR,
          "/out",
          answers({ ...overrides, includeEmail }),
        );
        const source = plan.files.get(CONFIG) ?? "";
        expect(source, `${label} emitted no ${CONFIG}`).not.toBe("");
        expect(withoutComments(source)).toMatch(
          /serverExternalPackages: \["[^\]]*"\],/,
        );
        expect(withoutComments(source)).not.toContain("includeEmail");
        expect(withoutComments(source)).not.toMatch(/\bif\s*\(/);
      }
    }
  });
});

describe("the audit vocabulary", () => {
  const AUDIT = join("src", "server", "audit.ts");

  it.each(ALL_CONFIGURATIONS)("is one composed registry for %s", async (_l, o) => {
    // Two registries cannot detect a collision between them, and the audit
    // viewer can only label the keys its own registry holds — so an action
    // declared elsewhere rendered there as a raw string.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
    const source = plan.files.get(AUDIT) ?? "";
    expect(source).toContain("defineAuditedActions(auditedActions, {");
    expect(source).toContain("contributedBy: [");
    expect(source).toContain("adminAuditedActions");
    expect(source).toContain("invitationAuditedActions");
    for (const action of ["invitation.sent", "invitation.accepted", "invitation.revoked"]) {
      expect(source).toContain(action);
    }
  });

  it("takes in the catalog fragment only where the catalog router exists", async () => {
    const selling = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    expect(selling.files.get(AUDIT) ?? "").toContain("catalogAuditedActions");
    expect(selling.files.has(join("src", "server", "routers", "catalog.ts"))).toBe(true);

    const plain = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "none" }));
    expect(plain.files.get(AUDIT) ?? "").not.toContain("catalogAuditedActions");
  });

  it("marks acceptance sensitive and the send that preceded it not", async () => {
    // Accepting is the instant a stranger becomes a member and the data becomes
    // readable to them, which is where a "who could have seen this" review has
    // to start. Sending grants nothing. Marking both would put two rows in the
    // compliance slice for every one that belongs there.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const source = plan.files.get(AUDIT) ?? "";
    const sent = source.slice(
      source.indexOf('"invitation.sent"'),
      source.indexOf('"invitation.accepted"'),
    );
    const accepted = source.slice(
      source.indexOf('"invitation.accepted"'),
      source.indexOf('"invitation.revoked"'),
    );
    expect(accepted).toContain("sensitive: true");
    expect(sent).not.toContain("sensitive");
  });

  it("leaves no second registry behind in the admin router", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const admin = plan.files.get(join("src", "server", "routers", "admin.ts")) ?? "";
    expect(withoutComments(admin)).not.toContain("defineAuditedActions");
    expect(admin).toContain('from "../audit"');
  });
});

/**
 * The other direction.
 *
 * Every test above walks from a LINK to a route and asks whether the route
 * exists. That catches a dead link and misses the opposite failure entirely: a
 * page that was generated, works perfectly, and has nothing anywhere pointing
 * at it. That is not hypothetical — it is the bug the whole nav module was
 * written for. The shop was live, correct, and reachable only by typing the
 * URL, which from the outside is indistinguishable from never having built it.
 *
 * So this walks from every emitted page to the nav arrays and the admin
 * sidebar, and requires each route to be reachable or to be listed below with a
 * reason. The allowlist is the point: an unlinked route is sometimes right —
 * /invite/[token] arrives in an email and cannot have a nav entry, because the
 * URL is a one-time secret — but it should be a decision somebody wrote down,
 * not a page nobody noticed.
 */
const UNLINKED_BY_DESIGN: Readonly<Record<string, string>> = {
  "/invite/[token]":
    "arrives in an email. The URL carries a one-time token, so there is no " +
    "stable href to put in a nav, and a link to it in the header would be a " +
    "link to nobody's invitation.",
  "/sign-in/[[...sign-in]]":
    "the header's signed-out affordance is a button beside the public links, " +
    "not a nav entry. /sign-up IS in the footer, because nothing else offers it.",
  "/products/[slug]":
    "reached from the storefront listing, through productHref. A nav entry " +
    "would need a slug, and which product would it be.",
  "/checkout": "means nothing without a product in its query string.",
  "/checkout/success": "reached by redirect after a payment.",
  "/admin/products/new": "reached from the button on the product list.",
  "/admin/products/[id]": "reached by clicking a row in the product list.",
  "/account/orders/[orderNumber]":
    "reached by clicking a row in the customer's own order list, through " +
    "accountOrderHref. A nav entry would need an order number, and which " +
    "order would it be.",
  // /admin/errors and /admin/support USED TO BE HERE, excused on the grounds
  // that neither has a permission key the sidebar could gate a link on, so an
  // entry would 404 in every admin-minimal project. That was a correct
  // diagnosis of a different defect and no answer to this one: both pages were
  // generated, served, and reachable only by typing the URL. The sidebar is
  // generated now, so which items exist is decided from the answers and the
  // question of what could gate them never arises.
};

/** `/admin/products/[id]`, from a plan's file path. */
function routeKeysIn(plan: EmitPlan): string[] {
  return routePatternsIn(plan).map((pattern) => `/${pattern.join("/")}`);
}

/**
 * Every href a generated nav array or a nav COMPONENT renders.
 *
 * THREE FILES, and the third was added for the reason the second was: a nav
 * that lives inside a feature is a nav this scan cannot see, and a route
 * reachable only from it looks stranded. `AdminNav.tsx` was that file once —
 * it linked to two pages no overlay shipped while both link tests stayed green.
 * `AccountTabs.tsx` is the same shape pointing the other way: it is the only
 * thing linking `/account/orders` and `/account/billing`, and without it here
 * two real, linked, working pages would have to be excused in
 * `UNLINKED_BY_DESIGN` — which would be a lie written down, and would then
 * excuse them for ever if the strip were later deleted.
 *
 * The account tabs are absent from every project that sells nothing, and
 * `?? ""` is what makes that a non-event rather than a special case.
 */
function navHrefsIn(plan: EmitPlan): string[] {
  return [
    plan.files.get(join("src", "nav.ts")) ?? "",
    plan.files.get(join("src", "components", "admin", "AdminNav.tsx")) ?? "",
    plan.files.get(join("src", "components", "account", "AccountTabs.tsx")) ?? "",
  ].flatMap((source) => hrefsIn(withoutComments(source)));
}

describe("every generated page is reachable from somewhere", () => {
  const REACHABILITY = [...SELLING_MODELS, "none"].flatMap((businessModel) =>
    [...ADMIN_SHELLS, "none"].flatMap((adminShell) =>
      [true, false].map(
        (includeEmail) =>
          [
            `--model ${businessModel} --admin ${adminShell}${includeEmail ? " --email" : ""}`,
            { businessModel, adminShell, includeEmail },
          ] as const,
      ),
    ),
  ) as readonly (readonly [string, Partial<Answers>])[];

  it.each(REACHABILITY)("nothing is stranded in %s", async (_label, overrides) => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    const hrefs = navHrefsIn(plan);
    let checked = 0;

    for (const pattern of routePatternsIn(plan)) {
      const key = `/${pattern.join("/")}`;
      // API handlers are called, not navigated to.
      if (key.startsWith("/api")) continue;
      checked += 1;

      const linked = hrefs.some((href) =>
        matchesPattern(pattern, (href.split(/[?#]/)[0] ?? "").split("/").filter(Boolean)),
      );
      const excused = Object.prototype.hasOwnProperty.call(UNLINKED_BY_DESIGN, key);

      expect(
        linked || excused,
        `${key} is generated and nothing links to it. Add a nav entry, or add ` +
          `it to UNLINKED_BY_DESIGN with the reason it is reached another way.`,
      ).toBe(true);
    }

    expect(checked).toBeGreaterThan(0);
  });

  it("keeps the excuse list honest", async () => {
    // An allowlist nobody prunes is an allowlist that eventually excuses a
    // route that no longer exists — and then the next genuinely stranded page
    // slips in under an entry written for something else.
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "both", adminShell: "full", includeEmail: true }),
    );
    const routes = new Set(routeKeysIn(plan));
    for (const key of Object.keys(UNLINKED_BY_DESIGN)) {
      expect(routes.has(key), `${key} is excused and no longer exists`).toBe(true);
    }
  });

  it("does not advertise an invitation link in any nav array", async () => {
    // The URL is the credential. A nav entry would either be a dead link or,
    // worse, somebody's live invitation rendered in every header.
    for (const includeEmail of [true, false]) {
      const nav =
        (await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail }))).files.get(
          join("src", "nav.ts"),
        ) ?? "";
      expect(withoutComments(nav)).not.toContain("/invite");
    }
  });
});

describe("the product route has one definition", () => {
  it("is never written out by hand on the storefront", async () => {
    // `src/storefront.ts` documents itself as the single place that knows the
    // route, and the product list built the same URL itself anyway. Two copies
    // of one rule is one copy that gets missed: the admin's "view on the site"
    // link encodes the slug and the hand-written one did not, so a slug needing
    // an escape resolved in the admin and 404d in the shop.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    for (const [path, contents] of plan.files) {
      if (!path.startsWith("app") && !path.startsWith("src")) continue;
      if (!path.endsWith(".tsx") && !path.endsWith(".ts")) continue;
      if (path === join("src", "storefront.ts")) continue;
      if (path.includes("__tests__")) continue;
      expect(
        withoutComments(contents),
        `${path} builds a product URL instead of calling productHref`,
      ).not.toMatch(/["'`]\/products\/\$\{/);
    }
  });

  it("is called by the page that lists products", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    const page = plan.files.get(join("app", "(site)", "products", "page.tsx")) ?? "";
    expect(page).toContain('from "@/storefront"');
    expect(page).toContain("productHref(product.slug)");
  });
});

/**
 * Every configuration this generator can produce, as a table.
 *
 * Boundaries are the one thing that must exist in ALL of them. A missing
 * storefront is a project that sells nothing; a missing error boundary is a
 * project whose users see "Application error: a client-side exception has
 * occurred" on a blank page, and there is no configuration where that is the
 * intended behaviour.
 */
const ALL_CONFIGURATIONS = [...SELLING_MODELS, "none"].flatMap((businessModel) =>
  [...ADMIN_SHELLS, "none"].map(
    (adminShell) =>
      [
        `--model ${businessModel} --admin ${adminShell}`,
        { businessModel, adminShell },
      ] as const,
  ),
) as readonly (readonly [string, Partial<Answers>])[];

/** In every project, whatever it was generated with. */
const BASE_BOUNDARIES = [
  join("app", "global-error.tsx"),
  join("app", "error.tsx"),
  join("app", "not-found.tsx"),
  join("app", "(site)", "error.tsx"),
  join("app", "(site)", "not-found.tsx"),
  join("app", "(site)", "loading.tsx"),
];

/** Every emitted React error boundary, by path. */
function boundaryFiles(plan: EmitPlan): string[] {
  return [...plan.files.keys()].filter((path) => {
    const leaf = path.split(sep).at(-1);
    return (
      path.startsWith("app") && (leaf === "error.tsx" || leaf === "global-error.tsx")
    );
  });
}

describe("error and loading boundaries", () => {
  it.each(ALL_CONFIGURATIONS)("the base set is emitted for %s", async (_label, o) => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
    for (const path of BASE_BOUNDARIES) {
      expect(plan.files.has(path), `${path} is missing`).toBe(true);
    }
  });

  it("global-error renders its own html and body", async () => {
    // It REPLACES the root layout rather than rendering inside it, so a
    // fragment here produces a document with no root element — and the
    // stylesheet the root layout imported went with it, which is why the file
    // has to pull globals.css in again or render as unstyled HTML.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const source = plan.files.get(join("app", "global-error.tsx")) ?? "";
    expect(source).toContain("<html");
    expect(source).toContain("<body");
    expect(source).toContain("globals.css");
  });

  it.each(ADMIN_SHELLS)(
    "the admin shell brings its own, for --admin %s",
    async (adminShell) => {
      // The admin panel fails for different reasons than a public page and its
      // reader is the person who can fix it, so it gets its own boundary INSIDE
      // app/admin — which is also what keeps the sidebar on screen.
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell }));
      expect(plan.files.has(join("app", "admin", "error.tsx"))).toBe(true);
      expect(plan.files.has(join("app", "admin", "loading.tsx"))).toBe(true);
      expect(plan.files.has(join("app", "admin", "not-found.tsx"))).toBe(true);
    },
  );

  it("emits no admin boundary in a project with no admin shell", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "none" }));
    for (const path of plan.files.keys()) {
      expect(path.startsWith(join("app", "admin"))).toBe(false);
    }
  });

  it.each(SELLING_MODELS)(
    "checkout gets its own, for --model %s",
    async (businessModel) => {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel }));
      expect(plan.files.has(join("app", "(site)", "checkout", "error.tsx"))).toBe(true);
      expect(
        plan.files.has(join("app", "(site)", "checkout", "success", "error.tsx")),
      ).toBe(true);
    },
  );

  it("never tells a customer who has paid that nothing was charged", async () => {
    // The boundary above /checkout says this failure took no money, which is
    // true there. /checkout/success is only reached AFTER Stripe took the
    // payment, so inheriting that sentence would tell somebody who has already
    // been charged to pay again. It is a different fact, so it is a different
    // file — and this is the assertion that stops the two being merged.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    const success =
      plan.files.get(join("app", "(site)", "checkout", "success", "error.tsx")) ?? "";
    expect(success).toContain("Do not pay again");
    expect(success).not.toMatch(/did not take a payment|nothing was confirmed/);
  });

  it("emits no checkout boundary in a project that takes no money", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "none" }));
    expect(plan.files.has(join("app", "(site)", "checkout", "error.tsx"))).toBe(false);
  });

  it.each(ALL_CONFIGURATIONS)(
    "every boundary has a way back that exists, for %s",
    async (_label, o) => {
      // The general form of the bug the nav work killed, in the one place it
      // hurts most: a boundary is what somebody reaches when everything else has
      // already failed, and a link to a route this configuration never installed
      // makes that screen a dead end.
      //
      // Kept as its own test even though the whole-plan scan now covers `href:`
      // as well as `href=` and therefore subsumes it. It used to be scoped this
      // way because the admin sidebar carried permission-gated links to pages
      // from other overlays and the wider scan could not have passed — which is
      // the exception that hid two dead links for four configurations. What
      // this earns now is the failure MESSAGE: "sends people to" names a dead
      // end on the one screen where a dead end is unrecoverable.
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
      const patterns = routePatternsIn(plan);
      const paths = [
        ...boundaryFiles(plan),
        ...[...plan.files.keys()].filter((p) => p.endsWith("not-found.tsx")),
      ];
      expect(paths.length).toBeGreaterThan(0);

      let checked = 0;
      for (const path of paths) {
        const source = withoutComments(plan.files.get(path) ?? "");
        // Both spellings: `href="/x"` in markup, and `href: "/x"` in the prop
        // object a boundary hands to ErrorScreen.
        for (const match of source.matchAll(/href\s*[:=]\s*"(\/[^"]*)"/g)) {
          const href = match[1];
          if (href === undefined) continue;
          checked += 1;
          expect(resolves(href, patterns), `${path} sends people to ${href}`).toBe(true);
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
  );

  it("reads the 404's map from nav.ts rather than writing one out", async () => {
    // An unmatched URL renders app/not-found.tsx inside the ROOT layout, with no
    // header and no footer, so the page has to carry its own way out. A
    // hardcoded list would 404 in whichever configuration declined the feature.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "none" }));
    const source = plan.files.get(join("app", "not-found.tsx")) ?? "";
    expect(source).toContain('from "@/nav"');
    expect(source).toContain("SITE_LINKS");
  });
});

describe("nothing reported before this", () => {
  it.each(ALL_CONFIGURATIONS)(
    "every client boundary reports, for %s",
    async (_label, o) => {
      // A boundary that renders a polite apology and records nothing is worse
      // than no boundary: the page looks handled and nobody ever learns it broke.
      // Reporting lives inside ErrorScreen precisely so a new boundary cannot be
      // written without it, and this asserts every boundary goes through it.
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
      const boundaries = boundaryFiles(plan);
      expect(boundaries.length).toBeGreaterThan(0);
      for (const path of boundaries) {
        expect(plan.files.get(path), `${path} renders no reporting boundary`).toContain(
          "<ErrorScreen",
        );
      }

      const screen = plan.files.get(join("src", "components", "ErrorScreen.tsx")) ?? "";
      expect(screen).toContain("reportClientError");
      expect(screen).toContain("useEffect");
    },
  );

  it.each(ALL_CONFIGURATIONS)(
    "the endpoint exists wherever something posts to it, for %s",
    async (_label, o) => {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(o));
      const callers = [...plan.files].filter(([, source]) =>
        source.includes("/api/error-report"),
      );
      expect(callers.length).toBeGreaterThan(0);
      expect(
        plan.files.has(join("app", "api", "error-report", "route.ts")),
        "a client boundary posts to a route this configuration does not emit",
      ).toBe(true);
    },
  );

  it("carries the digest, which is the only join back to the server log", async () => {
    // In production React refuses to send the real error to the browser: the
    // boundary gets a generic message and a digest, and the server has already
    // logged the truth against that same digest. Drop it and the two records
    // exist and cannot be matched.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.get(join("src", "report-error.ts"))).toContain("digest");
    expect(plan.files.get(join("src", "components", "ErrorScreen.tsx"))).toContain(
      "error.digest",
    );
    const route = plan.files.get(join("app", "api", "error-report", "route.ts")) ?? "";
    expect(route).toContain("digest: body.digest");
  });

  it("keeps the report endpoint rate limited and closed to other origins", async () => {
    // It is an unauthenticated write, deliberately — the errors worth having are
    // on public pages, and on a page whose render failed the auth path is one of
    // the suspects. So it is bounded instead.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const route = plan.files.get(join("app", "api", "error-report", "route.ts")) ?? "";
    // Through the package's limiter, not a second one assembled here. This route
    // called `checkRateLimit` against a store that `src/server/rate-limit.ts`
    // built itself — an entire Upstash adapter written out beside the one
    // already published in `createRateLimiter`.
    expect(route).toContain("failClosedLimiter");
    expect(route).toContain("rateLimitHeaders");
    expect(route).toContain("status: 429");
    expect(route).toContain("status: 403");
    // Fail closed is the LIMITER'S construction argument now rather than a
    // try/catch here, so an unreachable store and an over-budget caller get the
    // same 429 — deliberate: nothing the client could do differs between them,
    // and the distinction is in the warning the limiter logs.
    expect(plan.files.get(join("src", "server", "rate-limit.ts")) ?? "").toContain(
      'onStoreFailure: "deny"',
    );
  });

  it("installs the limiter on the procedure ladder, not just beside it", async () => {
    // The defect this pins: `createRateLimiter`, `RATE_LIMIT_POLICIES` and the
    // ladder's `rateLimit` option all shipped, all tested, and
    // `createProcedures(t, loaders)` was called with two arguments — so no
    // procedure in any generated project was ever measured against a budget.
    // Absence is not a flag inside the chain; it is no middleware at all, which
    // is exactly why nothing failed.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const trpc = plan.files.get(join("src", "server", "trpc.ts")) ?? "";
    expect(trpc).toContain("rateLimit: { limiter }");
    const limiter = plan.files.get(join("src", "server", "rate-limit.ts")) ?? "";
    expect(limiter).toContain("createRateLimiter(");
    // One implementation of the Upstash pipeline in this project, and it is not
    // this one. A second copy is where a fix to the timeout, to the expiry
    // command or to the malformed-reply guard lands in one place and not the
    // other. Asserted on the CODE rather than on words: the block comment names
    // the commands to explain what it no longer does, and a test that forbade
    // the word would forbid saying why.
    const code = withoutComments(limiter);
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("INCR");
    expect(code).not.toContain("pipeline");
  });

  it.each(SELLING_MODELS)(
    "bounds both webhook routes, after the signature, for --model %s",
    async (businessModel) => {
      // Keyed by provider, because Stripe and Clerk deliver from a pool of
      // addresses and a per-address limit bounds nothing. That only works after
      // verification — limiting first would let anyone on the internet spend
      // the budget and have genuine events refused.
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel }));
      for (const provider of ["clerk", "stripe"]) {
        const route =
          plan.files.get(join("app", "api", "webhooks", provider, "route.ts")) ?? "";
        expect(route, `${provider} webhook is unbounded`).toContain(
          "RATE_LIMIT_POLICIES.webhook",
        );
        expect(route).toContain('key: "webhook:');
        const limitAt = route.indexOf("limiter.limit");
        const verifyAt = route.indexOf("bad signature");
        expect(
          verifyAt >= 0 && limitAt > verifyAt,
          `${provider} limits before it verifies, so a stranger can spend the budget`,
        ).toBe(true);
      }
    },
  );

  it("reports tRPC faults, and only faults", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const route =
      plan.files.get(join("app", "api", "trpc", "[trpc]", "route.ts")) ?? "";
    expect(route).toContain("onError");
    expect(route).toContain("reportError");
    expect(route).toContain('source: "trpc"');
    // FORBIDDEN and BAD_REQUEST are the ladder and the schema working. Recording
    // them buries the genuine faults under a table of correct refusals.
    expect(route).toContain("INTERNAL_SERVER_ERROR");
  });

  it.each(SELLING_MODELS)(
    "both webhook routes report, for --model %s",
    async (businessModel) => {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel }));
      for (const provider of ["clerk", "stripe"]) {
        const route =
          plan.files.get(join("app", "api", "webhooks", provider, "route.ts")) ?? "";
        expect(route, `${provider} webhook does not report`).toContain("reportError");
        expect(route).toContain('source: "webhook"');
      }
    },
  );

  it("does not report a bad webhook signature", async () => {
    // Anyone on the internet can produce one, so recording it would let a
    // stranger write rows into the error log at will.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const route =
      plan.files.get(join("app", "api", "webhooks", "clerk", "route.ts")) ?? "";
    const upToRejection = route.slice(0, route.indexOf("bad signature"));
    expect(upToRejection).not.toContain("reportError({");
  });

  it("attaches the request id at every server producer", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    for (const path of [
      join("app", "api", "webhooks", "clerk", "route.ts"),
      join("app", "api", "webhooks", "stripe", "route.ts"),
      join("app", "api", "error-report", "route.ts"),
    ]) {
      expect(plan.files.get(path), `${path} reports without a request id`).toContain(
        "resolveRequestId(req.headers)",
      );
    }
    // The tRPC handler takes it off the CONTEXT the middleware ran under rather
    // than re-deriving it — that is the whole purpose of `ctx.requestId`, and
    // no emitted file read it before.
    const trpcRoute =
      plan.files.get(join("app", "api", "trpc", "[trpc]", "route.ts")) ?? "";
    expect(trpcRoute).toContain("ctx?.requestId");
    expect(trpcRoute).toContain("requestId,");

    // Minted in one place. An id per handler is a different id per hop, which
    // joins nothing to anything.
    expect(plan.files.get("proxy.ts")).toContain("REQUEST_ID_HEADER");
  });

  it("keeps ONE request-id implementation, and it is the package's", async () => {
    // This project shipped `src/request-id.ts`, a dependency-free copy kept for
    // the edge proxy. The copy drifted exactly where it mattered: it never
    // validated the inbound header, so a newline in `x-request-id` was a log
    // injection — two records to the aggregator, the second saying whatever
    // the caller wanted. `resolveRequestId` bounds the length and the character
    // set, and the proxy reaches it over an edge-safe subpath that imports
    // nothing, which is the constraint the copy existed to work around.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" }));
    expect(plan.files.has(join("src", "request-id.ts"))).toBe(false);

    const proxy = plan.files.get("proxy.ts") ?? "";
    expect(proxy).toContain('from "@adminigloo/observability/request"');
    // The barrel would drag pino into the edge bundle and the build would fail.
    expect(proxy).not.toContain('from "@adminigloo/observability"');

    for (const [path, contents] of plan.files) {
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
      expect(
        withoutComments(contents),
        `${path} still imports the deleted local request-id module`,
      ).not.toContain('from "@/request-id"');
    }
  });

  it("carries the request id from the context into the log and the error row", async () => {
    // The join, hop by hop: the proxy stamps the header, `createScaffoldContext`
    // reads it onto `ctx.requestId`, `requestLog` puts it on every line, and
    // `reportError` writes the same value into the error_log row. Break any hop
    // and /admin/errors is a list of messages with no way back into the logs.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(plan.files.get(join("src", "server", "trpc.ts"))).toContain(
      "headers: input.headers ?? null",
    );
    expect(plan.files.get(join("src", "trpc", "server.ts"))).toContain(
      "headers: await headers()",
    );
    const route =
      plan.files.get(join("app", "api", "trpc", "[trpc]", "route.ts")) ?? "";
    expect(route).toContain("createContext({ headers: request.headers })");
    expect(route).toContain("requestLog(requestId)");
    expect(plan.files.get(join("src", "server", "logger.ts"))).toContain(
      "log.child({ requestId })",
    );
  });
});

const BUSINESS_MODELS = ["none", ...SELLING_MODELS] as const;

describe("the observability env contract", () => {
  it.each(BUSINESS_MODELS)(
    "SENTRY_DSN reaches env.ts and .env.example for --model %s",
    (businessModel) => {
      // observabilityServer() was the one installed package's fragment that was
      // never spread. The variables it declares therefore existed in no project's
      // contract: /setup could not report on them and the rate limiter could not
      // be pointed at a shared store.
      const a = answers({ businessModel });
      const module = renderEnvModule(a);
      expect(module).toContain("observabilityServer()");
      expect(module).toContain("SENTRY_DSN: process.env.SENTRY_DSN");
      expect(renderEnvExample(a)).toContain("SENTRY_DSN=");
    },
  );

  it("declares the Upstash pair the rate limiter actually reads", () => {
    const module = renderEnvModule(answers());
    for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      expect(module).toContain(`${name}: process.env.${name}`);
      expect(renderEnvExample(answers())).toContain(`${name}=`);
    }
  });

  it("surfaces the groups on /setup the way every other group is surfaced", () => {
    const module = renderEnvModule(answers());
    expect(module).toContain("OBSERVABILITY_ENV_GROUPS.sentry");
    expect(module).toContain("OBSERVABILITY_ENV_GROUPS.upstash");
    // Named from the exported constant, never retyped. A group that gains a
    // member has to gain it in the report as well as in the check, and spelling
    // the strings out here is exactly how those two drift apart.
    expect(module).not.toContain('vars: ["SENTRY_DSN"]');
  });

  it("keeps the optional keys out of the list that says the app will not boot", () => {
    // `nextSteps` introduces requiredEnvFor with "the app will not boot until
    // these are set". Three optional keys in there makes the sentence false, and
    // people then skim the two lines that were load-bearing.
    const required = requiredEnvFor(answers());
    const optional = optionalEnvFor(answers());
    for (const name of [
      "SENTRY_DSN",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]) {
      expect(optional).toContain(name);
      expect(required).not.toContain(name);
    }
    expect(nextSteps(answers(), "/out/acme")).not.toContain("SENTRY_DSN");
  });
});

/**
 * The zero-credential promise, at the point where it was actually broken.
 *
 * A generated project boots with nothing set. Every page either works or says
 * plainly what is missing; none of them 500s. That held everywhere except the
 * storefront — and the storefront is linked from the header and the footer of
 * every page, so on a fresh clone it is the first thing anyone clicks.
 *
 * The reason it broke is worth writing a test around rather than just fixing.
 * Those pages did try to handle a missing database: they caught the read and
 * asked whether the error was named `DatabaseNotConfiguredError`. But the read
 * goes through `api()`, and a tRPC caller wraps anything a procedure throws in
 * a `TRPCError` whose own name is "TRPCError" and whose `cause` holds the
 * original. The test therefore never matched, the rethrow fired, and the page
 * 500d. Sniffing an error's identity through a layer that re-wraps errors is
 * the pattern; `isDbConfigured(db)`, asked before anything queries, is the one
 * the admin pages already used and the one every page uses now.
 */
describe("nothing 500s on a project with no credentials", () => {
  const WIDEST: Partial<Answers> = {
    businessModel: "both",
    adminShell: "full",
    includeAi: true,
    includeEmail: true,
  };

  it("asks the database handle before it reads, on every public page that reads", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers(WIDEST));
    let checked = 0;

    for (const [path, contents] of plan.files) {
      if (!path.startsWith(join("app", "(site)"))) continue;
      if (!path.endsWith("page.tsx")) continue;
      const source = withoutComments(contents);
      const read = source.indexOf("api()");
      if (read < 0) continue;

      checked += 1;
      const guard = source.indexOf("isDbConfigured(db)");
      expect(
        guard >= 0 && guard < read,
        `${path} reads through the tRPC caller with no isDbConfigured(db) ` +
          `guard before it. With no DATABASE_URL the stand-in handle throws, ` +
          `the caller wraps the throw in a TRPCError, and the page 500s on a ` +
          `project generated with no credentials at all.`,
      ).toBe(true);
    }

    // Guards the loop. The storefront and the checkout are the pages this is
    // about; if the path prefix or the caller's spelling ever changes, the loop
    // finds nothing and passes for ever.
    expect(checked, "no public page reads through api() — has the scan rotted?").toBeGreaterThan(
      1,
    );
  });

  it("never decides there is no database by looking at an error it read through tRPC", async () => {
    // The mechanism, not the symptom, and scoped to where the mechanism fails.
    // Matching on `error.name` is the RIGHT way to recognise a typed error
    // across the ESM/CJS duplication @adminigloo/db warns about, and the admin
    // pages that call `currentPrincipal()` directly still do it as a belt to
    // their braces. What defeats it is the CALLER: `api()` wraps whatever a
    // procedure throws, so in a file that reads through tRPC the name is never
    // the one being tested and the rethrow always fires.
    for (const [, overrides] of ALL_CONFIGURATIONS) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      for (const [path, contents] of plan.files) {
        if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
        const source = withoutComments(contents);
        if (!source.includes("api()")) continue;

        expect(
          source.includes('name === "DatabaseNotConfiguredError"'),
          `${path} reads through the tRPC caller AND recognises a missing ` +
            `database from a thrown error's name. The caller re-wraps errors, ` +
            `so the name does not survive the trip and the check never ` +
            `matches: ask isDbConfigured(db) before reading instead.`,
        ).toBe(false);
        expect(
          source.includes("isDatabaseUnconfigured("),
          `${path} calls isDatabaseUnconfigured, which was removed for being ` +
            `unable to see through a TRPCError.`,
        ).toBe(false);
      }
    }
  });
});

/**
 * ASSERTIONS ARE ABOUT CODE, NOT ABOUT PROSE.
 *
 * Everything above works one way: generate a project, and grep the emitted
 * source for a string. That method has one failure mode, and this suite shipped
 * it twice. `expect(source).toContain("escapeHtml")` was written to prove the
 * invitation body escapes what it interpolates — and the only `escapeHtml` left
 * in that file is inside the block comment recording that the helper was
 * DELETED. The check passed on its subject's obituary, and would have gone on
 * passing had the body been replaced with raw string concatenation, which is
 * the single thing it existed to catch. The Clerk header's
 * `toContain("<SignedIn>")` was the same shape pointing the other way:
 * satisfied by the warning that says never to use `<SignedIn>`, and therefore
 * green on the day somebody used one.
 *
 * Comments in this scaffold are long and they restate what the code does, which
 * is exactly what makes a grep over raw source unreliable — the more carefully
 * a file explains itself, the more assertions it can satisfy while doing
 * nothing. So the rule is mechanical: every literal this suite greps for must
 * appear in the CODE of some emitted file, or nowhere in the emitted project at
 * all — the second case being an assertion whose subject is something else, a
 * directory listing or a value the test built itself. A literal that exists
 * only inside comments is a tautology, and it is either named below with a
 * reason or it is a bug.
 */
const ASSERTED_AGAINST_PROSE: Readonly<Record<string, string>> = {
  "<SignedIn>":
    "the Clerk Core 3 warning, and the one assertion in this suite whose " +
    "subject genuinely is a comment. It is read through `commentsIn` at the " +
    "call site, and the same test asserts the CODE does not contain it.",
  ".gitignore":
    "read off `readdir` of a written project rather than out of a file. It " +
    "also happens to be named in a comment in app/globals.css, which is the " +
    "only reason the scan sees it at all.",
};

/**
 * Every `toContain("…")` in the suite that only a comment satisfies.
 *
 * A function rather than an inline loop so the test below can run it against a
 * fixture. A scan that reports nothing when it works and nothing when it has
 * rotted is indistinguishable from the outside, which is the failure this whole
 * section is about.
 */
function commentOnlyLiterals(
  suiteSource: string,
  emitted: readonly string[],
): string[] {
  const code = emitted.map(withoutComments);
  const offenders: string[] = [];

  // This suite's OWN comments quote the assertions they are about — including
  // the one this scan exists to have removed. They are blanked first, in place,
  // so the line numbers it reports still point at the file.
  const suiteCode = suiteSource
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");

  suiteCode.split("\n").forEach((line, index) => {
    if (line.includes(".not.toContain(")) return;
    const literals = line.matchAll(
      /\btoContain\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g,
    );
    for (const match of literals) {
      const raw = match[1] ?? match[2] ?? "";
      const needle = raw
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
      if (needle in ASSERTED_AGAINST_PROSE) continue;
      // Absent from the generated project entirely, so the assertion's subject
      // is not emitted source and this scan has nothing to say about it.
      if (!emitted.some((file) => file.includes(needle))) continue;
      if (code.some((file) => file.includes(needle))) continue;
      offenders.push(`line ${index + 1}: toContain(${JSON.stringify(needle)})`);
    }
  });

  return offenders;
}

describe("this suite's own assertions", () => {
  /**
   * The widest project and the narrowest. Between them they emit every file the
   * generator can write, and both variants of every file it composes.
   */
  async function emittedCorpus(): Promise<string[]> {
    const corpus: string[] = [];
    for (const overrides of [
      { businessModel: "both", adminShell: "full", includeAi: true, includeEmail: true },
      { businessModel: "none", adminShell: "none", includeAi: false, includeEmail: false },
    ] as const) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      corpus.push(...plan.files.values());
    }
    return corpus;
  }

  it("greps for nothing that only a comment provides", async () => {
    const suite = await readFile(join(__dirname, "cli.test.ts"), "utf8");
    const offenders = commentOnlyLiterals(suite, await emittedCorpus());

    expect(
      offenders,
      `Every occurrence of these strings in the generated project is inside a ` +
        `comment, so the assertion passes on prose and would keep passing if ` +
        `the code it is about were deleted:\n  ${offenders.join("\n  ")}\n` +
        `Assert against withoutComments(...) instead — or, if the comment ` +
        `really is the subject, read it through commentsIn(...) and add a row ` +
        `to ASSERTED_AGAINST_PROSE saying why.`,
    ).toEqual([]);
  });

  it("still catches the tautology it was written for", async () => {
    // The fixture is the original assertion, spelled through a variable so the
    // scan above does not find it in this file and report itself.
    const needle = "escapeHtml";
    const fixture = `    expect(source).toContain(${JSON.stringify(needle)});`;
    const corpus = await emittedCorpus();

    // The premise: `escapeHtml` is in the generated project, and only in prose.
    expect(corpus.some((file) => file.includes(needle))).toBe(true);
    expect(corpus.some((file) => withoutComments(file).includes(needle))).toBe(false);

    expect(commentOnlyLiterals(fixture, corpus)).toHaveLength(1);
    // And the negative control, so this is a test of the scan rather than of
    // the string: the same line against a corpus where the code does contain it.
    expect(commentOnlyLiterals(fixture, [`const ${needle} = 1;`])).toEqual([]);
  });
});
