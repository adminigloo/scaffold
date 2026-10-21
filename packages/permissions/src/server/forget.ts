import { eq, inArray, sql } from "drizzle-orm";
import { principalOverride, principalRole, roleTemplate, roleTemplateGrant } from "../schema.js";
import type { PermissionsDb } from "./db.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every role and
 * per-person grant held IN the company, and any role template of its own with
 * its grants — roles before the templates they point at, each statement
 * filtered by the company's id. Run it on the deletion's transaction. Staff
 * roles and the site-wide templates live under "*" and are never one
 * company's: an empty id and "*" are refused.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PermissionsDb, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const templates = db.select({ id: roleTemplate.id }).from(roleTemplate).where(eq(roleTemplate.tenantId, tenantId));
  const counts: Record<string, number> = {};
  counts["principal_override"] = (await db.delete(principalOverride).where(eq(principalOverride.tenantId, tenantId)).returning(one)).length;
  counts["principal_role"] = (await db.delete(principalRole).where(eq(principalRole.tenantId, tenantId)).returning(one)).length;
  counts["role_template_grant"] = (await db.delete(roleTemplateGrant).where(inArray(roleTemplateGrant.templateId, templates)).returning(one)).length;
  counts["role_template"] = (await db.delete(roleTemplate).where(eq(roleTemplate.tenantId, tenantId)).returning(one)).length;
  return counts;
}
