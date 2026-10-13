import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import {
  isResurrection,
  shouldApplyEvent,
  verifyIdentityWebhook,
  WebhookVerificationError,
} from "../webhook.js";

// A real svix secret so the tests exercise genuine signature verification
// rather than a stub. Signing the payload here is the only way to prove the
// verify path actually runs — a mock would pass even if we removed the check.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function signed(payload: unknown, id = "msg_test_1", at: Date = new Date()) {
  const body = JSON.stringify(payload);
  const timestamp = at;
  const signature = new Webhook(SECRET).sign(id, timestamp, body);
  return {
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
  };
}

const userCreated = {
  type: "user.created",
  data: {
    id: "user_2abc",
    // Clerk's real payload carries a verification object per address. The
    // fixture says "verified" because only verified addresses are mirrored
    // (see "mirrors VERIFIED addresses only" below).
    email_addresses: [
      { id: "idn_1", email_address: "Someone@Example.com", verification: { status: "verified" } },
      { id: "idn_2", email_address: "alt@example.com", verification: { status: "verified" } },
    ],
    primary_email_address_id: "idn_1",
    first_name: "Dallin",
    last_name: "Humphrey",
    image_url: "https://img.clerk.com/x",
    updated_at: 1756382400000,
  },
};

describe("verifyIdentityWebhook", () => {
  it("verifies a genuinely signed payload and normalises it", () => {
    const { body, headers } = signed(userCreated);
    const event = verifyIdentityWebhook(body, headers, SECRET);
    expect(event).toEqual({
      id: "msg_test_1",
      type: "user.created",
      externalId: "user_2abc",
      email: "someone@example.com",
      verifiedEmails: ["someone@example.com", "alt@example.com"],
      displayName: "Dallin Humphrey",
      imageUrl: "https://img.clerk.com/x",
      providerUpdatedAt: new Date(1756382400000),
    });
  });

  it("rejects a tampered body", () => {
    const { body, headers } = signed(userCreated);
    const tampered = body.replace("user_2abc", "user_attacker");
    expect(() => verifyIdentityWebhook(tampered, headers, SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a payload signed with a different secret", () => {
    const { body, headers } = signed(userCreated);
    expect(() =>
      verifyIdentityWebhook(body, headers, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toThrow(WebhookVerificationError);
  });

  it("returns null for event types it does not handle", () => {
    const { body, headers } = signed({ type: "session.created", data: { id: "sess_1" } });
    expect(verifyIdentityWebhook(body, headers, SECRET)).toBeNull();
  });

  it("lowercases the email so matching is deterministic", () => {
    const { body, headers } = signed(userCreated);
    expect(verifyIdentityWebhook(body, headers, SECRET)?.email).toBe(
      "someone@example.com",
    );
  });

  it("picks the primary address, not merely the first", () => {
    const { body, headers } = signed({
      ...userCreated,
      data: { ...userCreated.data, primary_email_address_id: "idn_2" },
    });
    expect(verifyIdentityWebhook(body, headers, SECRET)?.email).toBe("alt@example.com");
  });

  it("tolerates a user with no name and no email", () => {
    const { body, headers } = signed({
      type: "user.created",
      data: { id: "user_bare" },
    });
    const event = verifyIdentityWebhook(body, headers, SECRET);
    expect(event?.displayName).toBeNull();
    expect(event?.email).toBeNull();
  });

  it("rejects a replayed request outside the signing window", () => {
    // svix enforces a ~5 minute tolerance. Worth asserting rather than
    // assuming: without it, a captured request stays valid forever.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const { body, headers } = signed(userCreated, "msg_stale", stale);
    expect(() => verifyIdentityWebhook(body, headers, SECRET)).toThrow(
      WebhookVerificationError,
    );
  });

  it("uses only the first name when there is no last name", () => {
    const { body, headers } = signed({
      type: "user.created",
      data: { id: "u", first_name: "Cher", last_name: null },
    });
    expect(verifyIdentityWebhook(body, headers, SECRET)?.displayName).toBe("Cher");
  });
});

describe("shouldApplyEvent — out-of-order delivery", () => {
  const older = new Date("2026-08-01T00:00:00Z");
  const newer = new Date("2026-08-28T00:00:00Z");

  it("applies anything to a row that has never seen an event", () => {
    expect(shouldApplyEvent({ providerUpdatedAt: older }, null)).toBe(true);
    expect(shouldApplyEvent({ providerUpdatedAt: null }, undefined)).toBe(true);
  });

  it("applies a newer event", () => {
    expect(shouldApplyEvent({ providerUpdatedAt: newer }, older)).toBe(true);
  });

  it("REJECTS a stale event that would overwrite newer data", () => {
    expect(shouldApplyEvent({ providerUpdatedAt: older }, newer)).toBe(false);
  });

  it("applies a redelivery of the same timestamp — idempotent, not skipped", () => {
    expect(shouldApplyEvent({ providerUpdatedAt: newer }, newer)).toBe(true);
  });

  it("rejects an undated event against a dated row rather than guessing", () => {
    expect(shouldApplyEvent({ providerUpdatedAt: null }, newer)).toBe(false);
  });
});

describe("mirrors VERIFIED addresses only (review T1-02 / TB-DEPLOY-09)", () => {
  // users.email decides who the BOOTSTRAP_ADMIN_EMAIL person is and who may
  // accept an invitation. An address the provider never verified must not
  // become it, or anybody can add the founder's address to their own account.
  it("never mirrors an unverified address, even with no primary set", () => {
    const { body, headers } = signed({
      type: "user.updated",
      data: {
        id: "user_attacker",
        email_addresses: [
          { id: "idn_x", email_address: "founder@site.test", verification: { status: "unverified" } },
        ],
        primary_email_address_id: null,
        updated_at: 1756382400000,
      },
    });
    const event = verifyIdentityWebhook(body, headers, SECRET);
    expect(event?.email).toBeNull();
    expect(event?.verifiedEmails).toEqual([]);
  });

  it("skips an unverified primary and takes the first verified address", () => {
    const { body, headers } = signed({
      type: "user.updated",
      data: {
        id: "user_2",
        email_addresses: [
          { id: "idn_a", email_address: "claimed@site.test", verification: { status: "unverified" } },
          { id: "idn_b", email_address: "Real@Example.com", verification: { status: "verified" } },
        ],
        primary_email_address_id: "idn_a",
        updated_at: 1756382400000,
      },
    });
    const event = verifyIdentityWebhook(body, headers, SECRET);
    expect(event?.email).toBe("real@example.com");
    expect(event?.verifiedEmails).toEqual(["real@example.com"]);
  });

  it("treats an address with no verification object as unverified", () => {
    const { body, headers } = signed({
      type: "user.created",
      data: { id: "u", email_addresses: [{ id: "i", email_address: "x@y.test" }] },
    });
    expect(verifyIdentityWebhook(body, headers, SECRET)?.email).toBeNull();
  });
});

describe("deletions always apply and are final (review T1-08)", () => {
  const stored = new Date("2026-08-28T00:00:00Z");

  it("applies Clerk's undated user.deleted against a row the webhook dated", () => {
    // Clerk's user.deleted payload is { id, deleted: true, object: "user" }
    // with no updated_at. The staleness rule used to skip it, so deprovision
    // never ran for anybody the webhook had ever written.
    const { body, headers } = signed({ type: "user.deleted", data: { id: "user_gone", deleted: true, object: "user" } });
    const event = verifyIdentityWebhook(body, headers, SECRET);
    expect(event?.type).toBe("user.deleted");
    expect(event?.providerUpdatedAt).toBeNull();
    expect(shouldApplyEvent(event!, stored)).toBe(true);
  });

  it("still skips an undated user.updated against a dated row", () => {
    expect(shouldApplyEvent({ type: "user.updated", providerUpdatedAt: null }, stored)).toBe(false);
  });

  it("never lets a late created/updated bring a deleted row back", () => {
    const deletedRow = { deletedAt: new Date("2026-09-01T00:00:00Z") };
    expect(isResurrection({ type: "user.updated" }, deletedRow)).toBe(true);
    expect(isResurrection({ type: "user.created" }, deletedRow)).toBe(true);
    expect(isResurrection({ type: "user.deleted" }, deletedRow)).toBe(false);
    expect(isResurrection({ type: "user.updated" }, { deletedAt: null })).toBe(false);
    expect(isResurrection({ type: "user.updated" }, null)).toBe(false);
  });
});
