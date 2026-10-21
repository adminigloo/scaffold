/**
 * Tenancy 1's wiring in the generator (contract 12 and 13.6), and the review
 * findings it closes. Each `describe` names what a generated project would get
 * wrong without it.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, TENANT_NOUNS, type Answers } from "../answers.js";
import { nextSteps } from "../cli.js";
import { planEmit, renderEnvModule, renderPackageJson, renderPermissionsCatalog, renderScaffoldRecord, THIRD_PARTY_PINS, type EmitPlan } from "../emit.js";
import { buildManifest } from "../manifest.js";
import { ROUTER_SCOPES, TENANT_PROCEDURES } from "../tenancy-proofs-emit.js";
import { projectReservedSlugs } from "../tenancy-emit.js";
import { TENANCY_1_NOT_INCLUDED } from "../readme-emit.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");
const OVERLAYS_DIR = join(__dirname, "..", "..", "overlays");
const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const REPO = join(PACKAGES_DIR, "..");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
}

function get(plan: EmitPlan, ...segments: string[]): string {
  const contents = plan.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

const COMPANIES = answers({ tenantNoun: "Company", adminShell: "full", businessModel: "both", includeEmail: true });
const SINGLE = answers({ tenantNoun: "none", adminShell: "minimal" });

describe("PC-19: every router has a scope row, and the rows match the routers", () => {
  /** Every overlay router file, as `overlay/src/server/routers/x.ts`. */
  const overlayRouters = readdirSync(OVERLAYS_DIR).flatMap((overlay) => {
    const dir = join(OVERLAYS_DIR, overlay, "src", "server", "routers");
    return existsSync(dir) ? readdirSync(dir).map((f) => `${overlay}/src/server/routers/${f}`) : [];
  });

  it("fails when an overlay router has no ROUTER_SCOPES row", () => {
    expect(overlayRouters.length).toBeGreaterThan(5);
    const covered = new Set(ROUTER_SCOPES.map((row) => row.source).filter(Boolean));
    for (const router of overlayRouters) {
      expect(covered.has(router), `${router} has no ROUTER_SCOPES row`).toBe(true);
    }
  });

  it("matches each row to the rungs its router actually uses", () => {
    const rungFor = { public: "publicProcedure", authenticated: "protectedProcedure", tenant: "requireTenant(", staff: "requireStaff(" } as const;
    for (const row of ROUTER_SCOPES) {
      if (row.source === null) continue;
      const source = readFileSync(join(OVERLAYS_DIR, row.source), "utf8");
      if (row.key.includes(".")) {
        // A path override: that procedure is built from that rung.
        const name = row.key.split(".")[1]!;
        const at = source.indexOf(`  ${name}: `);
        expect(at, `${row.key} is not in ${row.source}`).toBeGreaterThan(-1);
        expect(source.slice(at, at + 200), row.key).toContain(rungFor[row.scope]);
      } else {
        expect(source, `${row.key} should use ${rungFor[row.scope]}`).toContain(rungFor[row.scope]);
      }
    }
  });

  it("lists every tenant procedure an overlay router builds", () => {
    const listed = new Set(TENANT_PROCEDURES.map((p) => p.path));
    for (const router of overlayRouters) {
      const source = readFileSync(join(OVERLAYS_DIR, router), "utf8");
      const name = router.split("/").at(-1)!.replace(/\.ts$/, "");
      for (const match of source.matchAll(/^ {2}(\w+): requireTenant\(/gm)) {
        expect(listed.has(`${name}.${match[1]}`), `${name}.${match[1]} needs a TENANT_PROCEDURES row`).toBe(true);
      }
    }
  });

  it("emits the scope test and the isolation test into every project, with the rows it installed", async () => {
    for (const a of [COMPANIES, SINGLE]) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", a);
      const scopes = get(plan, "src", "server", "__tests__", "procedure-scopes.test.ts");
      expect(scopes).toContain("auditBuiltProcedures(inventoryOf(appRouter), EXPECTED_SCOPES)");
      expect(scopes).toContain('"members": "tenant"');
      const isolation = get(plan, "src", "server", "__tests__", "tenant-isolation.test.ts");
      expect(isolation).toContain('"members.list": { kind: "tenant-only" }');
      expect(isolation).toContain("Add an isolation case for");
    }
    const selling = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(selling).toContain('"billing.subscribeToPlan": { kind: "tenant-only", globals: ');
    const plain = get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(plain).not.toContain("billing.subscribeToPlan");
  });
});

