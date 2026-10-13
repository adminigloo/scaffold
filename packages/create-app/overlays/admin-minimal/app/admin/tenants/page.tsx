import { redirect } from "next/navigation";

/**
 * The old read-only list of __TENANT_LABEL_PLURAL_LOWER__. It is the operator
 * console at /admin/companies now (Tenancy 1): search, open one, suspend or
 * reactivate it, give it a new owner. Kept as a redirect so bookmarks and old
 * links still land somewhere.
 */
export default function TenantsPage(): never {
  redirect("/admin/companies");
}
