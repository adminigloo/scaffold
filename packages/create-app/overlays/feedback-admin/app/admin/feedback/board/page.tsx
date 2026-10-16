import { redirect } from "next/navigation";

/**
 * The board used to live here, beside a separate queue page. Since Tenancy
 * 2b-2a the board IS /admin/feedback (its panel shows everything the queue
 * did), so old bookmarks land there.
 */
export default function FeedbackBoardRedirect() {
  redirect("/admin/feedback");
}
