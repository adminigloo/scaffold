import { describe, expect, it } from "vitest";
import {
  clerkSignInRecipe,
  redeemSignInTicket,
  storageStatePath,
  ticketUrl,
  STORAGE_STATE_DIR,
  type PageLike,
} from "../playwright.js";

describe("storageStatePath", () => {
  it("gives each role its own file", () => {
    // Never a shared file: Playwright workers run in parallel, a Clerk session
    // refresh rotates the token inside the state, and two workers sharing one
    // file log each other out.
    expect(storageStatePath("owner")).toBe(`${STORAGE_STATE_DIR}/owner.json`);
    expect(storageStatePath("owner")).not.toBe(storageStatePath("member"));
  });

  it("keeps a role read from an env var out of the filesystem's way", () => {
    expect(storageStatePath("Tenant Owner")).toBe(
      `${STORAGE_STATE_DIR}/tenant-owner.json`,
    );
    expect(storageStatePath("staff/admin")).toBe(`${STORAGE_STATE_DIR}/staff-admin.json`);
  });

  it("cannot be talked into escaping its directory", () => {
    // A role that reached here from a CI matrix value must not be able to name
    // a path outside the gitignored directory — the file it writes is a live
    // session token.
    expect(storageStatePath("../../.env")).toBe(`${STORAGE_STATE_DIR}/env.json`);
    expect(storageStatePath("")).toBe(`${STORAGE_STATE_DIR}/default.json`);
  });
});

describe("clerkSignInRecipe", () => {
  const recipe = clerkSignInRecipe("owner");

  it("mentions no password anywhere", () => {
    // The whole reason for Testing Tokens plus a sign-in ticket. A
    // TEST_USER_PASSWORD secret is a real credential for a real account, shared
    // with every fork's CI, and it has to be rotated by hand when someone
    // leaves. A ticket is single-use and expires in a minute.
    const text = JSON.stringify(recipe).toLowerCase();
    expect(text).not.toContain("password");
    expect(text).not.toContain("input[name=identifier]");
  });

  it("mints the ticket server side and keeps the secret key out of the browser", () => {
    const [mint] = recipe.steps;
    expect(mint?.call).toContain("createSignInToken");
    const browserSteps = recipe.steps.slice(1).map((step) => step.call).join(" ");
    expect(browserSteps).not.toContain("CLERK_SECRET_KEY");
  });

  it("attaches a testing token before visiting the sign-in route", () => {
    const calls = recipe.steps.map((step) => step.call);
    const token = calls.findIndex((call) => call.includes("setupClerkTestingToken"));
    const visit = calls.findIndex((call) => call.includes("page.goto"));
    // The other order renders a bot challenge and the run fails with a timeout
    // rather than an auth error, which sends everyone looking in the wrong place.
    expect(token).toBeGreaterThanOrEqual(0);
    expect(token).toBeLessThan(visit);
  });

  it("waits for the signed-in marker, not only for the URL", () => {
    const wait = recipe.steps.find((step) => step.call.includes("waitForSelector"));
    expect(wait?.call).toContain(recipe.selectors.signedIn);
  });

  it("writes to the role's own storage state", () => {
    expect(recipe.storageState).toBe(storageStatePath("owner"));
    expect(recipe.steps.at(-1)?.call).toContain(recipe.storageState);
  });

  it("carries the resolved routes, so the recipe is executable data", () => {
    const custom = clerkSignInRecipe("member", {
      baseUrl: "https://preview.example.com/",
      afterSignInPath: "/app",
    });
    expect(custom.baseUrl).toBe("https://preview.example.com");
    expect(custom.afterSignInPath).toBe("/app");
  });
});

describe("ticketUrl", () => {
  it("percent-encodes the ticket", () => {
    // Tickets are JWTs. A raw `+` in a query string decodes to a space on the
    // way in, and Clerk answers "invalid ticket" with nothing to suggest the
    // encoding is at fault.
    const url = ticketUrl("http://localhost:3000", "/sign-in", "a+b/c=d");
    expect(url).toBe("http://localhost:3000/sign-in?__clerk_ticket=a%2Bb%2Fc%3Dd");
  });

  it("does not double a slash between the origin and the path", () => {
    expect(ticketUrl("http://localhost:3000/", "/sign-in", "t")).toBe(
      "http://localhost:3000/sign-in?__clerk_ticket=t",
    );
  });
});

describe("redeemSignInTicket", () => {
  it("waits for both the route and the session before returning", async () => {
    // A structural page double — proof that nothing here needs @playwright/test
    // to be installed.
    const calls: string[] = [];
    const page: PageLike = {
      goto: async (url) => void calls.push(`goto ${url}`),
      waitForURL: async (url) => void calls.push(`waitForURL ${String(url)}`),
      waitForSelector: async (selector) => void calls.push(`waitForSelector ${selector}`),
    };

    const recipe = clerkSignInRecipe("owner");
    await redeemSignInTicket(page, recipe, "tkt_1");

    expect(calls).toEqual([
      "goto http://localhost:3000/sign-in?__clerk_ticket=tkt_1",
      "waitForURL **/dashboard",
      `waitForSelector ${recipe.selectors.signedIn}`,
    ]);
  });
});
