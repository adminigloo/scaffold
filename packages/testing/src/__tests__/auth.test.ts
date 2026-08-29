import { describe, expect, it } from "vitest";
import { isImpersonating, verifyIdentityWebhook } from "@adminigloo/auth";
import {
  asStaff,
  asTenantUser,
  buildPrincipal,
  fakeIdentityProvider,
  IdentityFixtureError,
  identityWebhookPayload,
} from "../auth.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER_SECRET = "whsec_bm90IHRoZSBzYW1lIHNlY3JldCEhIQ==";

describe("buildPrincipal", () => {
  it("fills every required field, so a test states only what it is about", () => {
    const principal = buildPrincipal();
    expect(principal.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(principal.externalId).toMatch(/^user_/);
    expect(principal.email).toBe("ada@example.com");
  });

  it("merges overrides shallowly", () => {
    const principal = buildPrincipal({ email: null, userId: "u_fixed" });
    expect(principal.userId).toBe("u_fixed");
    expect(principal.email).toBeNull();
    expect(principal.externalId).toMatch(/^user_/);
  });

  it("is stable across calls", () => {
    expect(buildPrincipal()).toEqual(buildPrincipal());
  });

  it("carries impersonation through, so isImpersonating is testable", () => {
    expect(isImpersonating(buildPrincipal())).toBe(false);
    expect(isImpersonating(buildPrincipal({ impersonatedBy: "u_staff" }))).toBe(true);
    // Explicit null is "not impersonating", the state the column holds for
    // every ordinary request.
    expect(isImpersonating(buildPrincipal({ impersonatedBy: null }))).toBe(false);
  });
});

describe("asStaff / asTenantUser", () => {
  it("give the two a different userId", () => {
    // A shared id makes a tenant-isolation test pass for the most boring
    // possible reason: the "other" user is the same user.
    expect(asStaff().userId).not.toBe(asTenantUser().userId);
    expect(asStaff().externalId).not.toBe(asTenantUser().externalId);
  });

  it("stay overridable", () => {
    expect(asStaff({ email: "root@example.com" }).email).toBe("root@example.com");
    expect(asTenantUser({ impersonatedBy: asStaff().userId }).impersonatedBy).toBe(
      asStaff().userId,
    );
  });
});

describe("fakeIdentityProvider — the real verification path", () => {
  const provider = fakeIdentityProvider();

  it("produces a request verifyIdentityWebhook accepts", () => {
    const { body, headers } = provider.signUserEvent(
      identityWebhookPayload("user.created"),
      SECRET,
    );

    const event = verifyIdentityWebhook(body, headers, SECRET);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("user.created");
    expect(event?.email).toBe("ada@example.com");
    expect(event?.displayName).toBe("Ada Lovelace");
    expect(event?.externalId).toBe("user_2testprincipal0000000000");
  });

  it("sends the three headers svix reads, lowercased", () => {
    const { headers } = provider.signUserEvent({ type: "user.created" }, SECRET);
    expect(Object.keys(headers).sort()).toEqual([
      "svix-id",
      "svix-signature",
      "svix-timestamp",
    ]);
    expect(headers["svix-signature"]).toMatch(/^v1,/);
    expect(headers["svix-timestamp"]).toMatch(/^\d{10}$/);
  });

  it("rejects a body edited after signing", () => {
    // The property that makes this fixture worth having. A stubbed verifier
    // accepts this happily, and the route that forgot to verify passes its
    // tests right up until someone posts their own JSON at it.
    const { body, headers } = provider.signUserEvent(
      identityWebhookPayload("user.created"),
      SECRET,
    );
    const tampered = body.replace("ada@example.com", "attacker@example.com");

    expect(() => verifyIdentityWebhook(tampered, headers, SECRET)).toThrow(
      /verification failed/i,
    );
  });

  it("rejects a signature from a different endpoint's secret", () => {
    const { body, headers } = provider.signUserEvent(
      identityWebhookPayload("user.updated"),
      OTHER_SECRET,
    );
    expect(() => verifyIdentityWebhook(body, headers, SECRET)).toThrow(
      /verification failed/i,
    );
  });

  it("rejects a re-serialised body, the way a route that parses first would", () => {
    // `JSON.stringify(JSON.parse(body))` is what a route does when it reads the
    // request with `await req.json()` and passes an object on. The bytes change,
    // the HMAC no longer matches, and the error is identical to a forgery — so
    // a test that never tries it cannot tell the two apart later.
    const payload = identityWebhookPayload("user.created", { firstName: "Grace" });
    const { body, headers } = provider.signUserEvent(payload, SECRET);
    const parsed = JSON.parse(body) as { readonly data: unknown };
    const reordered = JSON.stringify({ data: parsed.data, type: "user.created" });

    expect(reordered).not.toBe(body);
    expect(() => verifyIdentityWebhook(reordered, headers, SECRET)).toThrow();
  });

  it("gives the same payload the same svix-id, so a redelivery is a redelivery", () => {
    // The ledger is keyed on this id. If two signings of one payload produced
    // two ids, an idempotency test would be inserting two different events and
    // asserting nothing.
    const payload = identityWebhookPayload("user.created");
    const first = provider.signUserEvent(payload, SECRET);
    const second = provider.signUserEvent(payload, SECRET);
    expect(second.headers["svix-id"]).toBe(first.headers["svix-id"]);
    expect(verifyIdentityWebhook(second.body, second.headers, SECRET)?.id).toBe(
      first.headers["svix-id"],
    );
  });

  it("signs with the CURRENT time, so the suite still passes tomorrow", () => {
    // svix enforces a ±5 minute tolerance against Date.now() at verify time. A
    // fixture frozen at a literal date passes on the day it is written and
    // fails for every run after — which has happened here before, and reads as
    // a signature bug in the webhook code rather than as a stale fixture.
    const { headers } = provider.signUserEvent({ type: "user.created" }, SECRET);
    const signedAt = Number(headers["svix-timestamp"]) * 1000;
    expect(Math.abs(Date.now() - signedAt)).toBeLessThan(5_000);
  });

  it("can still produce a stale delivery, so the tolerance itself is testable", () => {
    const stale = provider.signUserEvent(identityWebhookPayload("user.created"), SECRET, {
      timestamp: new Date(Date.now() - 10 * 60 * 1000),
    });
    expect(() => verifyIdentityWebhook(stale.body, stale.headers, SECRET)).toThrow(
      /verification failed/i,
    );
  });
});

describe("identityWebhookPayload", () => {
  const provider = fakeIdentityProvider();
  const verified = (payload: unknown) => {
    const { body, headers } = provider.signUserEvent(payload, SECRET);
    return verifyIdentityWebhook(body, headers, SECRET);
  };

  it("resolves the primary address rather than the first one", () => {
    // THE POINT OF THE FIXTURE. Clerk's `primary_email_address_id` points into
    // `email_addresses`, and with one address the pointer and index 0 name the
    // same row — so a resolver that ignores the pointer entirely passes. Two
    // addresses with the PRIMARY SECOND is the only payload where the two
    // answers differ.
    const payload = identityWebhookPayload("user.updated", {
      emails: ["old@example.com", "grace@example.com"],
      primaryEmailIndex: 1,
    });

    expect(verified(payload)?.email).toBe("grace@example.com");
    expect(verified(payload)?.email).not.toBe("old@example.com");
  });

  it("emits the array and the pointer Clerk actually sends", () => {
    // Asserted on the fixture itself, not through the verifier: a fixture that
    // flattened back to `{ email }` would still satisfy the test above by
    // accident once `primaryEmail`'s fallback kicked in.
    const payload = identityWebhookPayload("user.updated", {
      emails: ["old@example.com", "grace@example.com"],
      primaryEmailIndex: 1,
    }) as {
      readonly data: {
        readonly email_addresses: readonly { id: string; email_address: string }[];
        readonly primary_email_address_id: string | null;
      };
    };

    expect(payload.data.email_addresses).toHaveLength(2);
    expect(payload.data.primary_email_address_id).toBe(
      payload.data.email_addresses[1]?.id,
    );
    expect(payload.data.primary_email_address_id).not.toBe(
      payload.data.email_addresses[0]?.id,
    );
  });

  it("refuses a primary pointer that names no address", () => {
    // A dangling pointer makes `primaryEmail` fall back to the first address,
    // so the test would still get an email and still pass — proving nothing
    // about the indirection it was written to cover.
    expect(() =>
      identityWebhookPayload("user.updated", {
        emails: ["only@example.com"],
        primaryEmailIndex: 1,
      }),
    ).toThrow(IdentityFixtureError);
  });

  it("keeps the pointer valid for the single-address default", () => {
    const payload = identityWebhookPayload("user.created") as {
      readonly data: {
        readonly email_addresses: readonly { id: string }[];
        readonly primary_email_address_id: string | null;
      };
    };
    expect(payload.data.primary_email_address_id).toBe(
      payload.data.email_addresses[0]?.id,
    );
  });

  it("lowercases the address the way the normaliser does", () => {
    const event = verified(
      identityWebhookPayload("user.created", { email: "ADA@Example.com" }),
    );
    expect(event?.email).toBe("ada@example.com");
  });

  it("models a user with no email at all", () => {
    // Sign-in with a phone number, or a deleted address. The row's email column
    // is nullable for this reason, and the fixture has to be able to reach it.
    const event = verified(identityWebhookPayload("user.created", { email: null }));
    expect(event?.email).toBeNull();
    expect(identityWebhookPayload("user.created", { emails: [] })).toMatchObject({
      data: { email_addresses: [], primary_email_address_id: null },
    });
  });

  it("carries providerUpdatedAt, which is what orders out-of-order deliveries", () => {
    const at = Date.UTC(2026, 5, 1);
    const event = verified(identityWebhookPayload("user.updated", { updatedAt: at }));
    expect(event?.providerUpdatedAt?.getTime()).toBe(at);
  });

  it("passes an unhandled event type through as null rather than throwing", () => {
    expect(verified({ type: "session.created", data: { id: "sess_1" } })).toBeNull();
  });
});
