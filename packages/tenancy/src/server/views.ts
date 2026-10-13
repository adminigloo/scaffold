import type { RoleKey } from "../wire.js";
import { statusOf, type CompanyRow } from "./db.js";
import type { CompanyView } from "./types.js";

/** The public path a company's pages live under (reserved in Tenancy 1; Tenancy 2 serves pages there). */
export function publicPathOf(slug: string): string {
  return `/t/${slug}`;
}

export function companyView(row: CompanyRow, caller: { readonly userId: string; readonly role: RoleKey | null } | null): CompanyView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    status: statusOf(row),
    logoUrl: row.branding.logoUrl ?? null,
    brandColor: row.branding.brandColor ?? null,
    onBrandColor: row.branding.onBrandColor ?? null,
    publicPath: publicPathOf(row.slug),
    createdAt: row.createdAt,
    role: caller?.role ?? null,
    isOwner: caller !== null && row.ownerUserId === caller.userId,
  };
}
