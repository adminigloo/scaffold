import { redirect } from "next/navigation";

/**
 * The 0.1 inbox's old address. Alerts live at /admin/alerts since Tenancy
 * 2b-1 (D15), so a bookmark or an old link still lands somewhere useful.
 */
export default function InboxPage(): never {
  redirect("/admin/alerts");
}
