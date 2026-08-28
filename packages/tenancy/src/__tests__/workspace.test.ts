import { describe, expect, it } from "vitest";
import {
  EmptyUserIdError,
  isPersonalWorkspaceId,
  personalWorkspaceId,
  personalWorkspaceSlug,
} from "../workspace.js";

describe("personalWorkspaceId", () => {
  it("derives the id from the user id, so it can be addressed before it exists", () => {
    expect(personalWorkspaceId("user_2abc")).toBe("ws_user_2abc");
  });

  it("is stable across calls — nothing about it is generated", () => {
    expect(personalWorkspaceId("user_2abc")).toBe(personalWorkspaceId("user_2abc"));
  });

  it("round-trips through the predicate", () => {
    expect(isPersonalWorkspaceId(personalWorkspaceId("user_2abc"))).toBe(true);
  });
});

describe("isPersonalWorkspaceId", () => {
  it("rejects an ordinary tenant id", () => {
    expect(isPersonalWorkspaceId("0199f0c4-2b7e-7c1a-9a3e-3c9f0f2a1b44")).toBe(false);
  });

  it("rejects the bare prefix — that is a malformed id, not the empty user", () => {
    expect(isPersonalWorkspaceId("ws_")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isPersonalWorkspaceId("")).toBe(false);
  });

  it("does not match the prefix mid-string", () => {
    expect(isPersonalWorkspaceId("tenant_ws_user_1")).toBe(false);
  });

  it("is case sensitive — ids are compared byte for byte everywhere else", () => {
    expect(isPersonalWorkspaceId("WS_user_1")).toBe(false);
  });
});

describe("personalWorkspaceSlug", () => {
  it("is deterministic", () => {
    expect(personalWorkspaceSlug("user_2abc")).toBe(personalWorkspaceSlug("user_2abc"));
  });

  it("is URL-safe", () => {
    for (const id of [
      "user_2abcDEF",
      "0199f0c4-2b7e-7c1a-9a3e-3c9f0f2a1b44",
      "user with spaces",
      "user+tag@weird",
      "ЖУРНАЛ",
      "..!!..",
    ]) {
      expect(personalWorkspaceSlug(id)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("keeps a readable body from the user id", () => {
    expect(personalWorkspaceSlug("user_2abc")).toMatch(/^ws-user-2abc-[a-z0-9]+$/);
  });

  it("SEPARATES ids that differ only in case", () => {
    // Both sanitise to `user-2ab`. Without the fingerprint the second user's
    // very first sign-in would die on the tenants_slug_idx unique violation.
    expect(personalWorkspaceSlug("user_2aB")).not.toBe(personalWorkspaceSlug("user_2ab"));
  });

  it("SEPARATES ids that differ only in punctuation", () => {
    expect(personalWorkspaceSlug("user_2ab")).not.toBe(personalWorkspaceSlug("user-2ab"));
  });

  it("SEPARATES long ids that share their first 40 sanitised characters", () => {
    const shared = "user_".padEnd(45, "a");
    expect(personalWorkspaceSlug(`${shared}1`)).not.toBe(
      personalWorkspaceSlug(`${shared}2`),
    );
  });

  it("still yields a valid slug for an id with nothing sanitisable in it", () => {
    const slug = personalWorkspaceSlug("...");
    expect(slug).toMatch(/^ws-[a-z0-9]+$/);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("does not leave a trailing or doubled dash from folded punctuation", () => {
    const slug = personalWorkspaceSlug("__user__2abc__");
    expect(slug).not.toMatch(/--/);
    expect(slug).toMatch(/^ws-user-2abc-[a-z0-9]+$/);
  });

  it("gives every distinct id a distinct slug across a realistic spread", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `user_2${i.toString(36)}Xy`);
    const slugs = new Set(ids.map(personalWorkspaceSlug));
    expect(slugs.size).toBe(ids.length);
  });
});

describe("regressions found in review", () => {
  it("never produces a doubled dash, even when truncation lands on one", () => {
    // The fold strips trailing dashes, then the slice cuts at 40 chars and can
    // land mid-run — reintroducing the dash right before the "-<fingerprint>"
    // suffix. Only ids long enough to hit the boundary expose it.
    for (const id of ["u_".repeat(30), "a".repeat(39) + "_b", "x_".repeat(50)]) {
      expect(personalWorkspaceSlug(id)).not.toMatch(/--/);
      expect(personalWorkspaceSlug(id)).not.toMatch(/-$/);
    }
  });

  it("refuses to mint what the predicate would disown", () => {
    // personalWorkspaceId("") returned "ws_", which isPersonalWorkspaceId
    // rejects — so the row could be created and then never recognised again.
    expect(() => personalWorkspaceId("")).toThrow(EmptyUserIdError);
    expect(() => personalWorkspaceSlug("")).toThrow(EmptyUserIdError);
  });

  it("mint and predicate are exact inverses for every id it accepts", () => {
    for (const id of ["u", "usr_alice", "0198c1f2-abcd-7000-8000-000000000000"]) {
      expect(isPersonalWorkspaceId(personalWorkspaceId(id))).toBe(true);
    }
  });
});
