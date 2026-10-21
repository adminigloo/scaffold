import { NextResponse, type NextRequest } from "next/server";
import { currentPrincipal } from "@/server/auth";
import { recordFirstPayment } from "@/server/conversions";

/**
 * WHERE STRIPE'S CHECKOUT SENDS SOMEONE WHO PAID (create-app 0.39): their
 * first payment is marked on their visit (src/server/conversions.ts — with
 * analytics; nothing without), so the site's numbers show which pages bring
 * paying people. Then a 307 to the billing page, where the plan appears as
 * soon as Stripe's webhook has landed.
 *
 * THE CHECKOUT SESSION ID STRIPE ADDS (?session_id=) is what the first
 * payment is judged on (review): Stripe's own record of it — complete, paid,
 * for this person's account — never the fact of arriving here, which a free
 * trial, a refresh or a pasted link also are. The billing page itself still
 * reads the plan from the subscription.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const principal = await currentPrincipal().catch(() => null);
  if (principal) await recordFirstPayment(principal.userId, req.nextUrl.searchParams.get("session_id"));
  return NextResponse.redirect(new URL("/account/billing", req.url), 307);
}
