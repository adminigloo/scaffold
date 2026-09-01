import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWERS,
  capabilitiesFor,
  overlayNamesFor,
  type Answers,
} from "../answers.js";
import { planEmit, renderSiteNav } from "../emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * THE MARKETING HALF: what selects it, what it owns, and what it must not say.
 *
 * The failures this file is aimed at are all quiet ones. A landing page that
 * silently loses to a generated file at the same path. A privacy policy naming
 * Stripe in a project that takes no money. A pricing page that hardcodes the
 * number the record was written to be the only copy of. A sitemap listing a page
 * that was never built. None of those is a type error, none of them shows up in
 * a build log, and three of the four are only visible to somebody outside the
 * product — a crawler, a regulator, or a customer reading a price.
 */

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

const LANDING = join("app", "(site)", "page.tsx");
const ORIENTATION = join("app", "(site)", "setup", "start", "page.tsx");
const PRICING = join("app", "(site)", "pricing", "page.tsx");
const PRIVACY = join("app", "(site)", "privacy", "page.tsx");
const TERMS = join("app", "(site)", "terms", "page.tsx");
const SEO = join("src", "seo.ts");
const ROBOTS = join("app", "robots.ts");
const SITEMAP = join("app", "sitemap.ts");
const LEGAL = join("src", "legal.ts");
const PLANS = join("src", "plans.ts");

/** The emitted file with every comment removed — what the project actually RUNS. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every combination of the two answers the three overlay rules read. */
const SHAPES = (["none", "one-time", "subscription", "both"] as const).flatMap(
  (businessModel) =>
    [true, false].map(
      (includeMarketing) =>
        [
          `--model ${businessModel}${includeMarketing ? " --marketing" : " --no-marketing"}`,
          { businessModel, includeMarketing } as Partial<Answers>,
        ] as const,
    ),
);

describe("what selects the marketing overlays", () => {
  it("copies the landing page only where a public face was asked for", () => {
    for (const [label, overrides] of SHAPES) {
      const names = overlayNamesFor(answers(overrides));
      expect(names.includes("marketing"), label).toBe(
        overrides.includeMarketing === true,
      );
    }
  });

  it("copies the pricing page only where there is both a site and a plan record", () => {
    // TWO CONDITIONS, exactly as `catalog-admin` has two. The page imports
    // `@/plans`, which is written only for a project that takes money, so a
    // `--model none --marketing` project must not get it — the module would not
    // resolve. And a project that sells without a marketing site must not get it
    // either, because there would be no public face to reach it from.
    for (const [label, overrides] of SHAPES) {
      const names = overlayNamesFor(answers(overrides));
      const expected =
        overrides.includeMarketing === true && overrides.businessModel !== "none";
      expect(names.includes("marketing-pricing"), label).toBe(expected);
    }
  });

  it("copies the legal routes on the wider condition, because Stripe requires them", () => {
    // A DISJUNCTION, and this is the case a single condition would get wrong: a
    // project that takes money and has no marketing site still cannot activate
    // a Stripe account without a reachable privacy policy and terms of service.
    for (const [label, overrides] of SHAPES) {
      const names = overlayNamesFor(answers(overrides));
      const expected =
        overrides.includeMarketing === true || overrides.businessModel !== "none";
      expect(names.includes("legal"), label).toBe(expected);
    }

    expect(
      overlayNamesFor(answers({ businessModel: "none", includeMarketing: false })),
    ).not.toContain("legal");
  });

  it("claims a capability for each, and only where it is true", () => {
    for (const [label, overrides] of SHAPES) {
      const keys = capabilitiesFor(answers(overrides));
      const marketing = overrides.includeMarketing === true;
      const sells = overrides.businessModel !== "none";

      expect(keys.includes("marketing.landing"), label).toBe(marketing);
      expect(keys.includes("marketing.pricing"), label).toBe(marketing && sells);
      expect(keys.includes("legal.policies"), label).toBe(marketing || sells);
      // Unconditional. A staging deployment that can be crawled is a harm, so
      // the metadata half is never behind an answer.
      expect(keys, label).toContain("seo.metadata");
    }
  });
});

