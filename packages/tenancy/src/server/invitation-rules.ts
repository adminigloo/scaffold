import { sql } from "drizzle-orm";
import type { Ctx } from "./context.js";
import { num, q, str, strOrNull } from "./db.js";
import type { RequestFacts, TenancyDb } from "./types.js";

/**
 * Withdraw the open invitations one person sent in one company, when their
 * authority to send them ends (review T1-03).
 *
 * WHY. An invitation is issued on the inviter's authority. Without this, an
 * admin who expected to be let go could invite a second address they control,
 * be removed, and rejoin through the open invitation — which sits in the
 * pending list where an owner has no reason to connect it to the person they
 * just removed. So:
 *
 *   - removal, leaving and a closed account withdraw ALL their open
 *     invitations in that company (`minRank: 0`);
 *   - a demotion withdraws the ones they could no longer send: those carrying
 *     a role at or above their new rank (`minRank: newRank`).
 *
 * A hand-over of ownership does NOT call this: the previous owner chose to
 * hand over and stays an admin the new owner trusts, and the pending list
 * shows the new owner exactly what is outstanding.
 *
 * The caller holds the company lock (D7). Each withdrawal is audited as
 * `invitation.revoked` with `via`, so the trail says why a link stopped
 * working.
 */
export async function revokeOpenInvitationsBy(
  ctx: Ctx,
  tx: TenancyDb,
  input: {
    readonly tenantId: string;
    readonly inviterUserId: string;
    readonly minRank: number;
    readonly via: string;
    readonly actorUserId?: string | null;
    readonly request?: RequestFacts;
  },
): Promise<number> {
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/revoke-by-inviter */
      update tenant_invitations i
      set revoked_at = ${ctx.now()}, revoked_by = ${input.actorUserId ?? null}
      where i.tenant_id = ${input.tenantId}
        and i.invited_by = ${input.inviterUserId}
        and i.accepted_at is null and i.revoked_at is null
        and coalesce((select rt.rank from role_template rt where rt.id = i.template_id), 0) >= ${input.minRank}
      returning i.id, i.email, (select rt.key from role_template rt where rt.id = i.template_id) as role_key`,
  );
  for (const row of rows) {
    await ctx.audit(tx, {
      action: "invitation.revoked",
      actorUserId: input.actorUserId ?? null,
      scope: "tenant",
      tenantId: input.tenantId,
      resourceType: "tenant_invitation",
      resourceId: str(row["id"]),
      metadata: { email: str(row["email"]), roleKey: strOrNull(row["role_key"]), via: input.via, inviter: input.inviterUserId },
      request: input.request ?? null,
    });
  }
  return rows.length;
}

/** Open = not accepted, not revoked (expired ones still hold the address's slot). */
export async function openInvitationFor(
  tx: TenancyDb,
  tenantId: string,
  email: string,
): Promise<{ id: string; roleKey: string | null; rank: number } | null> {
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/open-invitation */
      select i.id, rt.key as role_key, coalesce(rt.rank, 0) as rank
      from tenant_invitations i left join role_template rt on rt.id = i.template_id
      where i.tenant_id = ${tenantId} and i.email = ${email} and i.accepted_at is null and i.revoked_at is null
      limit 1`,
  );
  const row = rows[0];
  return row ? { id: str(row["id"]), roleKey: strOrNull(row["role_key"]), rank: num(row["rank"]) } : null;
}
