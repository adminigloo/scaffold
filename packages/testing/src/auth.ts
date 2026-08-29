import { createHash } from "node:crypto";
import { Webhook } from "svix";
import type { Principal } from "@adminigloo/auth";
import { deterministicId, fixedTime } from "./deterministic.js";

/**
 * A `Principal` with everything filled in.
 *
 * The defaults exist so a test states only the field it is about. A test named
 * "denies a member the refund button" that opens with six lines of identity
 * boilerplate makes the one interesting field — the permission set — the least
 * visible thing in it.
 *
 * Shallow merge, deliberately: `Principal` is flat, and a deep merge would be a
 * behaviour nobody can predict for `impersonatedBy`, where `undefined` and
 * `null` mean different things to `isImpersonating`.
 */
export function buildPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: deterministicId("principal", 0),
    externalId: "user_2testprincipal0000000000",
    email: "ada@example.com",
    ...overrides,
  };
}

/**
 * A staff principal.
 *
 * `asStaff` and `asTenantUser` differ ONLY in their identifiers, and that is
 * the honest shape of the model: `Principal` carries no scope, no role and no
 * tenant, because @adminigloo/permissions resolves scope from the assignment
 * rows rather than from the identity. A `scope: "staff"` field here would be a
 * second, unenforced source of truth — and the first test to set it would
 * "prove" a staff-only route works while the resolver, which never reads it,
 * happily answers for a tenant user.
 *
 * What the two builders do buy is distinct ids. A test that mixes both and gets
 * one shared `userId` passes an authorization check that would fail in
 * production for the most boring possible reason.
 */
export function asStaff(overrides: Partial<Principal> = {}): Principal {
  return buildPrincipal({
    userId: deterministicId("staff", 0),
    externalId: "user_2teststaff00000000000000",
    email: "staff@example.com",
    ...overrides,
  });
}

export function asTenantUser(overrides: Partial<Principal> = {}): Principal {
  return buildPrincipal({
    userId: deterministicId("tenant-user", 0),
    externalId: "user_2testtenantuser0000000000",
    email: "member@example.com",
    ...overrides,
  });
}

export type IdentityEventType = "user.created" | "user.updated" | "user.deleted";

export interface IdentityPayloadOverrides {
  readonly id?: string;
  /**
   * The one address on the account, which `primary_email_address_id` then
   * points at. `null` models a user with no email at all — phone sign-in, or a
   * deleted address — which is why the row's column is nullable.
   */
  readonly email?: string | null;
  /**
   * Several addresses, in array order. Pair it with `primaryEmailIndex` to put
   * the primary somewhere other than first: that is the only payload that can
   * tell a correct `primaryEmail` from one that just reads
   * `email_addresses[0]`, and the two agree on every single-address fixture.
   *
   * Takes precedence over `email`.
   */
  readonly emails?: readonly string[];
  /** Which address `primary_email_address_id` names. Defaults to the first. */
  readonly primaryEmailIndex?: number;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly imageUrl?: string | null;
  /** The provider's own `updated_at`, in epoch milliseconds. */
  readonly updatedAt?: number | null;
}

/** A fixture asked for a payload Clerk could never send. */
export class IdentityFixtureError extends Error {
  readonly name = "IdentityFixtureError";
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly email_address: string;
}

/** Opaque to Clerk; these only have to be distinct and stable per index. */
function emailAddressId(index: number): string {
  return `idn_2testemail${String(index).padStart(15, "0")}`;
}

function emailAddresses(
  overrides: IdentityPayloadOverrides,
): readonly ClerkEmailAddress[] {
  if (overrides.emails !== undefined) {
    return overrides.emails.map((address, index) => ({
      id: emailAddressId(index),
      email_address: address,
    }));
  }
  const email = overrides.email === undefined ? "ada@example.com" : overrides.email;
  return email === null ? [] : [{ id: emailAddressId(0), email_address: email }];
}

/**
 * A Clerk-shaped webhook body.
 *
 * Clerk's exact shape, including the `email_addresses` array and the
 * `primary_email_address_id` pointer into it, because that indirection is the
 * part `verifyIdentityWebhook` has to get right: a payload with one address and
 * no primary pointer, and a payload whose primary pointer names the second
 * address, resolve to different emails. A flattened `{ email }` fixture would
 * exercise neither and would let a regression in `primaryEmail` ship.
 *
 * A single-address fixture does not exercise it either — the pointer and
 * `email_addresses[0]` name the same row, so a resolver that ignores the
 * pointer entirely passes. `{ emails, primaryEmailIndex }` is what makes the
 * two answers differ, and it is the only reason this function takes them.
 */
