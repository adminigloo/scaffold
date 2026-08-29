import { slugify } from "./deterministic.js";

/**
 * Browser-test helpers, as TYPES AND DATA ONLY.
 *
 * Nothing here imports `@playwright/test`, and it is not a dependency of this
 * package. A project that only wants `withPermissions` in a vitest suite would
 * otherwise install a browser driver and three hundred megabytes of browsers to
 * typecheck — and a devDependency that heavy gets removed, taking the helpers
 * that were worth having with it. The recipe below is data the project's own
 * `global.setup.ts` executes with its own Playwright import.
 */

/** The slice of Playwright's `Page` the sign-in recipe touches. */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForURL(url: string | RegExp): Promise<unknown>;
  waitForSelector(selector: string): Promise<unknown>;
}

export const STORAGE_STATE_DIR = "playwright/.auth";

/**
 * Where the signed-in browser state for `role` is written.
 *
 * ONE FILE PER ROLE, never a shared one. Playwright runs projects in parallel
 * against the same file, and a Clerk session refresh rotates the token inside
 * it — two workers reusing one state race, one of them writes a rotated token
 * the other has already invalidated, and the suite fails with a sign-in
 * redirect in whichever spec happened to be second. Reproducing that is a bad
 * afternoon.
 *
 * The directory MUST be gitignored. A storage state file is a live session: it
 * holds a bearer token for the seeded test user, and committing it publishes
 * one.
 */
export function storageStatePath(role: string): string {
  // Slugified because the role reaches the filesystem. A role read from an env
  // var as `Tenant Owner` would otherwise produce a path with a space in it
  // that quotes correctly on macOS and not in a Windows CI shell.
  const slug = slugify(role) || "default";
  return `${STORAGE_STATE_DIR}/${slug}.json`;
}

export interface ClerkSelectors {
  /** Clerk's components carry `cl-` classes; they are stable across releases. */
  readonly clerkLoaded: string;
  readonly signInRoot: string;
  /** Present only once a session exists — the signal that sign-in finished. */
  readonly signedIn: string;
}

export interface ClerkSignInStep {
  readonly description: string;
  /** The call the project's setup file makes, as text. */
  readonly call: string;
}

export interface ClerkSignInRecipe {
  readonly role: string;
  readonly storageState: string;
  readonly baseUrl: string;
  readonly signInPath: string;
  readonly afterSignInPath: string;
  readonly selectors: ClerkSelectors;
  readonly steps: readonly ClerkSignInStep[];
}

export interface ClerkSignInRecipeOptions {
  /** Defaults to `http://localhost:3000`. */
  readonly baseUrl?: string;
  /** Where Clerk mounts `<SignIn />`. Defaults to `/sign-in`. */
  readonly signInPath?: string;
  /** Where a signed-in user lands. Defaults to `/dashboard`. */
  readonly afterSignInPath?: string;
}

const CLERK_SELECTORS: ClerkSelectors = {
  clerkLoaded: ".cl-loaded",
  signInRoot: ".cl-signIn-root",
  signedIn: ".cl-userButton-root",
};

/**
 * The documented sign-in flow for one role, as steps a project's global setup
 * runs.
 *
 * NO PASSWORD APPEARS ANYWHERE IN IT, and that is the point. Clerk Testing
 * Tokens get the automated browser past bot protection, and a sign-in ticket —
 * minted server-side from `CLERK_SECRET_KEY`, single-use and short-lived —
 * puts the session in place without a credential form. So there are no test
 * passwords to store in CI secrets, none to rotate when someone leaves, and
 * nothing durable to leak: a ticket that appears in a CI log has already been
 * consumed by the run that printed it.
 *
 * The alternative every project reaches for first is a `TEST_USER_PASSWORD`
 * secret and `page.fill('input[name=password]')`. That secret is a real
 * credential for a real account in a real Clerk instance, it is shared across
 * every fork's CI, and typing it into the form makes the suite fail whenever
 * Clerk's bot detection decides an automated browser looks automated.
 */
export function clerkSignInRecipe(
  role: string,
  options: ClerkSignInRecipeOptions = {},
): ClerkSignInRecipe {
  const baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const signInPath = options.signInPath ?? "/sign-in";
  const afterSignInPath = options.afterSignInPath ?? "/dashboard";
  const storageState = storageStatePath(role);

  return {
    role,
    storageState,
    baseUrl,
    signInPath,
    afterSignInPath,
    selectors: CLERK_SELECTORS,
    steps: [
      {
        description:
          `Mint a single-use sign-in ticket for the seeded "${role}" user with ` +
          `the Clerk Backend API. Server side, in global setup — CLERK_SECRET_KEY ` +
          `must never reach the browser context.`,
        call:
          "await clerkClient.signInTokens.createSignInToken(" +
          "{ userId, expiresInSeconds: 60 })",
      },
      {
        description:
          "Attach a Testing Token to the page, so Clerk skips bot protection " +
          "for this context. Without it the sign-in page renders a challenge " +
          "and the run fails with a timeout rather than an auth error.",
        call: "await setupClerkTestingToken({ page })",
      },
      {
        description:
          "Visit the sign-in route carrying the ticket. Clerk consumes the " +
          "ticket and establishes the session; no form is filled.",
        call: `await page.goto(${JSON.stringify(
          ticketUrl(baseUrl, signInPath, "<ticket>"),
        )})`,
      },
      {
        description:
          `Wait for the landing route AND for ${CLERK_SELECTORS.signedIn}. The ` +
          `URL changes before Clerk has written the session, so saving state on ` +
          `the URL alone captures a browser that is not signed in yet — which ` +
          `fails later, in an unrelated spec, as a redirect to /sign-in.`,
        call:
          `await page.waitForURL("**${afterSignInPath}"); ` +
          `await page.waitForSelector("${CLERK_SELECTORS.signedIn}")`,
      },
      {
        description:
          `Save the state to ${storageState}, and list that directory in ` +
          `.gitignore. Every spec for this role then starts signed in, with no ` +
          `sign-in cost per test.`,
        call:
          `await page.context().storageState(` +
          `{ path: ${JSON.stringify(storageState)} })`,
      },
    ],
  };
}

/**
 * Steps 3 and 4, executed.
 *
 * Takes a structural `PageLike` so the project passes its own Playwright
 * `Page` and this package still imports nothing. It exists mainly to make the
 * two-part wait unskippable: `waitForURL` alone returns before Clerk has
 * written the session, and a `storageState` captured at that moment contains a
 * browser that is not signed in — which surfaces three specs later as a
 * redirect to /sign-in and gets blamed on the spec it broke.
 */
export async function redeemSignInTicket(
  page: PageLike,
  recipe: ClerkSignInRecipe,
  ticket: string,
): Promise<void> {
  await page.goto(ticketUrl(recipe.baseUrl, recipe.signInPath, ticket));
  await page.waitForURL(`**${recipe.afterSignInPath}`);
  await page.waitForSelector(recipe.selectors.signedIn);
}

/**
 * The URL a sign-in ticket is redeemed at.
 *
 * `__clerk_ticket` is Clerk's own query parameter. Built here rather than
 * pasted into each project's setup file because the ticket has to be
 * percent-encoded: it is a JWT, and the `+` characters base64 produces decode
 * to spaces on the way in, which fails as "invalid ticket" with nothing to
 * suggest the encoding is at fault.
 */
export function ticketUrl(baseUrl: string, signInPath: string, ticket: string): string {
  const url = new URL(signInPath, `${baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("__clerk_ticket", ticket);
  return url.toString();
}
