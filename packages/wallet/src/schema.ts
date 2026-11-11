import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, logIdColumn, updatedAt } from "@adminigloo/db";
import type { WalletReason } from "./units.js";

/**
 * TWO TABLES, AND THE LEDGER IS THE TRUTH.
 *
 * `wallet_balances` is what someone holds right now: one row per holder per
 * unit, never below zero (a CHECK, not a convention). `wallet_ledger` is every
 * movement that ever made it so, append only. The balance is kept rather than
 * summed on read because a spend has to be ONE conditional statement — "take
 * five if there are five" — and a sum cannot be locked.
 *
 * WHO A HOLDER IS IS THE APP'S BUSINESS. `holder_id` is plain text with no
 * foreign key: a consumer app keeps a wallet per person (the users row id),
 * a company app might keep one per company (the tenant id), and the shop's
 * fulfilment credits the buyer's user id. A package that guessed would be
 * wrong for half its projects, and a foreign key to `users` would make
 * company wallets impossible.
 *
 * NO MODE COLUMN. Test-mode and live-mode credits never meet because staging
 * and production never share a database (DEPLOYMENT.md in every generated
 * project).
 */
export const walletBalances = pgTable(
  "wallet_balances",
  {
    holderId: text("holder_id").notNull(),
    /** A slug such as `crowns`; see CREDIT_UNIT_PATTERN. */
    unit: text("unit").notNull(),
    balance: integer("balance").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.holderId, t.unit], name: "wallet_balances_pkey" }),
    check("wallet_balances_never_negative", sql`${t.balance} >= 0`),
  ],
);

/**
 * Every credit in or out.
 *
 * THE UNIQUE INDEX IS THE IDEMPOTENCY. A grant is keyed on the order and the
 * grant that paid for it, a spend on whatever the app spent it on, a refund on
 * the order it refunds, an adjustment on the form submission that made it. The
 * same movement arriving twice (a redelivered webhook, a double click, the
 * webhook and the page both settling one payment) finds its row already there
 * and changes nothing. Per holder and unit, so two apps' references can never
 * collide across people.
 *
 * `delta` may be ZERO only for a refund: taking back what's left of a pack the
 * person already spent records that the refund happened and took nothing,
 * which is what makes a second refund of the same order a no-op rather than a
 * second try at their newer credits.
 */
export const walletLedger = pgTable(
  "wallet_ledger",
  {
    id: logIdColumn(),
    holderId: text("holder_id").notNull(),
    unit: text("unit").notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").$type<WalletReason>().notNull(),
    ref: text("ref").notNull(),
    /** Required for an adjustment (staff say why); optional otherwise. */
    note: text("note"),
    /** The staff member behind an adjustment, or whoever the app names. */
    actorId: text("actor_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("wallet_ledger_once_idx").on(t.holderId, t.unit, t.reason, t.ref),
    index("wallet_ledger_holder_idx").on(t.holderId, t.unit, t.id),
    index("wallet_ledger_created_idx").on(t.createdAt),
    check("wallet_ledger_reason_known", sql`${t.reason} in ('grant', 'spend', 'refund', 'adjust')`),
    check("wallet_ledger_zero_only_refund", sql`${t.delta} <> 0 or ${t.reason} = 'refund'`),
  ],
);

export const walletSchema = { walletBalances, walletLedger };
