import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationState,
  normaliseInviteEmail,
  verifyInvitationToken,
  type InvitationLifecycle,
} from "../invitations.js";

describe("generateInvitationToken", () => {
  it("returns a token whose hash is the stored hash", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(tokenHash);
    expect(verifyInvitationToken(token, tokenHash)).toBe(true);
  });

  it("emits 32 bytes as base64url, with no URL-hostile characters", () => {
    const { token } = generateInvitationToken();
    // 32 bytes unpadded base64 is 43 characters.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats — the token is a bearer credential, not an identifier", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInvitationToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it("does not put the raw token anywhere near the hash", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashInvitationToken", () => {
  it("is SHA-256 hex of the token, not of anything else", () => {
    const token = "0123456789abcdef";
    expect(hashInvitationToken(token)).toBe(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
  });

  it("is stable, so a re-issued lookup finds the same row", () => {
    expect(hashInvitationToken("abc")).toBe(hashInvitationToken("abc"));
  });

  it("changes completely for a one-character difference", () => {
    expect(hashInvitationToken("abc")).not.toBe(hashInvitationToken("abd"));
  });
});

describe("verifyInvitationToken", () => {
  const { token, tokenHash } = generateInvitationToken();

  it("accepts the matching token", () => {
    expect(verifyInvitationToken(token, tokenHash)).toBe(true);
  });

  it("rejects a different token", () => {
    expect(verifyInvitationToken(generateInvitationToken().token, tokenHash)).toBe(false);
  });

  it("rejects a token that differs by one character", () => {
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyInvitationToken(tampered, tokenHash)).toBe(false);
  });

  it("rejects an EMPTY stored hash instead of accepting anything", () => {
    // The regression this guards: comparing hex-DECODED buffers would turn an
    // empty stored hash into an empty buffer, equal to nothing, and
    // timingSafeEqual(<empty>, <empty>) is true — an unconditional bypass.
    expect(verifyInvitationToken(token, "")).toBe(false);
  });

  it("rejects a stored hash that is not hex at all, without throwing", () => {
    // Buffer.from("zzzz...", "hex") yields an empty buffer. Same bypass, via a
    // corrupt row rather than an empty one.
    expect(verifyInvitationToken(token, "z".repeat(64))).toBe(false);
    expect(verifyInvitationToken(token, "not-a-hash")).toBe(false);
  });

  it("rejects a truncated stored hash rather than matching its prefix", () => {
    expect(verifyInvitationToken(token, tokenHash.slice(0, 32))).toBe(false);
  });

  it("rejects a stored hash with trailing whitespace", () => {
    expect(verifyInvitationToken(token, `${tokenHash} `)).toBe(false);
  });

  it("rejects an empty token against a real hash", () => {
    expect(verifyInvitationToken("", tokenHash)).toBe(false);
  });

  it("compares the full digest — a shared 63-character prefix is not enough", () => {
    const nearMiss = `${tokenHash.slice(0, 63)}${tokenHash.endsWith("0") ? "1" : "0"}`;
    expect(verifyInvitationToken(token, nearMiss)).toBe(false);
  });
});

describe("invitationState — precedence", () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");
  const future = new Date("2026-12-01T00:00:00Z");

  const row = (over: Partial<InvitationLifecycle> = {}): InvitationLifecycle => ({
    expiresAt: future,
    revokedAt: null,
    acceptedAt: null,
    ...over,
  });

  it("is pending when nothing has happened and it has not expired", () => {
    expect(invitationState(row(), now)).toBe("pending");
  });

  it("is pending forever when expiresAt is NULL", () => {
    expect(invitationState(row({ expiresAt: null }), now)).toBe("pending");
  });

  it("is expired once the deadline has passed", () => {
    expect(invitationState(row({ expiresAt: past }), now)).toBe("expired");
  });

  it("is accepted when accepted and still live", () => {
    expect(invitationState(row({ acceptedAt: past }), now)).toBe("accepted");
  });

  it("is revoked when revoked and still live", () => {
    expect(invitationState(row({ revokedAt: past }), now)).toBe("revoked");
  });

  it("REVOKED beats ACCEPTED — revocation is the undo for a wrong acceptance", () => {
    expect(
      invitationState(row({ revokedAt: now, acceptedAt: past }), now),
    ).toBe("revoked");
  });

  it("REVOKED beats EXPIRED", () => {
    expect(
      invitationState(row({ revokedAt: past, expiresAt: past }), now),
    ).toBe("revoked");
  });

  it("ACCEPTED beats EXPIRED — acceptance is a fact about the past", () => {
    // If this reported "expired", an admin would re-issue and the invitee would
    // end up joining the tenant twice.
    expect(
      invitationState(row({ acceptedAt: past, expiresAt: past }), now),
    ).toBe("accepted");
  });

  it("REVOKED wins over accepted AND expired together", () => {
    expect(
      invitationState(
        row({ revokedAt: past, acceptedAt: past, expiresAt: past }),
        now,
      ),
    ).toBe("revoked");
  });

  it("treats the expiry instant itself as expired", () => {
    expect(invitationState(row({ expiresAt: now }), now)).toBe("expired");
  });

  it("is still pending one millisecond before expiry", () => {
    const almost = new Date(now.getTime() + 1);
    expect(invitationState(row({ expiresAt: almost }), now)).toBe("pending");
  });

  it("defaults `now` to the current clock", () => {
    expect(invitationState(row({ expiresAt: new Date(Date.now() - 1000) }))).toBe(
      "expired",
    );
    expect(invitationState(row({ expiresAt: new Date(Date.now() + 60_000) }))).toBe(
      "pending",
    );
  });
});

describe("normaliseInviteEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseInviteEmail("  Ada@Example.COM \n")).toBe("ada@example.com");
  });

  it("leaves an already-canonical address alone", () => {
    expect(normaliseInviteEmail("ada@example.com")).toBe("ada@example.com");
  });

  it("makes case variants collide, which is what the partial unique index needs", () => {
    expect(normaliseInviteEmail("Ada@Example.com")).toBe(
      normaliseInviteEmail("ada@example.com"),
    );
  });

  it("keeps +tags and dots — those address different mailboxes at some providers", () => {
    expect(normaliseInviteEmail("Ada.Lovelace+team@Example.com")).toBe(
      "ada.lovelace+team@example.com",
    );
  });

  it("does not invent an address from whitespace", () => {
    expect(normaliseInviteEmail("   ")).toBe("");
  });
});
