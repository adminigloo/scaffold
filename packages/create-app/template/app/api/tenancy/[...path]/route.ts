import { buildTenancyHandlers } from "@/server/tenancy-handlers";

/**
 * Every company route — session, create, switch, profile, branding, logo,
 * settings, checklist, team, invitations — served by the package's handlers
 * (Tenancy 1). The widget's screens talk to these.
 *
 * ONE LINE OF WIRING, on purpose. Who may remove whom, who may invite at what
 * role, which origin a write may come from and how fast: all of it lives in
 * @__SCOPE_NAME__/tenancy, so a fix reaches this project by `npm update`
 * instead of being frozen into a copy. The construction (the database, the
 * mailer, the rate limiter, the error log) is in src/server/tenancy-handlers.ts.
 *
 * Every company route names its company in the PATH and is authorised against
 * that id — never "whichever company is active" — so a stale tab can't act on
 * the wrong company.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { handle } = buildTenancyHandlers();

export const GET = handle;
export const POST = handle;
