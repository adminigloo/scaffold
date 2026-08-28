import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import {
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
    email_addresses: [
      { id: "idn_1", email_address: "Someone@Example.com" },
      { id: "idn_2", email_address: "alt@example.com" },
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
