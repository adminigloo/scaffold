import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWERS,
  InvalidProjectNameError,
  isPersonalWorkspaceOnly,
  packagesFor,
  requiredEnvFor,
  tenantLabel,
  validateProjectName,
  type Answers,
} from "../answers.js";
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
  planEmit,
  renderEnvExample,
  renderPackageJson,
  renderScaffoldRecord,
  renderEnvModule,
  renderSchemaModule,
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

  it("adds commerce for one-time purchases and billing for subscriptions", () => {
    const once = packagesFor(answers({ businessModel: "one-time" }));
    expect(once).toContain("@adminigloo/commerce");
    expect(once).not.toContain("@adminigloo/billing");

    const sub = packagesFor(answers({ businessModel: "subscription" }));
    expect(sub).toContain("@adminigloo/billing");
    expect(sub).not.toContain("@adminigloo/commerce");

    const both = packagesFor(answers({ businessModel: "both" }));
    expect(both).toContain("@adminigloo/commerce");
    expect(both).toContain("@adminigloo/billing");
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
    ).toBe("Companys");
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

  it("runs the Stripe listener beside next dev, so webhooks get exercised", () => {
    const withMoney = JSON.parse(
      renderPackageJson(answers({ businessModel: "one-time" })),
    );
    expect(withMoney.scripts.dev).toContain("stripe listen");
    expect(withMoney.devDependencies).toHaveProperty("concurrently");
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
  it("records every answer, so a later diff has something to diff against", () => {
    const out = renderScaffoldRecord(answers({ businessModel: "both", adminShell: "full" }));
    expect(out).toContain("both");
    expect(out).toContain("full");
    expect(out).toContain("Forked modules");
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

  it("leaves no unsubstituted token in the overlay files either", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    for (const [path, contents] of plan.files) {
      expect(contents, `${path} still has a token`).not.toMatch(/__[A-Z_]+__/);
    }
  });

  it("declares every staff permission the admin nav gates on", async () => {
    // A nav item whose permission is missing from the catalog is invisible to
    // everyone, forever, with no error anywhere.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell: "full" }));
    const nav = plan.files.get(
      join("src", "components", "admin", "AdminNav.tsx"),
    );
    const catalog = plan.files.get(join("src", "permissions", "catalog.ts"));
    expect(nav).toBeDefined();
    expect(catalog).toBeDefined();

    const referenced = [...(nav ?? "").matchAll(/permission: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(catalog, `catalog is missing ${key}`).toContain(`"${key}"`);
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
    for (const pkg of ["auth", "tenancy", "permissions", "observability", "stripe", "catalog", "ai", "email"]) {
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
