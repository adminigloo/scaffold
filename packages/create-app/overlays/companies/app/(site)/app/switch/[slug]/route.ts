import { redirect } from "next/navigation";
import { TenancyError } from "__SCOPE__/tenancy/server";
import { currentPrincipal } from "@/server/auth";
import { safeSwitchNext } from "@/server/company-links";
import { tenancy } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE LINK IN AN EMAIL TO A __TENANT_LABEL_LOWER__'S OWN SCREENS (Tenancy 2a, D2):
 * /app/switch/{web address}?next=/app/schedule.
 *
 * An email to the office can't know which __TENANT_LABEL_LOWER__ its reader has
 * open — someone in two of them would otherwise click "see the new request"
 * and land on the OTHER one's schedule. So every private link an email
 * carries comes through here, which:
 *
 *   1. sends someone signed out to sign in, and back here after;
 *   2. finds the __TENANT_LABEL_LOWER__ by its web address (current or old,
 *      active or suspended — a suspended one's screen then explains);
 *   3. switches the person to it — ONLY if they belong to it: for a stranger
 *      the switch is refused ("not found") and nothing changes;
 *   4. opens `next`, which must be a page of the working area (/app/…) or
 *      the dashboard. Anything else — another site, a protocol-relative URL —
 *      goes to the dashboard instead.
 *
 * A stranger therefore lands on `next` with their OWN __TENANT_LABEL_LOWER__,
 * never on someone else's data. And a GET that moves the pointer is safe to be
 * triggered from another site: it can only ever select a
 * __TENANT_LABEL_LOWER__ the person already belongs to.
 */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const url = new URL(request.url);
  const next = safeSwitchNext(url.searchParams.get("next"));
  const principal = await currentPrincipal();
  if (!principal) redirect(`/sign-in?redirect_url=${encodeURIComponent(`${url.pathname}${url.search}`)}`);

  const found = await tenancy.resolvePublicCompany(slug);
  if (found) {
    try {
      await tenancy.setActiveCompany({ userId: principal.userId, tenantId: found.company.id });
    } catch (error) {
      // Not theirs: nothing is switched, and they go on to `next` in their
      // own company. Anything else is a real failure and is not swallowed.
      if (!(error instanceof TenancyError && error.code === "not_found")) throw error;
    }
  }
  redirect(next);
}
