import { redirect } from "next/navigation";

/** The column editor moved into the board's settings (Tenancy 2b-2a); old bookmarks land there. */
export default function FeedbackColumnsRedirect() {
  redirect("/admin/feedback/settings");
}
