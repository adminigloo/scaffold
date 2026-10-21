import { createDrizzlePermissionLoaders } from "__SCOPE__/permissions/server";
import { db } from "@/db";
import { membershipGate } from "./membership";
import { gateLoaders } from "./plan-gate";

/**
 * The two permission loaders the procedure ladder and every page read, and
 * the explanation a refused tenant call gets.
 *
 *   loadTenantPermissions({ principal, tenantId })  NULL when not a member
 *   loadStaffPermissions({ principal })             NULL when not staff
 *   explainTenantDenial({ principal, tenantId })    "company-suspended" or "not-a-member"
 *
 * A FEW LINES, ON PURPOSE (Tenancy 1). The rules that used to be written out
 * here — membership checked FIRST and separately, so a stray role row can't
 * admit a stranger; null for "not a member" rather than an empty set, which
 * would read as "a member granted nothing"; overrides layered on the
 * template — now live in @__SCOPE_NAME__/permissions/server, where a fix
 * reaches this project by `npm update`. The why-comments moved with them.
 *
 * THE MEMBERSHIP GATE is @__SCOPE_NAME__/tenancy's (handed over by
 * src/server/membership.ts), and it is where a suspended company is enforced:
 * one place, for the loaders, the company routes and the pages. Everyone in a
 * suspended company gets "Access to this account is suspended" from the
 * tenant rung instead of "not a member". In a project whose customers are
 * people (--audience consumers) it is narrowed to each person's OWN account,
 * so nobody acts in anyone else's (create-app 0.39). src/server/membership.ts
 * imports no app module, so this one never joins the import cycle
 * src/server/tenancy.ts sits in.
 *
 * THE PLAN (billing 0.3). `gateLoaders` is the one place a company's plan
 * reaches the tRPC rung and every page gate: while a company's plan is closed
 * (its trial ran out, its plan ended, or its card kept failing), its people
 * keep only reading, billing, the team and company settings. In a project
 * that doesn't sell plans, src/server/plan-gate.ts hands the loaders back
 * untouched. Staff permissions are never trimmed.
 */
export const { loadTenantPermissions, loadStaffPermissions, explainTenantDenial } = gateLoaders(
  createDrizzlePermissionLoaders(db, { membership: membershipGate }),
);
