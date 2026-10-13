import { buildTenancyOperatorHandlers } from "@/server/tenancy-handlers";

/**
 * The platform owner's routes: every company (search, page, detail),
 * suspend and reactivate, give a company whose owner closed their account a
 * new owner, release a company's old web addresses, and People with staff
 * roles. The operator console's screens talk to these.
 *
 * MOUNTED IN EVERY PROJECT, with or without an admin shell — the admin
 * router's reasoning: each route checks its own staff permission on every
 * call, so a project with no admin pages still answers correctly (403), and
 * adding a shell later needs no new wiring.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { handle } = buildTenancyOperatorHandlers();

export const GET = handle;
export const POST = handle;
