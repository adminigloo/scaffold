/**
 * SEARCH, AS HINDERSTAP NEEDED IT (create-app 0.43): one address in search
 * (the proxy's 308 from www. and the *.vercel.app aliases, INDEXABLE only at a
 * real app URL), the engines' verification tokens, IndexNow's key file and
 * announce script, a disclaimer for a site about somebody else's work, the
 * answer-engine writing guide, and CI's placeholder app URL. Read from the
 * PLAN as text; the generated project's own proxy test runs the redirect.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, optionalEnvFor, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { versionRangeFor } from "../versions.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "fan-site", ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}
const has = (p: EmitPlan, ...segments: string[]) => p.files.has(join(...segments));

const SEO: Partial<Answers> = { includeSeo: true };

describe("one address in search (--seo)", () => {
  it("indexes only a production build at a real public app URL", async () => {
    const seo = file(await plan(SEO), "src", "seo.ts");
    expect(seo).toContain('import { defineSite, isIndexable, pageMetadata, siteMetadata as buildSiteMetadata, type PageInput } from "@adminigloo/seo";');
    expect(seo).toContain('export const INDEXABLE: boolean = isIndexable({ env: resolveAppEnv(), host: env.NEXT_PUBLIC_APP_URL ?? "" });');
  });

  it("sends a production page read on another host to the canonical one, and the proxy test proves it", async () => {
    const p = await plan(SEO);
    const proxy = file(p, "proxy.ts");
    expect(proxy).toContain("const CANONICAL_ORIGIN = canonicalOrigin(process.env.NEXT_PUBLIC_APP_URL);");
    expect(proxy).toContain("return NextResponse.redirect(new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, CANONICAL_ORIGIN.origin), 308);");
    expect(proxy).toContain('if (req.nextUrl.pathname.startsWith("/api/")) return null;');
    expect(proxy).toContain("/^[\\d.]+$/.test(name)");
    // First in handle(): a moved page is answered before anything else runs.
    expect(proxy).toMatch(/function handle\(req: NextRequest\): NextResponse \{\n {2}const moved = toCanonicalHost\(req\);\n {2}if \(moved\) return moved;/);
    const test = file(p, "src", "__tests__", "proxy.test.ts");
    expect(test).toContain('import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";');
    expect(test).toContain('describe("one address in search (create-app 0.43)"');
    expect(test).toContain('expect(res.headers.get("location")).toBe("https://example.com/pricing?ref=a");');
  });

  it("leaves a project without --seo exactly as it was", async () => {
    const p = await plan();
    expect(file(p, "proxy.ts")).not.toContain("toCanonicalHost");
    expect(file(p, "src", "__tests__", "proxy.test.ts")).not.toContain("afterEach");
    expect(file(p, "src", "seo.ts")).toContain('export const INDEXABLE: boolean = resolveAppEnv() === "production";');
    expect(has(p, "app", "indexnow-key.txt", "route.ts")).toBe(false);
    expect(has(p, "scripts", "indexnow.ts")).toBe(false);
    expect(optionalEnvFor(answers())).not.toContain("INDEXNOW_KEY");
  });
});

describe("the engines' tokens and IndexNow (--seo)", () => {
  it("passes the verification tokens and the disclaimer to defineSite", async () => {
    const seo = file(await plan(SEO), "src", "seo.ts");
    expect(seo).toContain("export const SITE_DISCLAIMER: string | undefined = undefined;");
    expect(seo).toContain("  disclaimer: SITE_DISCLAIMER,");
    expect(seo).toContain("  verification: { google: env.GOOGLE_SITE_VERIFICATION, bing: env.BING_SITE_VERIFICATION },");
  });

  it("declares the three variables, optional, in the env contract, .env.example and /setup", async () => {
    const p = await plan(SEO);
    const env = file(p, "src", "env.ts");
    expect(env).toContain("GOOGLE_SITE_VERIFICATION: z.string().max(200).optional()");
    expect(env).toContain("BING_SITE_VERIFICATION: z.string().max(200).optional()");
    expect(env).toContain('INDEXNOW_KEY: z.string().regex(/^[A-Za-z0-9-]{8,128}$/, "8 to 128 letters, digits or dashes").optional()');
    expect(env).toContain("INDEXNOW_KEY: process.env.INDEXNOW_KEY");
    expect(env).toContain('{ name: "IndexNow", vars: ["INDEXNOW_KEY"]');
    expect(env).toContain('{ name: "Search engine verification", vars: ["GOOGLE_SITE_VERIFICATION", "BING_SITE_VERIFICATION"]');
    const example = file(p, ".env.example");
    for (const name of ["GOOGLE_SITE_VERIFICATION", "BING_SITE_VERIFICATION", "INDEXNOW_KEY"]) expect(example).toContain(`\n${name}=\n`);
    expect(example).toContain("# Any 8 to 128 letters, digits or dashes (openssl rand -hex 16), public by design:");
  });

  it("serves the key at a fixed address, and announces the live sitemap by hand", async () => {
    const p = await plan(SEO);
    const route = file(p, "app", "indexnow-key.txt", "route.ts");
    expect(route).toContain('import { indexNowKeyFile, isIndexNowKey } from "@adminigloo/seo";');
    expect(route).toContain("if (!key || !isIndexNowKey(key)) {");
    expect(route).toContain('return new Response("Not found\\n", { status: 404');
    const script = file(p, "scripts", "indexnow.ts");
    expect(script).toContain('const KEY_LOCATION = "/indexnow-key.txt";');
    expect(script).toContain("const locs = [...xml.matchAll(/<loc>\\s*([^<]+?)\\s*<\\/loc>/g)]");
    expect(script).toContain("const result = await submitUrls(site, urls, { key, keyLocation: KEY_LOCATION });");
    expect(script).toContain('if (!raw) fail("say which live site to announce: --origin https://example.com');
    const pkg = JSON.parse(file(p, "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["seo:indexnow"]).toBe("tsx scripts/indexnow.ts");
    expect(has(p, "docs", "content-for-answer-engines.md")).toBe(true);
    expect(file(p, "docs", "content-for-answer-engines.md")).toContain("Set `SITE_DISCLAIMER` in src/seo.ts");
  });

  it("asks for the seo package that has disclaimer, verification and creativeWork", () => {
    expect(versionRangeFor("@adminigloo/seo")).toBe("^0.4.0");
  });
});

describe("every project", () => {
  it("has a disclaimer slot the footer shows", async () => {
    const p = await plan();
    expect(file(p, "src", "seo.ts")).toContain("export const SITE_DISCLAIMER: string | undefined = undefined;");
    const footer = file(p, "src", "components", "SiteFooter.tsx");
    expect(footer).toContain('import { SITE_DISCLAIMER, SITE_NAME } from "@/seo";');
    expect(footer).toContain('{SITE_DISCLAIMER ? <p className="w-full text-xs text-ink-muted">{SITE_DISCLAIMER}</p> : null}');
  });

  it("builds in CI with a placeholder app URL", async () => {
    const ci = await readFile(join(TEMPLATE_DIR, "_github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/- run: pnpm build\n {8}env:\n {10}SKIP_ENV_VALIDATION: "1"\n {10}NEXT_PUBLIC_APP_URL: http:\/\/localhost:3000/);
  });

  it("says how to bring in an old stylesheet without it beating Tailwind", async () => {
    const css = file(await plan(), "app", "globals.css");
    expect(css).toContain("BRINGING IN AN EXISTING STYLESHEET? Put it in a cascade layer declared");
  });

  it("tells an upgrading project what changed, and a --seo one more", () => {
    const plain = upgradeNotesFor(answers(), "0.42.8").join("\n");
    expect(plain).toContain("SITE_DISCLAIMER");
    expect(plain).not.toContain("pnpm seo:indexnow");
    const seo = upgradeNotesFor(answers(SEO), "0.42.8").join("\n");
    expect(seo).toContain("pnpm seo:indexnow --origin https://your-domain");
    expect(seo).toContain("take `toCanonicalHost` out of `handle`");
    expect(upgradeNotesFor(answers(SEO), "0.43.0").join("\n")).not.toContain("SITE_DISCLAIMER");
  });
});
