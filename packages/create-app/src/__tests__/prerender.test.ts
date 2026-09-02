/**
 * THE CHECK THAT WAS MISSING WHEN A `--email` PROJECT COULD NOT BE BUILT.
 *
 * `next build` on a generated project with Clerk keys in `.env.local` exited 1
 * on `Error occurred prerendering page "/setup/email"`, and had done since the
 * page was written. `/setup/email` was the only route in the scaffold that
 * declared `dynamic = "force-static"`, so it was the only one rendered at build
 * time — and it sits under `app/(site)/layout.tsx`, whose header reads the
 * Clerk session from headers that exist only when a request does.
 *
 * WHAT MADE IT INVISIBLE IS THE INTERESTING PART, and it is not this page. With
 * no Clerk keys the header returns before it reads anything, so the prerender
 * succeeds — and every check in this repository, the route sweep included,
 * generated a project with no credentials. Five configurations were reported
 * green while a configured project could not build at all. The zero-credential
 * promise was tested; the with-credential path was not tested anywhere.
 *
 * So the assertions here are deliberately not about `/setup/email`. Marking one
 * page dynamic removes one symptom and leaves the trap for whoever adds the
 * next static page under `(site)`. What is pinned instead is the RULE — no page
 * under a layout that reads the session may force a prerender — together with
 * the two things a rule like this normally fails at: that the detector finds
 * the layout at all, and that it does not simply object to everything.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoPrerenderedAuthRoutes,
  authScopedLayouts,
  PrerenderedAuthRouteError,
  type AuthScopedLayout,
} from "../prerender.js";
import type { EmitPlan } from "../emit.js";
import { planEmit } from "../emit.js";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { EVERY_CONFIGURATION, TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

/** A plan assembled by hand, so a scenario can be built that the emitter refuses to. */
function planOf(files: Record<string, string>): EmitPlan {
  return { targetDir: "/out", files: new Map(Object.entries(files)) };
}

const HEADER_THAT_READS_A_SESSION = `
  import { auth } from "@clerk/nextjs/server";
  export async function AuthHeader() {
    const { userId } = await auth();
    return <p>{userId}</p>;
  }
`;

const SITE_LAYOUT = `
  import { AuthHeader } from "@/components/AuthHeader";
  export default function SiteLayout({ children }) {
    return <><AuthHeader />{children}</>;
  }
`;

/**
 * Every configuration planned once, and both properties read off the same
 * sweep.
 *
 * Two hundred and forty `planEmit` calls is fifteen seconds of file reading,
 * and doing it twice to ask two questions about the same plans is thirty. A
 * configuration that trips the rule is recorded rather than thrown, because
 * `planEmit` now runs the assertion itself and an uncaught throw here would
 * report the first bad configuration and hide the shape of the fault.
 */
interface Swept {
  readonly label: string;
  /** The auth-scoped layouts found, or undefined if the plan was refused. */
  readonly scoped?: readonly AuthScopedLayout[];
  /** Why it was refused. A page under a session-reading layout forced a prerender. */
  readonly refused?: string;
}

let sweeping: Promise<readonly Swept[]> | undefined;

function sweep(): Promise<readonly Swept[]> {
  sweeping ??= (async () => {
    const results: Swept[] = [];
    for (const config of EVERY_CONFIGURATION) {
      try {
        const plan = await planEmit(TEMPLATE_DIR, "/out", config.answers);
        results.push({ label: config.label, scoped: authScopedLayouts(plan) });
      } catch (error) {
        if (!(error instanceof PrerenderedAuthRouteError)) throw error;
        results.push({ label: config.label, refused: error.message });
      }
    }
    return results;
  })();
  return sweeping;
}