describe("the permission catalog knows every key the tenancy package checks", () => {
  const permissionsSource = readFileSync(join(PACKAGES_DIR, "tenancy", "src", "permissions.ts"), "utf8");
  const routesSource = readFileSync(join(PACKAGES_DIR, "tenancy", "src", "server", "routes.ts"), "utf8");
  const staffKeys = [...permissionsSource.slice(permissionsSource.indexOf("TENANCY_STAFF_PERMISSION_KEYS")).matchAll(/"(staff\.[a-z.]+)"/g)].map((m) => m[1]!);
  const routeKeys = [...routesSource.matchAll(/permission: "([a-z.]+)"/g)].map((m) => m[1]!).filter((k) => k !== "fragment");

  it.each(TENANT_NOUNS)("declares every staff key and every route key for --tenant-noun %s", (tenantNoun) => {
    const catalog = renderPermissionsCatalog(answers({ tenantNoun }));
    const staff = catalog.slice(catalog.indexOf("const appStaffPermissions"));
    expect(staffKeys.length).toBeGreaterThanOrEqual(6);
    for (const key of staffKeys) expect(staff, key).toContain(`"${key}":`);
    // Tenant route keys come from `tenancyPermissions`, spread into the tenant catalog.
    const tenancyKeys = [...permissionsSource.matchAll(/^ {2}"([a-z.]+)": \{/gm)].map((m) => m[1]!);
    for (const key of routeKeys.filter((k) => !k.startsWith("staff."))) expect(tenancyKeys, key).toContain(key);
  });

  it("seals staff.roles.manage (review T1-05)", () => {
    const catalog = renderPermissionsCatalog(answers());
    const block = catalog.slice(catalog.indexOf('"staff.roles.manage"'), catalog.indexOf('"staff.audit.view"'));
    expect(block).toContain("sealed: true");
  });
});

describe("the generated project's wiring", () => {
  it("builds the service once, in the right mode, with the project's own name reserved", async () => {
    const companies = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "tenancy.ts");
    expect(companies).toContain('mode: "companies"');
    expect(companies).toContain('reservedSlugs: ["igloo-back-office","igloo"]');
    const single = get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "src", "server", "tenancy.ts");
    expect(single).toContain('mode: "personal"');
    expect(projectReservedSlugs(answers({ projectName: "ab" }))).toEqual([]);
  });

  it("provisions from the page AND the webhook, and only mirrors verified addresses (PC-01, T1-02)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    const auth = get(plan, "src", "server", "auth.ts");
    expect(auth).toContain("if (row.provisionedAt === null)");
    expect(auth).toContain("tenancy.provisionUser({ userId: row.id, email: row.email })");
    expect(auth).toContain('address.verification?.status === "verified"');
    expect(auth).not.toContain("ensurePersonalWorkspace");
    expect(auth).not.toContain("emailAddresses[0]");
    const webhook = get(plan, "app", "api", "webhooks", "clerk", "route.ts");
    expect(webhook).toContain("identityWebhookEvents");
    expect(webhook).toContain('skipped: "duplicate"');
    expect(webhook).toContain("tenancy.provisionUser(");
    expect(webhook).toContain("tenancy.deprovisionUser(");
    expect(webhook).toContain("isResurrection(event, existing)");
    // The safety checks keep their order: signature, rate limit, then work.
    expect(webhook.indexOf("verifyIdentityWebhook(body")).toBeLessThan(webhook.indexOf("limiter.limit("));
  });

  it("passes the CompaniesConsole a pattern string, never a function (TB-DEPLOY-13)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    expect(get(plan, "app", "admin", "companies", "page.tsx")).toContain("detailHref={ADMIN_COMPANY_DETAIL_HREF}");
    expect(get(plan, "src", "tenancy.ts")).toContain('export const ADMIN_COMPANY_DETAIL_HREF = "/admin/companies/{id}";');
  });

  it("puts the operator console and People in every admin shell (PC-04, TB-09)", async () => {
    for (const adminShell of ["minimal", "full"] as const) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ adminShell }));
      expect(get(plan, "app", "admin", "people", "page.tsx")).toContain("<StaffPeople");
      expect(get(plan, "app", "admin", "companies", "page.tsx")).toContain("<CompaniesConsole");
      expect(get(plan, "src", "components", "admin", "AdminNav.tsx")).toContain('href: "/admin/people"');
    }
  });

  it("self-heals the first administrator in /admin, with the recovery that works where it runs (TB-DEPLOY-08)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const layout = get(plan, "app", "admin", "layout.tsx");
    expect(layout).toContain("tenancy.ensureBootstrapAdmin(");
    expect(layout).toContain('"templates-missing" ? "not-seeded"');
    const unavailable = get(plan, "src", "components", "admin", "AdminUnavailable.tsx");
    // The signed-in person's own email in the command (create-app 0.39); the
    // workflow named only for a project that deploys from GitHub.
    expect(unavailable).toContain('const command = `pnpm admin:grant ${email ?? "you@example.com"}`;');
    expect(unavailable).toContain("if the project deploys from GitHub, the Admin grant workflow");
    expect(layout).toContain("deployed={!isLocalRun()} email={principal.email}");
    expect(unavailable).toContain("from People");
  });

  it("guards per-person overrides with the rank rules (T1-05), and proves it in the project", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const admin = get(plan, "src", "server", "routers", "admin.ts");
    expect(admin).toContain("await assertMayOverride({");
    expect(plan.files.has(join("src", "server", "__tests__", "admin-overrides.test.ts"))).toBe(true);
  });

  it("keeps sign-in and sign-up on the site, landing on AFTER_AUTH_PATH (TB-DEPLOY-11)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    expect(get(plan, "app", "layout.tsx")).toContain('signUpUrl="/sign-up"');
    expect(get(plan, "app", "layout.tsx")).toContain("signInFallbackRedirectUrl={AFTER_AUTH_PATH}");
    expect(get(plan, "app", "(site)", "sign-in", "[[...sign-in]]", "page.tsx")).toContain('back === null ? "/sign-up"');
    expect(get(plan, "app", "(site)", "sign-up", "[[...sign-up]]", "page.tsx")).toContain('back === null ? "/sign-in"');
    expect(get(plan, "src", "tenancy.ts")).toContain('AFTER_AUTH_PATH = "/dashboard"');
    expect(get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "src", "tenancy.ts")).toContain('AFTER_AUTH_PATH = "/"');
  });

  it("hides /setup on production except for staff (CA-18)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(get(plan, "app", "(site)", "setup", "page.tsx")).toContain('resolveAppEnv() === "production" && !(await viewerIsStaff())');
    expect(get(plan, "src", "nav.ts")).toContain('{ href: "/setup", label: "Setup", audience: "developer" }');
  });

  it("gives a companies project the company pages, and a single business none of them", async () => {
    const companies = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    for (const page of ["onboarding", "dashboard", join("settings", "company")]) {
      expect(companies.files.has(join("app", "(site)", page, "page.tsx")), page).toBe(true);
    }
    // The company's public face is in its own route group, outside the site's
    // chrome (Tenancy 2a review T2A-BO-01).
    expect(companies.files.has(join("app", "(company)", "t", "[slug]", "page.tsx"))).toBe(true);
    expect(companies.files.has(join("app", "(site)", "t", "[slug]", "page.tsx"))).toBe(false);
    const single = await planEmit(TEMPLATE_DIR, "/out", SINGLE);
    expect(single.files.has(join("app", "(site)", "onboarding", "page.tsx"))).toBe(false);
    expect(single.files.has(join("app", "(site)", "settings", "team", "page.tsx"))).toBe(true);
  });
});