describe("who owns `/`", () => {
  it("gives it to the landing page, and moves the orientation page", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeMarketing: true }));

    const landing = plan.files.get(LANDING) ?? "";
    expect(landing).toContain("@/components/marketing/Hero");
    // THE CLOBBER GUARD. `planEmit` writes `app/(site)/page.tsx` with
    // `files.set` AFTER the overlays have been copied, so a missing branch there
    // would silently replace the overlay's landing page with the file map —
    // and `OverlayCollisionError` cannot see it, because that check compares an
    // overlay against the BASE TEMPLATE and this file is in neither.
    expect(landing).not.toContain("STARTING_POINTS");

    const orientation = plan.files.get(ORIENTATION) ?? "";
    expect(orientation).toContain("STARTING_POINTS");
    expect(orientation).toContain("<HealthCheck />");
  });

  it("keeps it as the orientation page when there is no marketing site", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeMarketing: false }));
    expect(plan.files.get(LANDING) ?? "").toContain("STARTING_POINTS");
    expect(plan.files.has(ORIENTATION)).toBe(false);
  });

  it("emits the orientation page exactly once, in every configuration", async () => {
    // Not twice and not never. Two copies is a second file to keep in step; none
    // is the loss of the only index of where anything in the project is,
    // including `src/plans.ts`.
    for (const [label, overrides] of SHAPES) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      const homes = [LANDING, ORIENTATION].filter((path) =>
        (plan.files.get(path) ?? "").includes("STARTING_POINTS"),
      );
      expect(homes, label).toHaveLength(1);
    }
  });

  it("links to it from the footer once it has moved", async () => {
    // A page nothing points at is a page nobody finds. It is in FOOTER_LINKS
    // rather than the header for the same reason /setup is: a developer surface
    // that has to be reachable from anywhere and belongs in front of nobody.
    const nav = renderSiteNav(answers({ includeMarketing: true }));
    expect(nav).toContain('{ href: "/setup/start", label: "Where to start" }');
    expect(renderSiteNav(answers({ includeMarketing: false }))).not.toContain(
      "/setup/start",
    );
  });

  it("is composed of section files rather than one page", async () => {
    // Every client rewrites the copy and about half delete two of the sections.
    // A single file with all five inlined makes both of those a merge conflict
    // with whatever the scaffold ships next.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeMarketing: true }));
    const landing = plan.files.get(LANDING) ?? "";

    for (const section of ["Hero", "Features", "SocialProof", "Faq", "CallToAction"]) {
      expect(
        plan.files.has(join("src", "components", "marketing", `${section}.tsx`)),
        `${section}.tsx is not emitted`,
      ).toBe(true);
      expect(landing, `the landing page does not compose ${section}`).toContain(
        `<${section} />`,
      );
    }
  });
});

describe("the pricing page", () => {
  const sells = answers({ businessModel: "subscription", includeMarketing: true });

  it("is emitted with the record it reads, never one without the other", async () => {
    for (const [label, overrides] of SHAPES) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      if (!plan.files.has(PRICING)) continue;
      expect(plan.files.has(PLANS), `${label} has a pricing page and no src/plans.ts`).toBe(
        true,
      );
    }
  });

  it("reads the record rather than restating it", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", sells);
    const page = plan.files.get(PRICING) ?? "";
    expect(page).toContain('from "@/plans"');
    // The tiers on the page are the tiers the record still sells. The filter IS
    // the difference between the pricing page and the record: a retired tier
    // stays declared so `planGrantDiff` can reason about the people on it, and
    // must not be advertised.
    expect(page).toContain("tier.isActive");
  });

  it("contains no price, and no sentence the record already owns", async () => {
    // THE WHOLE POINT OF THE EXERCISE. A pricing page that restates a number is
    // a second copy of the answer, and the copy that wins the argument with a
    // customer is always the page. So: no currency symbol anywhere in the
    // rendered source, and none of the descriptions the record writes.
    const plan = await planEmit(TEMPLATE_DIR, "/out", sells);
    const record = plan.files.get(PLANS) ?? "";
    const sources = [
      PRICING,
      join("src", "components", "marketing", "pricing", "PlanColumns.tsx"),
      join("src", "components", "marketing", "pricing", "ComparisonTable.tsx"),
    ].map((path) => withoutComments(plan.files.get(path) ?? ""));

    const descriptions = [...record.matchAll(/description: "([^"]+)"/g)].flatMap(
      (m) => m[1] ?? [],
    );
    expect(descriptions.length).toBeGreaterThan(0);

    for (const source of sources) {
      for (const symbol of ["£", "€", "US$"]) {
        expect(source, `a ${symbol} is written into the pricing page`).not.toContain(
          symbol,
        );
      }
      for (const description of descriptions) {
        expect(source, `"${description}" is copied out of the record`).not.toContain(
          description,
        );
      }
    }
  });

  it("is in the public nav only where it exists", async () => {
    for (const [label, overrides] of SHAPES) {
      const nav = renderSiteNav(answers(overrides));
      const expected =
        overrides.includeMarketing === true && overrides.businessModel !== "none";
      expect(nav.includes('{ href: "/pricing", label: "Pricing" }'), label).toBe(
        expected,
      );
    }
  });
});

