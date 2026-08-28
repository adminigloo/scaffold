import { Webhook } from "svix";

export type IdentityEventType = "user.created" | "user.updated" | "user.deleted";

export interface IdentityEvent {
  readonly id: string;
  readonly type: IdentityEventType;
  readonly externalId: string;
  readonly email: string | null;
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

interface ClerkPayload {
  readonly type: string;
  readonly data: {
    readonly id: string;
    readonly email_addresses?: readonly {
      readonly id: string;
      readonly email_address: string;
    }[];
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

function primaryEmail(payload: ClerkPayload): string | null {
  const addresses = payload.data.email_addresses ?? [];
  const primaryId = payload.data.primary_email_address_id;
  const primary = primaryId
    ? addresses.find((a) => a.id === primaryId)
    : addresses[0];
  return (primary ?? addresses[0])?.email_address?.toLowerCase() ?? null;
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
 */
export function shouldApplyEvent(
  event: Pick<IdentityEvent, "providerUpdatedAt">,
  storedProviderUpdatedAt: Date | null | undefined,
): boolean {
  if (!storedProviderUpdatedAt) return true;
  if (!event.providerUpdatedAt) return false;
  return event.providerUpdatedAt.getTime() >= storedProviderUpdatedAt.getTime();
}