describe("the deploy path a buyer follows (TB-DEPLOY-01..03)", () => {
  it("names the pnpm version every emitted workflow installs (TB-DEPLOY-02)", async () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { packageManager: string };
    expect(`pnpm@${THIRD_PARTY_PINS.pnpm}`).toBe(root.packageManager);
    const manifest = JSON.parse(renderPackageJson(answers())) as { packageManager?: string };
    expect(manifest.packageManager).toBe(root.packageManager);
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    for (const workflow of ["ci.yml", "deploy.yml"]) {
      const source = get(plan, ".github", "workflows", workflow);
      // action-setup reads `packageManager` when no `version:` is given.
      expect(source).toContain("pnpm/action-setup@v4");
    }
  });

  it("pins the PGlite range to the workspace packages' own", () => {
    const testing = JSON.parse(readFileSync(join(PACKAGES_DIR, "testing", "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(THIRD_PARTY_PINS.pglite).toBe(testing.devDependencies["@electric-sql/pglite"]);
    const manifest = JSON.parse(renderPackageJson(answers())) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies["@electric-sql/pglite"]).toBe(THIRD_PARTY_PINS.pglite);
  });

  it("installs private packages in CI with the token deploy.yml uses (TB-DEPLOY-03)", async () => {
    const ci = get(await planEmit(TEMPLATE_DIR, "/out", answers()), ".github", "workflows", "ci.yml");
    expect(ci).toContain("GITHUB_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}");
    expect(ci).toContain("NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_READ_TOKEN }}");
    const code = ci
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join(" ");
    expect(code).not.toContain("secrets.GITHUB_TOKEN");
  });

  it("seeds the catalog after every migration, and offers the admin grant by hand (PC-09, TB-DEPLOY-08)", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const deploy = get(plan, ".github", "workflows", "deploy.yml");
    expect(deploy.match(/- run: pnpm db:migrate:deploy[\s\S]*?- run: pnpm db:seed:deploy/g)).toHaveLength(2);
    expect(deploy).toContain("BOOTSTRAP_ADMIN_EMAIL: ${{ vars.BOOTSTRAP_ADMIN_EMAIL }}");
    expect(deploy).toContain("workflow_dispatch:");
    expect(deploy).toContain('pnpm admin:grant "$GRANT_EMAIL"');
    expect(deploy).toContain("if: github.event_name == 'push'");
    const pkg = JSON.parse(get(plan, "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:seed:deploy"]).toBe("tsx scripts/seed-deploy.ts");
    expect(pkg.scripts["admin:grant"]).toBe("tsx scripts/admin-grant.ts");
    expect(get(plan, "scripts", "seed-deploy.ts")).not.toMatch(/from "(@\/env|\.\.\/src\/env|\.\.\/src\/db)"/);
    expect(get(plan, "scripts", "seed-deploy.ts")).toContain("-pooler");
  });

  it("never builds invitation links from a per-deployment URL on production (TB-DEPLOY-05)", () => {
    const env = renderEnvModule(answers());
    expect(env).toContain('process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL');
    expect(env).toContain("SUPPORT_EMAIL: z.string().email().optional()");
  });

  it("documents the Clerk production instance, its webhook, Deployment Protection, email and first run", async () => {
    const doc = get(await planEmit(TEMPLATE_DIR, "/out", answers()), "DEPLOYMENT.md");
    for (const heading of [
      "### Clerk's Production instance",
      "### Clerk's webhook (one per instance)",
      "### `NEXT_PUBLIC_APP_URL` and Vercel's Deployment Protection",
      "### Email (invitations by email)",
      "### First run: roles, the first administrator, and getting back in",
    ]) {
      expect(doc, heading).toContain(heading);
    }
    expect(doc).toContain("/api/webhooks/clerk");
    expect(doc).toContain("`user.created`, `user.updated`, `user.deleted`");
    expect(doc).toContain('"verify email at sign-up"');
  });
});

