/**
 * Review round 2 (Tenancy 1): what a buyer's generated project says and does,
 * where round 2 found it wrong. Each `describe` names the finding.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, deferredUntilDeployedFor, type Answers } from "../answers.js";
import { addNextSteps, planAdd } from "../add.js";
import { nextSteps } from "../cli.js";
import { DEPLOY_REQUIRED_ENV_MARKER, planEmit, writePlan, type EmitPlan } from "../emit.js";
import { TENANCY_1_NOT_INCLUDED } from "../readme-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "lawnco", ...overrides };
}

function get(plan: EmitPlan, ...segments: string[]): string {
  const contents = plan.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

const COMPANIES = answers({ tenantNoun: "Company", adminShell: "full", includeEmail: true });
const SINGLE = answers({ tenantNoun: "none", adminShell: "minimal" });

describe("TB2-01: the emitted isolation test can't be satisfied by a procedure that reads by another id", () => {
  it("offers both kinds, checks a tenant-only procedure's input takes nothing else, and names both in its failure", async () => {
    const test = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain('{ readonly kind: "by-id"; readonly input: (f: typeof fx) => Record<string, unknown>; readonly expect: "not-found" | "empty" }');
    expect(test).toContain("acceptsInput(entry.procedure, input)");
    expect(test).toContain('is marked "tenant-only" but needs more than the company\'s id');
    expect(test).toContain('or { kind: "by-id"');
    // Mutations are proved too (by-id ones are called; tenant-only ones have their input checked).
    expect(test).not.toContain('isolation?.kind === "tenant-only" && type === "query"');
  });

  it("gives the billing procedures (which take a plan, not a company's row) their globals", async () => {
    const test = get(await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both" })), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain('"billing.subscribeToPlan": { kind: "tenant-only", globals: { tierKey: "starter", interval: "month", currency: "usd" } }');
  });
});

describe("TB2-02: DEPLOYMENT.md lists what a deployment won't start without", () => {
  it("a per-project table from the env module's own list, and no 'exactly one place' for the production URL", async () => {
    for (const a of [COMPANIES, answers({ includeEmail: false })]) {
      const doc = get(await planEmit(TEMPLATE_DIR, "/out", a), "DEPLOYMENT.md");
      expect(doc).not.toContain(DEPLOY_REQUIRED_ENV_MARKER);
      expect(doc).toContain("Vercel needs these in BOTH scopes, or the build refuses to start");
      for (const name of deferredUntilDeployedFor(a)) expect(doc, name).toContain(`| \`${name}\` |`);
      expect(doc).not.toContain("exists in exactly one place");
    }
    expect(get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "DEPLOYMENT.md")).toContain("| `EMAIL_FROM` |");
    expect(get(await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: false })), "DEPLOYMENT.md")).not.toContain("| `EMAIL_FROM` |");
  });
});

describe("TB2-03: how a buyer gets read access to the private packages", () => {
  it("says classic PAT, an account given access, and 404 vs 401", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    const readme = get(plan, "README.md");
    expect(readme).toContain("## Private packages");
    expect(readme).toContain("**classic** personal access token");
    expect(readme).toContain("`404 Not Found`");
    expect(readme).toContain("`401 Unauthorized`");
    const doc = get(plan, "DEPLOYMENT.md");
    expect(doc).toContain("A **classic** personal access token with the `read:packages` scope");
    expect(doc).toContain("fails with 404 from `npm.pkg.github.com`");
  });
});

describe("TB2-04: the quick start works in the order it's written", () => {
  it("runs the app before the database steps, and says to set the database first", async () => {
    const readme = get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "README.md");
    const dev = readme.indexOf("`pnpm dev`");
    const migrate = readme.indexOf("`pnpm db:generate && pnpm db:migrate`");
    expect(dev).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(dev);
    expect(readme.slice(dev, migrate)).toContain("`DATABASE_URL_UNPOOLED`");
    const steps = nextSteps(SINGLE, "/out/lawnco");
    expect(steps.indexOf("pnpm dev")).toBeLessThan(steps.indexOf("pnpm db:migrate"));
  });
});

describe("TB2-05: Deployment Protection", () => {
  it("names the exception by name and says the bypass alone leaves invitees on Vercel's login", async () => {
    const doc = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "DEPLOYMENT.md");
    expect(doc).toContain("Deployment Protection Exceptions → Add Domain");
    expect(doc.replace(/\s+/g, " ")).toContain("is NOT enough on its own");
  });
});

describe("TB2-06: companies + field service says who the features are for, up front", () => {
  it("in the README's first paragraph and the next steps", async () => {
    const a = answers({ tenantNoun: "Company", adminShell: "full", includeScheduling: true, includeEstimator: true, includeEmail: true, includeComms: true });
    const readme = get(await planEmit(TEMPLATE_DIR, "/out", a), "README.md");
    const firstParagraph = readme.split("\n\n")[1] ?? "";
    expect(firstParagraph).toContain("run for you, the platform owner");
    expect(firstParagraph).toContain("not with each company");
    expect(nextSteps(a, "/out/x")).toContain("pages book with YOUR business, not");
  });
});

describe("TB2-07: a single-business project isn't told about company pages", () => {
  it("leaves the company-only 'Not included' items out, and its checklist links nowhere", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", SINGLE);
    const readme = get(plan, "README.md");
    expect(readme).not.toContain("Public company pages");
    expect(readme).not.toContain("Converting a legacy personal workspace");
    expect(readme).toContain(TENANCY_1_NOT_INCLUDED[2]!);
    expect(get(plan, "src", "server", "setup-checklist.ts")).not.toContain("/settings/company");
    const companies = await planEmit(TEMPLATE_DIR, "/out", COMPANIES);
    for (const item of TENANCY_1_NOT_INCLUDED) expect(get(companies, "README.md")).toContain(item);
  });
});

describe("TB2-08: `add email` tells the same truth as a fresh generation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adminigloo-r2-add-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("only EMAIL_FROM is boot-required; RESEND_API_KEY switches the feature on", async () => {
    await writePlan(await planEmit(TEMPLATE_DIR, dir, answers({ includeEmail: false, adminShell: "full" })));
    const plan = await planAdd(TEMPLATE_DIR, dir, "email");
    expect(plan.newRequiredEnv).toEqual(["EMAIL_FROM"]);
    expect(plan.newFeatureEnv).toContain("RESEND_API_KEY");
    const out = addNextSteps(plan);
    const required = out.slice(out.indexOf("A deployment refuses to start without"), out.indexOf("Each of these switches"));
    expect(required).toContain("EMAIL_FROM");
    expect(required).not.toContain("RESEND_API_KEY");
  });
});

describe("T1BO-06: the invite page an office manager sees first", () => {
  it("plain words: no scanners, no hashes, no 'keep this tab open'", async () => {
    const page = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "app", "(site)", "invite", "[token]", "page.tsx");
    const ui = page.slice(page.indexOf("export default async function InvitePage"));
    expect(ui).not.toMatch(/mail scanner|hash|Keep this tab open/);
    expect(ui).toContain("Use the email address the invitation was sent to.");
    expect(ui).toContain("You can come");
  });
});

describe("T1BO-11: the screens the platform owner and a crew lead land on", () => {
  it("the admin home speaks plainly and its companies tile opens the companies console", async () => {
    const home = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "app", "admin", "page.tsx");
    expect(home).not.toContain("Counts of rows this application writes");
    expect(home).not.toContain("Unresolved rows in error_log");
    expect(home).not.toContain("Hidden — you do not hold");
    expect(home).not.toContain("pnpm db:seed:demo");
    expect(home).toContain('href: "/admin/companies"');
  });

  it("a member's dashboard says what it's for; the product name reads as a name", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ tenantNoun: "Company", adminShell: "full", projectName: "igloo-back-office" }));
    expect(get(plan, "app", "(site)", "dashboard", "page.tsx")).toContain("data-member-note");
    expect(get(plan, "src", "seo.ts")).toContain('export const SITE_NAME = "Igloo Back Office";');
  });

  it("the local first run is described as it happens", () => {
    expect(nextSteps(COMPANIES, "/out/x")).toContain("the first person to sign in becomes the");
  });
});
