import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * Local identity mirror.
 *
 * Clerk owns credentials and sessions. This table owns everything else, and
 * every foreign key in every other package points here.
 *
 * THE PRIMARY KEY IS OURS, NOT THE PROVIDER'S. riddler-go uses the Clerk id as
 * the PK directly, which is simpler and is the reason it cannot change identity
 * providers without rewriting every foreign key in the database. Here the
 * provider id lives in `external_id` behind a unique index, so swapping Clerk
 * for WorkOS or Auth.js is an update to one column on one table.
 *
 * Soft delete, because webhook events arrive out of order: a hard delete makes
 * a late `user.updated` unreconcilable, and the row comes back as a duplicate.
 */
export const users = pgTable(
  "users",
  {
    id: idColumn(),
    identityProvider: text("identity_provider").notNull().default("clerk"),
    /** The provider's own user id. */
    externalId: text("external_id").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    imageUrl: text("image_url"),
    /**
     * Which tenant this user is currently working in.
     *
     * A POINTER, NOT AN AUTHORITY. Membership is what grants access; this only
     * disambiguates which of several memberships is active. A stale or revoked
     * pointer falls back to deterministic membership ordering and is rewritten.
     * No foreign key: a deleted tenant must not block writes here.
     */
    activeTenantId: text("active_tenant_id"),
    /**
     * The provider's own `updated_at` for the last event applied.
     *
     * Webhook delivery is not ordered. Without this, a retried `user.created`
     * arriving after a `user.updated` overwrites the newer data with older data
     * and nothing looks wrong.
     */
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("users_provider_external_id_idx").on(t.identityProvider, t.externalId),
    index("users_email_idx").on(t.email),
  ],
);

/**
 * Delivered webhook events, keyed on the provider's event id.
 *
 * Same two-phase pattern the Stripe ledger uses: claim the row, run the
 * handler, stamp `processed_at` only on success. `received_at` alone cannot
 * distinguish "in flight" from "done", which is what makes a crashed handler
 * look like a completed one.
 */
export const identityWebhookEvents = pgTable("identity_webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  receivedAt: createdAt(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  attempts: text("attempts").notNull().default("0"),
  lastError: text("last_error"),
});

export const authSchema = { users, identityWebhookEvents };