describe("the detector finds the layout the session is read from", () => {
  it("names app/(site) and the component that actually reads it", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers());
    const scoped = authScopedLayouts(plan);

    const site = scoped.find((entry) => entry.layout === "app/(site)/layout.tsx");
    expect(
      site,
      `authScopedLayouts found [${scoped.map((s) => s.layout).join(", ")}]`,
    ).toBeDefined();

    // The read is two hops from the layout — the layout imports the header, the
    // header calls auth(). Pinning WHERE it was found is what stops this from
    // passing on a coincidence: a detector that only matched a layout's own
    // import of `@clerk/nextjs` would report the layout itself, and would miss
    // every arrangement one hop deeper.
    expect(site?.reads).toBe("src/components/AuthHeader.tsx");
  });

  it("finds those two layouts and no others, so the rule stays a rule", async () => {
    // THE PRECISION HALF, and the first attempt at this failed it. Counting
    // `import type` edges made `app/layout.tsx` look like it read a session: the
    // root layout imports `@/trpc/client`, which imports the router's TYPE,
    // which reaches `@/server/auth`. Its segment is `app`, so every page in the
    // project fell under it and the rule became a blanket ban on static
    // rendering — with an error message naming three files that have nothing to
    // do with the fault. A rule that forbids everything teaches nobody anything.
    //
    // The widest project there is, so every layout any overlay contributes is
    // present. Both entries are real: `(site)` renders the header, and the admin
    // shell awaits `currentPrincipal()` in its own body.
    const plan = await planEmit(
      TEMPLATE_DIR,
      "/out",
      answers({
        businessModel: "both",
        adminShell: "full",
        includeAi: true,
        includeEmail: true,
        includeMarketing: true,
      }),
    );

    expect([...authScopedLayouts(plan)].map((entry) => entry.layout).sort()).toEqual([
      "app/(site)/layout.tsx",
      "app/admin/layout.tsx",
    ]);
  });

  it("finds one in every configuration, so the rule below is never vacuous", async () => {
    // THE ANTI-VACUITY HALF, and the assertion most likely to earn its keep.
    // `assertNoPrerenderedAuthRoutes` returns immediately when no layout reads a
    // session, which is exactly what a refactor of the header would produce: a
    // green suite, a rule with nothing left to enforce, and the same build
    // failure back again the next time somebody writes a static page.
    //
    // A configuration the rule REFUSED is not evidence of blindness — it is the
    // detector working — so those are the other test's business, not this one's.
    const blind = (await sweep())
      .filter((result) => result.refused === undefined)
      .filter(
        (result) =>
          !(result.scoped ?? []).some(
            (entry) => entry.layout === "app/(site)/layout.tsx",
          ),
      )
      .map((result) => result.label);

    expect(
      blind,
      `${blind.length} configurations emit an app/(site)/layout.tsx that no ` +
        `longer reaches a session read. Either the header stopped reading one — ` +
        `in which case this file and prerender.ts both need rewriting — or the ` +
        `detector has gone blind and the rule it guards is now decorative:\n\n` +
        `${blind.join("\n")}\n`,
    ).toEqual([]);
  });
});

