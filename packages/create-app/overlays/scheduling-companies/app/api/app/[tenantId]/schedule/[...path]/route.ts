import { buildSchedulingAdminHandlers } from "@/server/scheduling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's own schedule, for its screens: /app/schedule, today's route and
 * Schedule settings call /api/app/{company id}/schedule/v1/admin/….
 *
 * THE COMPANY IS THE ONE IN THE PATH, never the session's active company. A
 * tab still showing Green Acres acts on Green Acres even after the person
 * switched to Summit in another tab — and every call is asked, for that id,
 * whether the caller is signed in, a member, not suspended and holding the
 * route's permission (src/server/company-routes.ts). A made-up id is "not part
 * of this company"; the pages' gate is a convenience, this is the boundary.
 *
 * Never cross-origin: no CORS headers, and a POST another site sent is
 * refused, so a signed-in owner's cookie can't be used from elsewhere.
 */
const { handle } = buildSchedulingAdminHandlers();

export const GET = handle;
export const POST = handle;
