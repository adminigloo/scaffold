import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { users } from "__SCOPE__/auth/schema";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { InsufficientCreditsError, isCreditUnit, WALLET_REASONS } from "__SCOPE__/wallet";
import { walletBalances } from "__SCOPE__/wallet/schema";
import { adjustWallet, listWalletLedger } from "__SCOPE__/wallet/server";
import { db } from "@/db";
import { requestContext } from "../request-context";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * THE STAFF SIDE OF EVERYONE'S CREDITS (wallet 0.1, create-app 0.43).
 *
 * What a `credits` grant put in people's accounts, what they spent, and the
 * one write staff may make: an adjustment, with a note, audited as sensitive
 * in the same transaction. The page at /admin/credits reads through these via
 * `api()`, so it is authorized by the same `requireStaff(...)` rungs a browser
 * request meets.
 *
 * Spending is not here. An app spends credits in its own code, on its own
 * rules, with `spendWallet` from @__SCOPE_NAME__/wallet/server.
 */

/**
 * Actions this router writes to the audit log, merged into `src/server/audit.ts`
 * like the catalog router's. Sensitive, because an adjustment is money made or
 * destroyed by hand, and the compliance slice is where that question is asked.
 */
export const creditsAuditedActions = {
  "credits.balance.adjusted": {
    label: "Adjusted someone's credit balance by hand",
    sensitive: true,
  },
} as const satisfies Record<string, { label: string; sensitive?: boolean }>;

const creditsAuditRegistry = defineAuditedActions(creditsAuditedActions);

const LIMIT = z.number().int().min(1).max(500).default(100);

function balanceFilters(unit: string | undefined, search: string | null): SQL[] {
  const filters: SQL[] = [];
  if (unit) filters.push(eq(walletBalances.unit, unit));
  if (search) {
    const match = or(
      ilike(users.email, search),
      ilike(users.displayName, search),
      ilike(walletBalances.holderId, search),
    );
    if (match) filters.push(match);
  }
  return filters;
}
const UNIT = z.string().refine(isCreditUnit, "a lower-case unit slug such as crowns");

export const creditsRouter = createTRPCRouter({
  /** Every balance, largest first, with whose it is. */
  balances: requireStaff("credits.balances.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        unit: UNIT.optional(),
        search: z.string().trim().max(200).optional(),
        limit: LIMIT,
      }),
    )
    .query(async ({ input }) => {
      const search = input.search ? `%${input.search}%` : null;
      const rows = await db
        .select({
          holderId: walletBalances.holderId,
          unit: walletBalances.unit,
          balance: walletBalances.balance,
          updatedAt: walletBalances.updatedAt,
          email: users.email,
          name: users.displayName,
        })
        .from(walletBalances)
        // A holder is usually a person (the shop credits the buyer), but the
        // column is plain text: a wallet kept per company has no users row,
        // and still lists.
        .leftJoin(users, eq(users.id, walletBalances.holderId))
        .where(and(...balanceFilters(input.unit, search)))
        .orderBy(desc(walletBalances.balance), walletBalances.holderId)
        .limit(input.limit);
      return { rows };
    }),

  /** The units anyone holds, for the page's filter. */
  units: requireStaff("credits.balances.view")
    .meta({ scope: "staff" })
    .query(async () => {
      const rows = await db
        .selectDistinct({ unit: walletBalances.unit })
        .from(walletBalances)
        .orderBy(walletBalances.unit);
      return { units: rows.map((row) => row.unit) };
    }),

  /** The ledger, newest first: grants, spends, refunds and adjustments. */
  ledger: requireStaff("credits.balances.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        holderId: z.string().min(1).max(200).optional(),
        unit: UNIT.optional(),
        reason: z.enum(WALLET_REASONS).optional(),
        beforeId: z.number().int().positive().optional(),
        limit: LIMIT,
      }),
    )
    .query(async ({ input }) => {
      const entries = await listWalletLedger(db, {
        ...(input.holderId ? { holderId: input.holderId } : {}),
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.beforeId ? { beforeId: input.beforeId } : {}),
        limit: input.limit,
      });
      const ids = [...new Set(entries.flatMap((e) => [e.holderId, ...(e.actorId ? [e.actorId] : [])]))];
      const people =
        ids.length === 0
          ? []
          : await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids));
      const emailOf = new Map(people.map((p) => [p.id, p.email]));
      return {
        entries: entries.map((e) => ({
          ...e,
          holderEmail: emailOf.get(e.holderId) ?? null,
          actorEmail: e.actorId ? (emailOf.get(e.actorId) ?? null) : null,
        })),
      };
    }),

  /**
   * Add or take away credits by hand. A note is required, the actor is the
   * signed-in staff member, and the audit row lands in the same transaction
   * as the movement, or neither does. Taking away more than someone holds is
   * refused with what they DO hold, rather than clamped to a different
   * adjustment than the one staff typed.
   */
  adjust: requireStaff("credits.balances.adjust")
    .meta({ scope: "staff" })
    .input(
      z.object({
        holderId: z.string().min(1).max(200),
        unit: UNIT,
        delta: z
          .number()
          .int()
          .refine((value) => value !== 0, "an adjustment adds or takes away at least one")
          .refine((value) => Math.abs(value) <= 1_000_000, "at most a million at a time"),
        note: z.string().trim().min(3, "say why, in a few words").max(500),
        /** One per form submission, so a double click adjusts once. */
        attempt: z.string().regex(/^[\w-]{8,64}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const request = await requestContext();
      try {
        return await db.transaction(async (tx) => {
          const moved = await adjustWallet(tx, {
            holderId: input.holderId,
            unit: input.unit,
            delta: input.delta,
            note: input.note,
            actorId: ctx.principal.userId,
            ref: `adjust:${input.attempt}`,
          });
          if (moved.applied) {
            await tx.insert(auditLog).values(
              auditEntry(creditsAuditRegistry, {
                action: "credits.balance.adjusted",
                actor: ctx.principal,
                scope: "staff",
                tenantId: null,
                resourceType: "wallet",
                resourceId: `${input.holderId}:${input.unit}`,
                request,
                metadata: {
                  holderId: input.holderId,
                  unit: input.unit,
                  delta: input.delta,
                  balance: moved.balance,
                  note: input.note,
                },
              }),
            );
          }
          return moved;
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError || (error as { name?: string })?.name === "InsufficientCreditsError") {
          const short = error as InsufficientCreditsError;
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `They hold ${short.balance} ${short.unit}; ${short.wanted} can't be taken away.`,
          });
        }
        throw error;
      }
    }),
});