export function identityWebhookPayload(
  type: IdentityEventType,
  overrides: IdentityPayloadOverrides = {},
): Record<string, unknown> {
  const externalId = overrides.id ?? "user_2testprincipal0000000000";
  const addresses = emailAddresses(overrides);
  const primaryIndex = overrides.primaryEmailIndex ?? 0;

  // A pointer into nothing is worse than no pointer: `primaryEmail` falls back
  // to `email_addresses[0]`, so the test still gets an email, still passes, and
  // proves nothing about the indirection it was written to cover.
  if (
    overrides.primaryEmailIndex !== undefined &&
    (primaryIndex < 0 || primaryIndex >= addresses.length)
  ) {
    throw new IdentityFixtureError(
      `primaryEmailIndex ${primaryIndex} names no address: this payload has ` +
        `${addresses.length}. Pass the addresses in \`emails\` and index into ` +
        `that array.`,
    );
  }

  const primary = addresses[primaryIndex];

  return {
    type,
    object: "event",
    data: {
      id: externalId,
      email_addresses: addresses,
      primary_email_address_id: primary?.id ?? null,
      first_name: overrides.firstName === undefined ? "Ada" : overrides.firstName,
      last_name: overrides.lastName === undefined ? "Lovelace" : overrides.lastName,
      image_url: overrides.imageUrl ?? null,
      updated_at:
        overrides.updatedAt === undefined ? fixedTime().getTime() : overrides.updatedAt,
    },
  };
}

export interface SignedWebhookRequest {
  /**
   * The exact bytes to hand the route. Pass THIS string on, never a re-encoded
   * `JSON.stringify(JSON.parse(body))` — the signature covers the byte
   * sequence, and a round trip through the parser reorders keys.
   */
  readonly body: string;
  /** `svix-id`, `svix-timestamp`, `svix-signature`, lowercased. */
  readonly headers: Record<string, string>;
}

export interface SignUserEventOptions {
  /**
   * The `svix-id`. Defaults to a hash of the body, so signing the same payload
   * twice yields the same message id — which is what makes a redelivery test a
   * redelivery rather than two different events.
   */
  readonly id?: string;
  /**
   * ONLY for a test that asserts the tolerance window itself rejects a stale
   * delivery. Everything else must take the default.
   */
  readonly timestamp?: Date;
}

export interface FakeIdentityProvider {
  signUserEvent(
    payload: unknown,
    secret: string,
    options?: SignUserEventOptions,
  ): SignedWebhookRequest;
}

/**
 * Produce webhook requests that Clerk's own verifier accepts.
 *
 * Signed with svix — the same library `verifyIdentityWebhook` verifies with —
 * so a webhook test runs the REAL verification path. Stubbing
 * `verifyIdentityWebhook` instead is the version of this test that always
 * passes: it asserts the handler works on input the handler will never see, and
 * says nothing about the case that matters, which is a forged request being
 * rejected.
 *
 * THE DEFAULT TIMESTAMP IS THE CURRENT TIME, and it has to be. svix enforces a
 * ±5 minute tolerance against `Date.now()` at verify time, so a fixture frozen
 * at a literal date passes on the day it is written and fails for every run
 * after — a green suite that turns red an hour later with a signature error
 * pointing at the webhook code, which is fine. That has already happened here
 * once.
 */
export function fakeIdentityProvider(): FakeIdentityProvider {
  return {
    signUserEvent(payload, secret, options = {}) {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      const id =
        options.id ??
        `msg_${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 24)}`;
      const timestamp = options.timestamp ?? new Date();

      // svix signs over `${id}.${seconds}.${body}` and re-derives the timestamp
      // from the header at verify time, so the header MUST carry the same
      // truncated-to-seconds value that was signed. Formatting it from
      // `timestamp` a second time is what keeps those two in step.
      const seconds = Math.floor(timestamp.getTime() / 1000);
      const signature = new Webhook(secret).sign(id, timestamp, body);

      return {
        body,
        headers: {
          "svix-id": id,
          "svix-timestamp": String(seconds),
          "svix-signature": signature,
        },
      };
    },
  };
}
