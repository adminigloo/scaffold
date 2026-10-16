import { redirect } from "next/navigation";

/** The category editor moved into the board's settings (Tenancy 2b-2a); old bookmarks land there. */
export default function FeedbackCategoriesRedirect() {
  redirect("/admin/feedback/settings");
}
