import { and, eq, isNull } from "drizzle-orm";
import { isPersonalWorkspaceId } from "__SCOPE__/tenancy";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";

/**
 * Which __TENANT_LABEL_LOWER__ a signed-in person is looking at.
 *
 * Every tenant-scoped procedure takes `tenantId` as input, which is correct —
 * the ladder resolves permissions for the tenant named in the request and
 * nothing else. But a PAGE has to decide which id to pass, and until this
 * existed there was nowhere to decide it: the only tenant any emitted page knew
 * about was the personal workspace, minted in `src/server/auth.ts` and
 * addressable only by re-deriving its id from the user's. So a member of a real
 * __TENANT_LABEL_LOWER__ had no route that could show it to them, and the
 * invitation surface — the one screen whose entire subject is a shared
 * __TENANT_LABEL_LOWER__ — would have pointed at the workspace of one.
 *
 * THIS IS THE SEAM, and it is deliberately the dullest possible implementation:
 * the oldest organisation the person is an active member of, falling back to
 * their personal workspace. Replace it with whatever your product actually
 * means — a subdomain, a `/t/[slug]` segment, a switcher writing a cookie — and
 * every caller keeps working, because they all ask this one question rather
 * than each inventing an answer. What must NOT happen is a page reading a
 * tenant id straight from a query string: `loadTenantPermissions` would then be
 * asked about a tenant the visitor merely typed, and the only thing standing
 * between that and a cross-tenant read is the membership check inside it.
 *
 * Organisations sort ahead of the personal workspace because a person who
 * belongs to one joined it on purpose, while the workspace was created for them
 * without being asked. Returning null means "signed in, member of nothing" —
 * which is not a state `src/server/auth.ts` produces, but is exactly what a
 * suspended-everywhere account looks like, and a caller that assumed a tenant
 * always exists would render somebody else's data or crash.
 */
export interface CurrentTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** True for the workspace minted on first sign-in, rather than one joined. */
  readonly isPersonal: boolean;
}

export async function currentTenantFor(userId: string): Promise<CurrentTenant | null> {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      createdAt: tenants.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(
      and(
        eq(tenantMembers.userId, userId),
        // Suspended keeps the row and its audit trail while blocking access, so
        // it must not select a tenant here — a suspended member landing on the
        // members page would be shown the roster they were suspended from.
        eq(tenantMembers.status, "active"),
        isNull(tenants.deletedAt),
      ),
    );

  const withKind = rows.map((row) => ({ ...row, isPersonal: isPersonalWorkspaceId(row.id) }));

  // Sorted in memory rather than in SQL. There are a handful of rows per user,
  // and expressing "organisations first, then oldest" as an ORDER BY needs a
  // CASE over an id prefix — a rule that lives in `isPersonalWorkspaceId` and
  // would then have a second, silently diverging copy written in SQL.
  const sorted = [...withKind].sort((a, b) => {
    if (a.isPersonal !== b.isPersonal) return a.isPersonal ? 1 : -1;
    return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
  });

  const chosen = sorted[0];
  if (chosen === undefined) return null;
  return {
    id: chosen.id,
    name: chosen.name,
    slug: chosen.slug,
    isPersonal: chosen.isPersonal,
  };
}