describe("what the buyer reads first (CA-10, CA-11, TB-DEPLOY-14, T1-10, T1-12)", () => {
  it("never tells them to copy .env.example over the ready .env.local", () => {
    for (const a of [answers(), SINGLE, answers({ businessModel: "none" })]) {
      const out = nextSteps(a, "/out/igloo-back-office");
      expect(out).not.toContain("cp .env.example .env.local");
      expect(out).toContain("pnpm db:seed");
      expect(out).toContain("export GITHUB_TOKEN");
      expect(out).toContain("the first person to sign in becomes the");
      expect(out).toContain("A deployment refuses to start without:");
    }
  });

  it("says where a suspended company writes — and, with field service, that each company runs it (Tenancy 2a)", () => {
    const out = nextSteps(COMPANIES, "/out/x");
    expect(out).not.toContain("still run by your own staff");
    expect(out).toContain("SUPPORT_EMAIL");
    const withFeatures = nextSteps(answers({ ...COMPANIES, includeScheduling: true, includeInvoicing: true }), "/out/x");
    expect(withFeatures).toContain("Each company runs its own schedule, invoices at /app");
    expect(nextSteps(answers({ includeEmail: false }), "/out/x")).toContain("Invitations are copy-a-link until email is added");
  });

  it("tells a comms project the cron needs its secret", () => {
    expect(nextSteps(answers({ includeComms: true, adminShell: "minimal" }), "/out/x")).toContain(
      "Scheduled messages need CRON_SECRET in Vercel",
    );
  });

  it("emits a README with the quick start, first run and the Not included list, word for word", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    const readme = get(plan, "README.md");
    expect(readme).toContain("## Quick start");
    expect(readme).toContain("## First run and recovery");
    expect(readme).toContain("## Companies");
    for (const item of TENANCY_1_NOT_INCLUDED) expect(readme).toContain(item);
    expect(get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "README.md")).toContain("## Single business");
  });

  it("lists every answer in SCAFFOLD.md", () => {
    const a = answers({ includeEstimator: true, adminShell: "minimal" });
    const record = renderScaffoldRecord(buildManifest(a, "0.0.0-test"));
    for (const key of Object.keys(a) as (keyof Answers)[]) {
      if (key === "scope" || key === "projectName") continue;
      const rows = record.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Answer"));
      expect(rows.length, key).toBeGreaterThanOrEqual(Object.keys(a).length - 2);
    }
    expect(record).toContain("| Estimator | yes |");
    expect(record).toContain("| Scheduling | no |");
  });
});
