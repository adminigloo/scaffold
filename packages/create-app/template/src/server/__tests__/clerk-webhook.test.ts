import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { POST } from "../../../app/api/webhooks/clerk/route";

/**
 * The Clerk webhook, on PGlite (so it runs on every `pnpm test`): deliveries
 * arrive out of order and are retried, and none of that may bring a deleted
 * account back.
 *
 * Clerk's signature check is the one thing replaced: `verifyIdentityWebhook`
 * reads the test's JSON as the verified event. Everything after it — the
 * ledger, the users row, setting the person up, taking access away — is the
 * real route against a real database.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CLERK_WEBHOOK_SIGNING_SECRET") return "whsec_test";
        return Reflect.get(target, prop);
      },
    }),
  };
});

vi.mock("__SCOPE__/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("__SCOPE__/auth")>();
  return {
    ...actual,
    verifyIdentityWebhook: (body: string) => {
      const e = JSON.parse(body) as Record<string, unknown>;
      return {
        id: String(e["id"]),
        type: e["type"],
        externalId: String(e["externalId"]),
        email: (e["email"] as string | undefined) ?? null,
        verifiedEmails: e["email"] ? [e["email"]] : [],
        displayName: null,
        imageUrl: null,
        providerUpdatedAt: e["at"] ? new Date(String(e["at"])) : null,
      };
    },
  };
});

vi.mock("@/server/rate-limit", () => ({
  limiter: { limit: async () => ({ allowed: true, limit: 1000, remaining: 999, resetAt: new Date(Date.now() + 60_000) }) },
}));

vi.mock("@/server/error-reporter", () => ({ reportError: async () => {} }));

function deliver(event: Record<string, unknown>): Promise<Response> {
  return POST(new Request("https://app.test/api/webhooks/clerk", { method: "POST", body: JSON.stringify(event) }));
}

async function admins(): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as n from principal_role pr join role_template rt on rt.id = pr.template_id
    where pr.scope = 'staff' and rt.key = 'admin'`);
  return Number((rows.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
});

describe("the Clerk webhook never brings a deleted account back (review R2 SEC-T1-G)", () => {
  it("a deletion for someone with no row yet is recorded, so the create Clerk retries afterwards changes nothing", async () => {
    // 1. user.created failed (a deploy mid-migration), so Clerk will retry it.
    // 2. The account is deleted: there is no row for it yet.
    const deleted = await deliver({ id: "evt_delete_1", type: "user.deleted", externalId: "user_gone" });
    expect(deleted.status).toBe(200);
    // 3. The retried create arrives.
    const late = await deliver({ id: "evt_create_retry", type: "user.created", externalId: "user_gone", email: "founder@example.test", at: "2026-10-01T00:00:00.000Z" });
    expect(late.status).toBe(200);
    const rows = await db.select().from(users).where(eq(users.externalId, "user_gone"));
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
    // Nobody was set up for an account that no longer exists, so nobody became
    // the first administrator on its behalf.
    expect(await admins()).toBe(0);
  });

  it("a deletion after the row exists takes the access away, and a later update can't undo it", async () => {
    await deliver({ id: "evt_create_2", type: "user.created", externalId: "user_kept", email: "kept@example.test", at: "2026-10-01T00:00:00.000Z" });
    const [before] = await db.select().from(users).where(eq(users.externalId, "user_kept"));
    expect(before?.deletedAt).toBeNull();
    await deliver({ id: "evt_delete_2", type: "user.deleted", externalId: "user_kept" });
    await deliver({ id: "evt_update_2", type: "user.updated", externalId: "user_kept", email: "kept@example.test", at: "2026-10-02T00:00:00.000Z" });
    const [after] = await db.select().from(users).where(eq(users.externalId, "user_kept"));
    expect(after?.deletedAt).not.toBeNull();
  });
});
