import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, packagesFor, personEmails, type Answers } from "../answers.js";
import { planEmit, schemaOwners, versionRangeFor, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * CONSUMER ROUND 5, PART 1 (create-app 0.40), from the review of the
 * founder's Almanac ("Fix in AdminIgloo", items 9 and 11):
 *
 *   1. each person's own emails — preferences, a daily digest from the
 *      sections the project registers, one-click unsubscribe, the staff
 *      preview — in a project whose customers are people and that sends email
 *   2. SEO by default, in every project — icons and a manifest from the name
 *      and the brand colour, the site's share card at a fixed address,
 *      llms-full.txt, one page list with a hook for database-backed pages,
 *      X-Robots-Tag and AI-crawler logging in the proxy, metadataFor on the
 *      generated pages, robots.txt as one group
 */
const sep = (path: string) => join(...path.split("/"));

const ALMANAC: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "almanac",
  tenantNoun: "none",
  audience: "consumers",
  businessModel: "subscription",
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
  includeFeedback: true,
  includeNotifications: true,
  includeMarketing: true,
  includeAnalytics: true,
  includeSeo: true,
};
const BUSINESS: Answers = { ...ALMANAC, audience: "business" };
const COMPANIES: Answers = { ...ALMANAC, tenantNoun: "Company", audience: "business" };
const BARE: Answers = { ...DEFAULT_ANSWERS, projectName: "bare", tenantNoun: "none", adminShell: "none" };