describe("no emitted page forces a prerender under it", () => {
  it("holds for every configuration the generator can produce", async () => {
    const problems = (await sweep())
      .filter((result) => result.refused !== undefined)
      .map((result) => `${result.label}\n    ${result.refused ?? ""}`);

    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });

  it("holds for the email preview in particular, which is where it broke", async () => {
    // The regression pin. It reads nothing and renders sample data, which is
    // what made `force-static` look right; what it also does is sit under a
    // header that reads the session, and there is no third option — a page
    // under that layout renders per request or it does not render at all.
    const plan = await planEmit(TEMPLATE_DIR, "/out", answers({ includeEmail: true }));
    const preview = plan.files.get(join("app", "(site)", "setup", "email", "page.tsx"));

    expect(preview).toBeDefined();
    expect(preview).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("and the rule is a rule, not a ban on static rendering", () => {
  it("refuses a page that forces static under a layout that reads a session", () => {
    // THE ORIGINAL BUG, rebuilt from parts. If this stops throwing, the check
    // has stopped working, whatever the sweeps above say.
    const plan = planOf({
      "src/components/AuthHeader.tsx": HEADER_THAT_READS_A_SESSION,
      "app/(site)/layout.tsx": SITE_LAYOUT,
      "app/(site)/setup/email/page.tsx": `export const dynamic = "force-static";`,
    });

    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(PrerenderedAuthRouteError);

    // The message has to carry the diagnosis, because the one it replaces does
    // not: Clerk's names the middleware and neither of the two files involved.
    // The page, the layout, the module that reads the session, and what to do.
    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(
      /app\/\(site\)\/setup\/email\/page\.tsx/,
    );
    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(
      /app\/\(site\)\/layout\.tsx/,
    );
    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(
      /src\/components\/AuthHeader\.tsx/,
    );
    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(/force-dynamic/);
  });

  it('refuses dynamic = "error" for the same reason', () => {
    // A different directive with the same consequence: it forbids the route
    // from reading a request, and the header above it does nothing else.
    const plan = planOf({
      "src/components/AuthHeader.tsx": HEADER_THAT_READS_A_SESSION,
      "app/(site)/layout.tsx": SITE_LAYOUT,
      "app/(site)/privacy/page.tsx": `export const dynamic = "error";`,
    });

    expect(() => assertNoPrerenderedAuthRoutes(plan)).toThrow(PrerenderedAuthRouteError);
  });

  it("does not follow a type import, or a module that runs in the browser", () => {
    // The two edges that turned this from a rule into a dragnet, as parts. A
    // root layout reaches the session-reading module twice over here — once
    // through a type the compiler erases, once through a provider that runs in
    // the browser — and neither is a path the server render can take.
    const plan = planOf({
      "src/server/auth.ts": HEADER_THAT_READS_A_SESSION,
      "src/trpc/client.tsx": `"use client";\nimport { appRouter } from "@/server/auth";\nexport const TRPCProvider = () => null;`,
      "app/layout.tsx": `
        import type { Principal } from "@/server/auth";
        import { TRPCProvider } from "@/trpc/client";
        export default function Root({ children }) {
          return <TRPCProvider>{children}</TRPCProvider>;
        }
      `,
      "app/handbook/page.tsx": `export const dynamic = "force-static";`,
    });

    expect(authScopedLayouts(plan)).toEqual([]);
    expect(() => assertNoPrerenderedAuthRoutes(plan)).not.toThrow();
  });

  it("allows force-static where no layout above the page reads a session", () => {
    // The half that keeps this from being a blanket prohibition. A static page
    // is the right answer for a document that reads nothing, and a scaffold
    // that forbade one outright would be trading a build failure for a slower
    // site. What makes the case above illegal is the header, not the directive.
    const plan = planOf({
      "src/components/AuthHeader.tsx": HEADER_THAT_READS_A_SESSION,
      "app/(site)/layout.tsx": SITE_LAYOUT,
      "app/(docs)/layout.tsx": `export default function Docs({ children }) { return children; }`,
      "app/(docs)/handbook/page.tsx": `export const dynamic = "force-static";`,
    });

    expect(() => assertNoPrerenderedAuthRoutes(plan)).not.toThrow();
  });

  it("is not fooled by a comment that names the directive it forbids", () => {
    // Both files below discuss the fault in prose, which is what the fix to it
    // consists of. A check over raw source would refuse the very project that
    // documents why the rule exists.
    const plan = planOf({
      "src/components/AuthHeader.tsx": HEADER_THAT_READS_A_SESSION,
      "app/(site)/layout.tsx": SITE_LAYOUT,
      "app/(site)/setup/email/page.tsx": `
        /**
         * This used to say \`export const dynamic = "force-static"\`, and that
         * broke every build with Clerk configured.
         */
        export const dynamic = "force-dynamic";
      `,
    });

    expect(() => assertNoPrerenderedAuthRoutes(plan)).not.toThrow();
  });

  it("says nothing about a layout that reads no session", () => {
    const plan = planOf({
      "app/(site)/layout.tsx": `export default function L({ children }) { return children; }`,
      "app/(site)/page.tsx": `export const dynamic = "force-static";`,
    });

    expect(authScopedLayouts(plan)).toEqual([]);
    expect(() => assertNoPrerenderedAuthRoutes(plan)).not.toThrow();
  });
});