describe("the legal record", () => {
  it("is written wherever the pages are, and nowhere else", async () => {
    for (const [label, overrides] of SHAPES) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      const pages = plan.files.has(PRIVACY) && plan.files.has(TERMS);
      expect(plan.files.has(LEGAL), `${label}: record and pages disagree`).toBe(pages);
    }
  });

  it("names a subprocessor only when the project actually installed it", async () => {
    // THE PARAGRAPH EVERY COPIED TEMPLATE GETS WRONG, and the reason it gets it
    // wrong is that it is a fact about the software rather than about the
    // business. The generator is the only thing that knows.
    const maximal = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({
        businessModel: "both",
        includeEmail: true,
        includeAi: true,
        includeMarketing: true,
      }),
    );
    const minimal = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "none", includeMarketing: true }),
    );

    const full = maximal.files.get(LEGAL) ?? "";
    const bare = minimal.files.get(LEGAL) ?? "";

    // Everything the base package set reaches, in both.
    for (const always of ["Clerk", "Neon", "Vercel", "Sentry", "Upstash"]) {
      expect(full, always).toContain(`name: "${always}"`);
      expect(bare, always).toContain(`name: "${always}"`);
    }

    // And nothing else. A privacy policy naming Stripe in a project that takes
    // no money is a statement a regulator can hold the client to about a
    // company they have never had an account with.
    for (const conditional of ["Stripe", "Resend", "Anthropic", "OpenAI", "Google"]) {
      expect(full, conditional).toContain(`name: "${conditional}"`);
      expect(bare, conditional).not.toContain(`name: "${conditional}"`);
    }
  });

  it("declares the clauses that follow from what the project does", async () => {
    const oneTime = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "one-time", includeMarketing: true }),
    );
    const subscription = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "subscription", includeMarketing: true }),
    );
    const neither = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "none", includeMarketing: true }),
    );

    expect(oneTime.files.get(LEGAL) ?? "").toContain('heading: "Purchases"');
    expect(oneTime.files.get(LEGAL) ?? "").not.toContain("Subscriptions and renewal");

    expect(subscription.files.get(LEGAL) ?? "").toContain(
      'heading: "Subscriptions and renewal"',
    );

    // The empty case has to render as an array literal that parses, not as a
    // list with a stray comma in it — the same failure `renderLinkArray` was
    // written around.
    expect(neither.files.get(LEGAL) ?? "").toContain(
      "export const EXTRA_TERMS: readonly LegalClause[] = [];",
    );
  });
});

describe("SEO, which is in every project on purpose", () => {
  it("emits the three files whether or not there is a marketing site", async () => {
    for (const [label, overrides] of SHAPES) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
      for (const path of [SEO, ROBOTS, SITEMAP]) {
        expect(plan.files.has(path), `${label} emitted no ${path}`).toBe(true);
      }
    }
  });

  it("resolves relative social URLs against a real origin", async () => {
    // Without `metadataBase`, Next resolves every relative Open Graph URL
    // against localhost. The page renders perfectly and the failure appears
    // only in somebody else's chat window, as a grey box.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const seo = plan.files.get(SEO) ?? "";
    expect(seo).toContain("metadataBase: new URL(env.NEXT_PUBLIC_APP_URL)");
    expect(seo).toContain("openGraph");
    expect(seo).toContain("card: \"summary_large_image\"");

    // And the root layout actually uses it. A metadata module nothing imports
    // is the same as no metadata module, and this one exports a `Metadata`
    // object that typechecks perfectly on its own.
    const layout = plan.files.get(join("app", "layout.tsx")) ?? "";
    expect(layout).toContain('from "@/seo"');
    expect(layout).toContain("export const metadata: Metadata = siteMetadata;");
  });

  it("sets no canonical in the root, because every page would inherit it", async () => {
    // Metadata merges field by field down the tree, so a canonical here is
    // adopted by every page that does not override one — a whole site declaring
    // itself canonical to `/`, which asks Google to drop all of it.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    expect(withoutComments(plan.files.get(SEO) ?? "")).not.toContain("alternates");
  });

  it("indexes production and nothing else", async () => {
    // `resolveAppEnv()` rather than `isDeployed()`, and the gap between them is
    // the entire point: an unlabelled production artefact resolves to `staging`
    // and reports `isDeployed() === false`, so keying on deployment would let
    // precisely the environment nobody could identify be crawled.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const seo = withoutComments(plan.files.get(SEO) ?? "");
    expect(seo).toContain('resolveAppEnv() === "production"');
    expect(seo).not.toContain("isDeployed");
    expect(seo).toContain("index: false");

    // ONE DECISION, TWO CONSUMERS. robots.txt imports the constant rather than
    // reading the environment again — two independent readings are two chances
    // for the meta tag and the file to disagree, and nothing in the product
    // renders /robots.txt, so the disagreement would only be found by a crawler.
    const robots = withoutComments(plan.files.get(ROBOTS) ?? "");
    expect(robots).toContain('import { INDEXABLE } from "@/seo"');
    expect(robots).not.toContain("resolveAppEnv");
    expect(robots).toContain('disallow: "/"');
  });

  it("lists the pricing and legal pages in the sitemap only where they exist", async () => {
    const marketing = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "both", includeMarketing: true }),
    );
    const bare = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({ businessModel: "none", includeMarketing: false }),
    );

    const withPages = marketing.files.get(SITEMAP) ?? "";
    expect(withPages).toContain('"/pricing"');
    expect(withPages).toContain('"/privacy"');

    const withoutPages = withoutComments(bare.files.get(SITEMAP) ?? "");
    expect(withoutPages).not.toContain('"/pricing"');
    expect(withoutPages).not.toContain('"/privacy"');
    expect(withoutPages).toContain('"/"');
  });
});
