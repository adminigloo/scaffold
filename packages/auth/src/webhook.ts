import { Webhook } from "svix";

export type IdentityEventType = "user.created" | "user.updated" | "user.deleted";

export interface IdentityEvent {
  readonly id: string;
  readonly type: IdentityEventType;
  readonly externalId: string;
  /**
   * The person's VERIFIED address, lowercased: the primary one when it is
   * verified, otherwise the first verified one, otherwise null. Never an
   * address the provider has not verified (see `primaryEmail`).
   */
  readonly email: string | null;
  /** Every verified address on the account, lowercased (joining by verified email, D19). */
  readonly verifiedEmails: readonly string[];
  readonly displayName: string | null;
  readonly imageUrl: string | null;
  /** The provider's own updated_at, used to reject out-of-order deliveries. */
  readonly providerUpdatedAt: Date | null;
}

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";
  constructor(cause?: unknown) {
    super(
      "Identity webhook signature verification failed. The request was not sent " +
        "by the identity provider, or CLERK_WEBHOOK_SIGNING_SECRET does not match " +
        "the endpoint it was issued for.",
      { cause },
    );
  }
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly email_address: string;
  readonly verification?: { readonly status?: string | null } | null;
}

interface ClerkPayload {
  readonly type: string;
  readonly data: {
    readonly id: string;
    readonly email_addresses?: readonly ClerkEmailAddress[];
    readonly primary_email_address_id?: string | null;
    readonly first_name?: string | null;
    readonly last_name?: string | null;
    readonly image_url?: string | null;
    readonly updated_at?: number | null;
  };
}

/**
 * Verify the signature and normalise the payload.
 *
 * Deliberately split from the persistence step: verification is pure and
 * testable without a database, and a caller that wants to handle events
 * differently still cannot skip the signature check.
 */
export function verifyIdentityWebhook(
  body: string,
  headers: Record<string, string>,
  signingSecret: string,
): IdentityEvent | null {
  let payload: ClerkPayload;
  try {
    payload = new Webhook(signingSecret).verify(body, headers) as ClerkPayload;
  } catch (cause) {
    throw new WebhookVerificationError(cause);
  }

  if (!isHandledType(payload.type)) return null;

  return {
    id: headers["svix-id"] ?? payload.data.id,
    type: payload.type,
    externalId: payload.data.id,
    email: primaryEmail(payload),
    verifiedEmails: verifiedAddresses(payload).map((a) => a.email_address.toLowerCase()),
    displayName: fullName(payload),
    imageUrl: payload.data.image_url ?? null,
    providerUpdatedAt: payload.data.updated_at
      ? new Date(payload.data.updated_at)
      : null,
  };
}

function isHandledType(type: string): type is IdentityEventType {
  return type === "user.created" || type === "user.updated" || type === "user.deleted";
}

function verifiedAddresses(payload: ClerkPayload): readonly ClerkEmailAddress[] {
  return (payload.data.email_addresses ?? []).filter(
    (a) =>
      typeof a.email_address === "string" &&
      a.email_address.length > 0 &&
      a.verification?.status === "verified",
  );
}

/**
 * The address mirrored into `users.email`: VERIFIED ONLY.
 *
 * *** AN UNVERIFIED ADDRESS NEVER BECOMES THE ACCOUNT'S EMAIL. ***
 *
 * `users.email` decides two grants: who may accept an invitation (the address
 * it was sent to must match) and who the BOOTSTRAP_ADMIN_EMAIL person is, i.e.
 * who becomes platform administrator on a fresh deploy. An earlier version took
 * `addresses[0]` when no primary was set and never read the verification
 * status, so on a Clerk instance that lets people add an address without
 * proving it (phone or username sign-in, or verification switched off),
 * anybody could add the founder's address to their own account and be
 * mirrored as the founder. Now the primary address wins when it is verified;
 * otherwise the first verified one; otherwise none.
 */
function primaryEmail(payload: ClerkPayload): string | null {
  const verified = verifiedAddresses(payload);
  const primaryId = payload.data.primary_email_address_id;
  const primary = primaryId ? verified.find((a) => a.id === primaryId) : undefined;
  return (primary ?? verified[0])?.email_address.toLowerCase() ?? null;
}

function fullName(payload: ClerkPayload): string | null {
  const parts = [payload.data.first_name, payload.data.last_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Should this event be applied, given what we already stored?
 *
 * Webhook delivery is not ordered and providers retry. Applying an event older
 * than the row's current state overwrites newer data with stale data, and
 * nothing about the result looks wrong.
 *
 * A DELETION ALWAYS APPLIES. Clerk's `user.deleted` payload is
 * `{ id, deleted: true, object: "user" }`, with no `updated_at`, so the
 * "undated event against a dated row" rule below used to skip every deletion
 * of a user the webhook had ever written to, which on a deployed site is
 * nearly everyone. Their staff roles were never removed and their memberships
 * never suspended. Deletion is final: there is nothing newer for it to
 * overwrite, and the caller must never let a later `user.created` or
 * `user.updated` clear `deleted_at` again (`isResurrection`).
 */
export function shouldApplyEvent(
  event: Pick<IdentityEvent, "providerUpdatedAt"> & { readonly type?: IdentityEventType },
  storedProviderUpdatedAt: Date | null | undefined,
): boolean {
  if (event.type === "user.deleted") return true;
  if (!storedProviderUpdatedAt) return true;
  if (!event.providerUpdatedAt) return false;
  return event.providerUpdatedAt.getTime() >= storedProviderUpdatedAt.getTime();
}

/**
 * Would applying this event bring a deleted account back?
 *
 * A late or retried `user.created` / `user.updated` arriving after the
 * deletion must not clear `deleted_at`: the account was closed, its access was
 * taken away (`deprovisionUser`), and a resurrected row would quietly sign it
 * back in. Callers skip such an event.
 */
export function isResurrection(
  event: Pick<IdentityEvent, "type">,
  stored: { readonly deletedAt: Date | null } | null | undefined,
): boolean {
  return (
    event.type !== "user.deleted" &&
    stored !== null &&
    stored !== undefined &&
    stored.deletedAt !== null
  );
}