async function plan(answers: Answers): Promise<EmitPlan> {
  return planEmit(TEMPLATE_DIR, "/out", answers);
}
function file(p: EmitPlan, path: string): string {
  const body = p.files.get(sep(path));
  if (body === undefined) throw new Error(`the plan has no ${path}`);
  return body;
}
/** What the project RUNS: the file with its comments taken out. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const DIGEST_FILES = [
  "src/digests.ts",
  "src/server/digest.ts",
  "app/api/email/[...path]/route.ts",
  "app/api/cron/digest/route.ts",
  "app/(site)/unsubscribe/page.tsx",
  "app/(site)/account/email/page.tsx",
  "src/server/__tests__/digest.test.ts",
];

describe("each person's own emails: where they are", () => {
  it("only in a project whose customers are people and that sends email", () => {
    expect(personEmails(ALMANAC)).toBe(true);
    expect(personEmails({ ...ALMANAC, includeEmail: false })).toBe(false);
    expect(personEmails(BUSINESS)).toBe(false);
    expect(personEmails(COMPANIES)).toBe(false);
    expect(packagesFor(ALMANAC)).toContain("@adminigloo/digest");
    for (const other of [BUSINESS, COMPANIES, { ...ALMANAC, includeEmail: false }]) expect(packagesFor(other)).not.toContain("@adminigloo/digest");
  });

  it("pins the release lines that carry them (the line, never the patch)", () => {
    expect(versionRangeFor("@adminigloo/digest")).toMatch(/^\^0\.1\./);
    expect(versionRangeFor("@adminigloo/email")).toMatch(/^\^0\.5\./);
    expect(versionRangeFor("@adminigloo/seo")).toMatch(/^\^0\.3\./);
  });

  it("writes the files, the tables, the cron, the secret and the staff key", async () => {
    const p = await plan(ALMANAC);
    for (const path of DIGEST_FILES) expect(p.files.has(sep(path)), path).toBe(true);
    expect(schemaOwners(ALMANAC)).toContain("digest");
    expect(file(p, "src/db/schema.ts")).toContain('export * from "@adminigloo/digest/schema";');
    const crons = JSON.parse(file(p, "vercel.json")).crons as { path: string; schedule: string }[];
    expect(crons).toContainEqual({ path: "/api/cron/digest", schedule: "0 15 * * *" });
    const env = file(p, "src/env.ts");
    expect(env).toContain('EMAIL_LINK_SECRET: z.string().min(32, "at least 32 characters").optional()');
    expect(env).toContain("CRON_SECRET: z.string().min(1).optional()");
    expect(file(p, ".env.example")).toContain("EMAIL_LINK_SECRET=");
    expect(file(p, "src/permissions/catalog.ts")).toContain('"staff.digest.preview": {');
    expect(file(p, "DEPLOYMENT.md")).toContain("### Each person's emails and the morning digest");
    expect(file(p, "README.md")).toContain("### Each person's emails");
  });

  it("writes none of it anywhere else", async () => {
    for (const answers of [BUSINESS, COMPANIES, { ...ALMANAC, includeEmail: false }]) {
      const p = await plan(answers);
      for (const path of DIGEST_FILES) expect(p.files.has(sep(path)), `${answers.tenantNoun}/${answers.audience}: ${path}`).toBe(false);
      expect(code(file(p, "src/components/SignUpEmailSlot.tsx"))).toContain("return null;");
      expect(file(p, "src/permissions/catalog.ts")).not.toContain("staff.digest.preview");
      expect(file(p, "vercel.json")).not.toContain("/api/cron/digest");
    }
  });
});

describe("each person's own emails: what they do", () => {
  it("the glue sends through the site's mailer with the one-click headers and an idempotency key", async () => {
    const p = await plan(ALMANAC);
    const glue = code(file(p, "src/server/digest.ts"));
    expect(glue).toContain("headers: message.headers");
    expect(glue).toContain("idempotencyKey: message.idempotencyKey");
    expect(glue).toContain("idempotentSends: true");
    expect(glue).toContain('return outcome.status === "sent" ? { status: "sent" } : { status: "skipped", reason: "no-provider" };');
    // Who may be emailed: a person not deleted, with an address, whose own account isn't suspended or deleted.
    expect(glue).toContain("isNull(users.deletedAt), isNotNull(users.email)");
    expect(glue).toContain("isNull(tenants.suspendedAt), isNull(tenants.deletedAt)");
    // The preview's key.
    expect(glue).toContain('can?.can("staff.digest.preview")');
    const mail = code(file(p, "src/server/mail.ts"));
    expect(mail).toContain("...(email.headers ? { headers: email.headers } : {})");
    expect(mail).toContain("...(email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : {})");
    expect(mail).toContain("retryable: mayRetry(outcome.error)");
  });

  it("the links are never signed with a key written in the project: with neither secret, one made when the server starts", async () => {
    const p = await plan(ALMANAC);
    const glue = code(file(p, "src/server/digest.ts"));
    const linkSecret = glue.slice(glue.indexOf("function linkSecret()"), glue.indexOf("\n}", glue.indexOf("function linkSecret()")));
    expect(linkSecret).toContain("if (env.EMAIL_LINK_SECRET) return env.EMAIL_LINK_SECRET;");
    expect(linkSecret).toContain('return randomBytes(32).toString("hex");');
    // A key in the file would be every project's: anyone could sign anybody's link.
    expect(linkSecret).not.toMatch(/return\s*["'`]/);
    expect(file(p, "src/server/__tests__/digest.test.ts")).toContain("is never signed with a key anybody can read");
  });

  it("the cron ends by 50 seconds, refuses without CRON_SECRET, and says when people are still waiting", async () => {
    const p = await plan(ALMANAC);
    const cron = code(file(p, "app/api/cron/digest/route.ts"));
    expect(cron).toContain("export const maxDuration = 60;");
    expect(cron).toContain('return NextResponse.json({ error: "unauthorized" }, { status: 401 });');
    expect(cron).toContain("if (result.stoppedEarly)");
    expect(code(file(p, "src/server/digest.ts"))).toContain("const CRON_BUDGET_MS = 50_000;");
  });

  it("the unsubscribe page asks first, works signed out, and is never indexed", async () => {
    const p = await plan(ALMANAC);
    const page = file(p, "app/(site)/unsubscribe/page.tsx");
    expect(page).toContain('robots: { index: false, follow: false }');
    expect(page).toContain('<input type="hidden" name="List-Unsubscribe" value="One-Click" />');
    expect(page).toContain('name="action" value="resubscribe"');
    expect(code(page)).not.toContain("currentPrincipal");
    expect(file(p, "src/seo-paths.ts")).toContain('"/unsubscribe"');
  });

  it("the preferences page is a tab of the account area, and the sign-up opt-in is unticked", async () => {
    const p = await plan(ALMANAC);
    expect(file(p, "src/components/account/AccountTabs.tsx")).toContain('{ href: "/account/email", label: "Email" },');
    expect(file(p, "app/(site)/account/email/page.tsx")).toContain("<EmailPreferences initial={initial} />");
    expect(file(p, "src/components/SignUpEmailSlot.tsx")).toContain("<SignUpEmailChoice digests={signUpDigests()} />");
    expect(file(p, "app/(site)/sign-up/[[...sign-up]]/page.tsx")).toContain("<SignUpEmailSlot />");
    const welcome = code(file(p, "app/welcome/route.ts"));
    expect(welcome).toContain("await applySignUpEmailChoice(principal.userId, req.cookies.get(SIGN_UP_EMAIL_COOKIE)?.value);");
    expect(welcome).toContain("response.cookies.delete(SIGN_UP_EMAIL_COOKIE);");
    expect(welcome).toContain("await recordSignUp(principal.userId);");
  });

  it("a project that sells nothing: the account area is the email page", async () => {
    const p = await plan({ ...ALMANAC, businessModel: "none", includeMarketing: false });
    expect(code(file(p, "app/(site)/account/page.tsx"))).toContain('redirect("/account/email");');
    expect(file(p, "src/components/account/AccountTabs.tsx")).toContain('{ href: "/account/email", label: "Email" },');
    expect(code(file(p, "src/components/account/AccountTabs.tsx"))).not.toContain('"/account/billing"');
    // No plans, so no sample section: the digest is offered nowhere until the project writes one.
    expect(code(file(p, "src/digests.ts"))).toContain("sections: [],");
  });

  it("with plans, a real sample section: what needs the person on their own account", async () => {
    const registry = code(file(await plan(ALMANAC), "src/digests.ts"));
    expect(registry).toContain("sections: [yourAccount],");
    expect(registry).toContain("personalBannerSentence([...(await linePlansOf(personalWorkspaceId(person.userId))).values()])");
    expect(registry).toContain('export const SITE_TIME_ZONE = "America/New_York";');
  });

  it("the proof covers the review's list", async () => {
    const proof = file(await plan(ALMANAC), "src/server/__tests__/digest.test.ts");
    for (const name of [
      "two people in different zones",
      "running the cron again sends nobody anything",
      "is skipped: never failed, never reported, never sent again",
      "by the header: the provider's POST stops that one email and leaves the others",
      "by the link: the unsubscribe page's form, signed out",
      "another person's signed link is refused, and nobody's choice changes",
      "is never signed with a key anybody can read",
      "is staff only",
      "renders any person's digest for a chosen day, and never sends it",
    ]) {
      expect(proof, name).toContain(name);
    }
  });

  it("an upgrade from 0.39 says what to run and where the sections go", () => {
    const notes = upgradeNotesFor(ALMANAC, "0.39.0").join("\n");
    expect(notes).toContain("digest_preferences, digest_subscriptions, digest_sends");
    expect(notes).toContain("src/digests.ts");
    expect(notes).toContain("proxy.ts.new");
    expect(upgradeNotesFor(ALMANAC, "0.40.0")).toEqual([]);
    expect(upgradeNotesFor(BUSINESS, "0.39.0").join("\n")).not.toContain("digest_sends");
  });
});

describe("SEO by default, in every project", () => {
  const SEO_FILES = [
    "src/brand.ts",
    "src/brand-images.tsx",
    "app/icon.tsx",
    "app/apple-icon.tsx",
    "app/icon-192.png/route.ts",
    "app/icon-512.png/route.ts",
    "app/manifest.ts",
    "app/og.png/route.ts",
    "src/site-pages.ts",
    "src/dynamic-pages.ts",
    "src/seo-paths.ts",
    "src/llms.ts",
    "app/llms.txt/route.ts",
    "app/llms-full.txt/route.ts",
    "proxy.ts",
    "src/__tests__/seo-defaults.test.ts",
  ];

  it.each([
    ["the founder's consumer project", ALMANAC],
    ["one business", BUSINESS],
    ["companies", COMPANIES],
    ["a bare project with nothing installed", BARE],
    ["companies without --seo", { ...COMPANIES, includeSeo: false, includeAnalytics: false }],
  ] as const)("%s: icons, manifest, share card, page list, the proxy's header, llms-full.txt", async (_label, answers) => {
    const p = await plan(answers);
    for (const path of SEO_FILES) expect(p.files.has(sep(path)), path).toBe(true);
    const proxy = code(file(p, "proxy.ts"));
    expect(proxy).toContain('import { robotsHeaderFor } from "@/seo-paths";');
    expect(proxy).toContain('if (robots) response.headers.set("X-Robots-Tag", robots);');
    // The proxy stays light: no environment, no database at its top.
    expect(proxy).not.toContain('from "@/env"');
    expect(proxy).not.toContain('from "@/db"');
    // No `if` about an answer in what the project runs.
    expect(proxy).not.toMatch(/include[A-Z]\w+/);
    expect(code(file(p, "src/seo-paths.ts"))).not.toContain("@/env");
    expect(code(file(p, "src/site-pages.ts"))).not.toContain("import ");
    // Never frozen at build: cached for an hour, or (a companies sitemap) read every time.
    expect(file(p, "app/sitemap.ts")).toMatch(/export const (revalidate = 3600|dynamic = "force-dynamic");/);
    expect(file(p, "app/sitemap.ts")).toContain("dynamicPages()");
    expect(file(p, "src/seo.ts")).toContain('url: "/og.png", width: 1200, height: 630');
    expect(file(p, "src/seo.ts")).toContain("export function metadataFor(");
    expect(file(p, "app/manifest.ts")).toContain('{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }');
  });

  it("logs every AI crawler's read in the proxy only with --analytics, loading the log after the answer", async () => {
    const counted = code(file(await plan(ALMANAC), "proxy.ts"));
    expect(counted).toContain('import { classifyCrawler } from "@adminigloo/analytics/crawlers";');
    expect(counted).toContain('const { recordSiteCrawlerHit } = await import("@/server/website");');
    expect(counted).toContain("after(async () => {");
    expect(code(file(await plan(ALMANAC), "app/llms.txt/route.ts"))).not.toContain("recordSiteCrawlerHit");
    // Each company's pages are logged for that company by its gate, not here.
    expect(code(file(await plan(COMPANIES), "proxy.ts"))).toContain('path.startsWith("/t/")');
    const silent = code(file(await plan({ ...ALMANAC, includeAnalytics: false }), "proxy.ts"));
    expect(silent).not.toContain("classifyCrawler");
    expect(silent).not.toContain("after(");
  });

  it("test:pages starts the built site the way that works", async () => {
    for (const answers of [ALMANAC, BARE]) {
      const pages = code(file(await plan(answers), "tests/pages/public-pages.test.ts"));
      // Vitest's NODE_ENV=test makes Next skip .env.local: no Clerk key, every page a 500.
      expect(pages).toContain('env: { ...process.env, NODE_ENV: "production", PORT: String(port) }');
      // Bound to 127.0.0.1 alone, Next 16.2 proxies each request back to itself at localhost, round and round.
      expect(pages).toContain('[next, "start", "-p", String(port)]');
      expect(pages).not.toContain('"-H"');
      // On a Clerk development key a request for a document goes to Clerk's handshake: every page a 307.
      expect(pages).not.toMatch(/accept: "text\/html"/i);
    }
  });

  it("names the routes the review asked for in the list the proxy sends X-Robots-Tag from", async () => {
    const paths = file(await plan(ALMANAC), "src/seo-paths.ts");
    for (const path of ['"/api/"', '"/setup"', '"/admin"', '"/account"', '"/welcome"', '"/unsubscribe"']) expect(paths, path).toContain(path);
    expect(paths).toContain('noindex: ["/sign-in", "/sign-up"]');
    const bare = file(await plan(BARE), "src/seo-paths.ts");
    expect(bare).toContain('"/sign-in"');
    expect(bare).not.toContain('"/admin"');
    expect(bare).not.toContain('"/welcome"');
  });

  it("--seo: llms.txt and llms-full.txt are the package's, from the site record, with the plans; robots.txt is one group", async () => {
    const p = await plan(ALMANAC);
    expect(file(p, "app/llms.txt/route.ts")).toContain("return llmsResponse(llmsTxt(site, await llmsRegistry()));");
    expect(file(p, "app/llms-full.txt/route.ts")).toContain("return llmsResponse(llmsFullTxt(site, await llmsRegistry()));");
    const llms = code(file(p, "src/llms.ts"));
    expect(llms).toContain("summary: SITE_DESCRIPTION");
    expect(llms).toContain('pricing: { path: "/pricing", plans: pricingPlans() }');
    expect(file(p, "app/robots.ts")).toContain("combine: true");
    expect(file(p, "src/seo-paths.ts")).toContain("public: SITE_PAGES.map((page) => page.path)");
  });

  it("without --seo: the project's own llms files from the same records", async () => {
    const p = await plan({ ...BUSINESS, includeSeo: false });
    const llms = code(file(p, "src/llms.ts"));
    expect(llms).toContain("SITE_DESCRIPTION");
    expect(llms).toContain("robotsHeaderFor(page.path) === null");
    expect(file(p, "app/llms-full.txt/route.ts")).toContain("llmsFullText()");
    expect(code(file(p, "app/robots.ts"))).toContain("disallow: [...PRIVATE_PATHS]");
  });

  it("every generated public page exports metadataFor", async () => {
    const p = await plan({ ...BUSINESS, businessModel: "both", includeScheduling: true, includeEstimator: true, includeBooking: true, includeStore: true, includeCustomers: true });
    for (const path of [
      "app/(site)/page.tsx",
      "app/(site)/pricing/page.tsx",
      "app/(site)/privacy/page.tsx",
      "app/(site)/terms/page.tsx",
      "app/(site)/estimate/page.tsx",
      "app/(site)/book-visit/page.tsx",
      "app/(site)/book/page.tsx",
      "app/(site)/store/page.tsx",
    ]) {
      expect(code(file(p, path)), path).toContain("metadataFor({");
    }
    // The orientation page at / in a project with no marketing site.
    expect(code(file(await plan(BARE), "app/(site)/page.tsx"))).toContain('metadataFor({ path: "/", title: SITE_NAME })');
  });
});
