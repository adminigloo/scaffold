import { jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { updatedAt } from "@adminigloo/db";

/**
 * One row per person per dashboard: their arrangement, whole (`layout.ts`).
 *
 * `board` names WHICH dashboard: "admin" for the staff dashboard at /admin.
 * It's in the key so a second dashboard (a company's own, later) is a new
 * value here rather than a new table.
 *
 * No row is written just by opening the dashboard. Someone who never arranged
 * theirs has no row and sees the defaults, so a card made default-on later
 * reaches them too.
 *
 * Nothing in here is a business's record: it's where one person put their
 * cards. The cards' contents are read live, through each feature's own rules,
 * every time they're drawn.
 */
export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    board: text("board").notNull(),
    userId: text("user_id").notNull(),
    layout: jsonb("layout").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.board, t.userId] })],
);
