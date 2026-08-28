import { describe, expect, it } from "vitest";
import { isImpersonating, type Principal } from "../principal.js";
import { AUTH_MODE_BOUND_KEYS, authClient, authServer } from "../env.js";

const base: Principal = { userId: "u_1", externalId: "user_2abc", email: null };

describe("isImpersonating", () => {
  it("is false for an ordinary principal", () => {
    expect(isImpersonating(base)).toBe(false);
    expect(isImpersonating({ ...base, impersonatedBy: null })).toBe(false);
  });

  it("is true when staff are acting as the user", () => {
    expect(isImpersonating({ ...base, impersonatedBy: "u_staff" })).toBe(true);
  });
});

describe("env fragments", () => {
  it("requires correctly prefixed Clerk credentials", () => {
    const server = authServer();
    expect(server.CLERK_SECRET_KEY.safeParse("sk_test_abcdefghij").success).toBe(true);
    expect(server.CLERK_SECRET_KEY.safeParse("pk_test_abcdefghij").success).toBe(false);
    expect(
      server.CLERK_WEBHOOK_SIGNING_SECRET.safeParse("whsec_abcdefghij").success,
    ).toBe(true);
  });

  it("requires a publishable key on the client", () => {
    expect(
      authClient().NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.safeParse("pk_test_abcdefghij")
        .success,
    ).toBe(true);
  });

  it("registers both mode-carrying keys, and not the webhook secret", () => {
    expect([...AUTH_MODE_BOUND_KEYS]).toEqual([
      "CLERK_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ]);
    expect(AUTH_MODE_BOUND_KEYS).not.toContain("CLERK_WEBHOOK_SIGNING_SECRET");
  });
});
