import { isPersonalWorkspaceId } from "__SCOPE__/tenancy";
import { tenancy } from "./tenancy";

/**
 * Which __TENANT_LABEL_LOWER__ a signed-in person is looking at.
 *
 * Every tenant-scoped procedure takes `tenantId` as input, which is correct —
 * the ladder resolves permissions for the tenant named in the request and
 * nothing else. But a PAGE has to decide which id to pass, and this is the one
 * place that decides it, so no page reads a tenant id from a query string.
 *
 * THE ANSWER IS THE SESSION'S (Tenancy 1): `tenancy.resolveSession` — the
 * company the person last switched to, if they are still an active member of
 * it and it isn't suspended; otherwise a deterministic fallback (their other
 * companies, oldest first). The pointer is a preference, never an authority:
 * it is re-checked against the membership gate on every call, so a removed
 * member is never shown the company they were removed from.
 *
 * Null means there is no company to show: a new owner who hasn't named theirs
 * yet, someone removed from their only one, or a company that is suspended.
 * Pages that need the reason (onboarding, the suspended screen) use
 * <CompanyGate>, which reads the same session; the account and billing pages
 * only need "which one, if any", which is this.
 */
export interface CurrentTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** True for a personal workspace, rather than a company someone named. */
  readonly isPersonal: boolean;
}

export async function currentTenantFor(userId: string): Promise<CurrentTenant | null> {
  const session = await tenancy.resolveSession({ userId });
  if (session.state !== "ready") return null;
  return {
    id: session.company.id,
    name: session.company.name,
    slug: session.company.slug,
    isPersonal: session.company.kind === "personal" || isPersonalWorkspaceId(session.company.id),
  };
}
