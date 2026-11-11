import { and, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { walletBalances, walletLedger } from "./schema.js";
import {
  assertCreditAmount,
  assertCreditUnit,
  InsufficientCreditsError,
  type WalletReason,
} from "./units.js";

/**
 * The wallet's writes and reads.
 *
 * EVERY WRITE IS ONE STATEMENT. Credit, spend and refund are each a single
 * SQL statement (data-modifying CTEs), so they are atomic on their own and
 * just as atomic inside a caller's transaction: fulfilment credits a pack in
 * the same transaction that books the order, and a spend can run on its own
 * against a pooled HTTP connection that has no interactive transactions at
 * all. Nothing here opens a transaction of its own.
 *
 * EVERY WRITE IS IDEMPOTENT BY (holder, unit, reason, ref). See the unique
 * index on `wallet_ledger`. A repeat returns `{ applied: false }` with the
 * balance as it stands, never an error and never a second movement.
 */

/**
 * Any drizzle Postgres database or transaction: the app's `db`, the `tx` a
 * fulfilment transaction hands its grants, a PGlite in a test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WalletDb = PgDatabase<any, any, any>;

export interface WalletMovement {
  /** False when this exact movement (holder, unit, reason, ref) had already happened. */
  readonly applied: boolean;
  /** The balance after this call, whether or not it moved anything. */
  readonly balance: number;
}

interface MovementInput {
  readonly holderId: string;
  readonly unit: string;
  readonly amount: number;
  /** What this movement is FOR, unique per holder, unit and reason: an order line, a purchase in the app. */
  readonly ref: string;
  readonly note?: string | null;
  readonly actorId?: string | null;
}

export interface CreditInput extends MovementInput {
  /** `grant` for what a purchase paid for; `adjust` is adjustWallet's. */
  readonly reason?: "grant";
}

export type SpendInput = MovementInput;

export type RefundInput = MovementInput;

export interface AdjustInput {
  readonly holderId: string;
  readonly unit: string;
  /** Positive adds, negative takes away. Never zero. */
  readonly delta: number;
  /** Why. Required: an adjustment nobody explained is the one nobody can defend. */
  readonly note: string;
  /** The staff member making it. */
  readonly actorId: string;
  /** One per form submission, so a double click adjusts once. */
  readonly ref: string;
}

export class InvalidWalletReferenceError extends Error {
  readonly name = "InvalidWalletReferenceError";
  constructor() {
    super(
      "A wallet movement needs a reference (1 to 200 characters): it is what " +
        "makes the same movement arriving twice count once.",
    );
  }
}

export class AdjustmentNoteRequiredError extends Error {
  readonly name = "AdjustmentNoteRequiredError";
  constructor() {
    super("Say why: an adjustment needs a note, and an actor to own it.");
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Add credits. For a purchase, `ref` should name the order AND the grant
 * (`${reference}:${grantId}`), so two grants on one variant are two credits.
 *
 * Ledger row first, with ON CONFLICT DO NOTHING; the balance moves only by the
 * row that was actually inserted. Two calls racing on one reference serialise
 * on the unique index: the second waits for the first to commit, finds the
 * row, inserts nothing, and so adds nothing.
 */
export async function creditWallet(db: WalletDb, input: CreditInput): Promise<WalletMovement> {
  return credit(db, { ...input, reason: input.reason ?? "grant" });
}

/**
 * Spend credits, or refuse with `InsufficientCreditsError` and spend nothing.
 *
 * "Take N if there are N" in ONE conditional UPDATE, then the ledger row from
 * what it returned. A read-then-write would let two spends both see enough
 * and both succeed; this lets exactly one.
 */
export async function spendWallet(db: WalletDb, input: SpendInput): Promise<WalletMovement> {
  return debit(db, { ...input, reason: "spend" });
}

/**
 * Take back what's left of a refunded purchase: the amount it granted, or as
 * much of it as the person still holds, never below zero. Returns how much was
 * taken. Always records a ledger row (a zero one if nothing was left), so a
 * second refund of the same order is a no-op rather than a second try at
 * credits bought since.
 */
export async function refundWallet(
  db: WalletDb,
  input: RefundInput,
): Promise<WalletMovement & { readonly taken: number }> {
  checkMovement(input);
  const { holderId, unit, amount, ref } = input;
  const note = input.note ?? null;
  const actorId = input.actorId ?? null;

  const statement = sql`
    with cur as (
      select balance from wallet_balances
      where holder_id = ${holderId} and unit = ${unit}
      for update
    ), seen as (
      select 1 from wallet_ledger
      where holder_id = ${holderId} and unit = ${unit} and reason = 'refund' and ref = ${ref}
    ), take as (
      select least(coalesce((select balance from cur), 0), ${amount}::int) as amount
    ), moved as (
      update wallet_balances
      set balance = balance - (select amount from take), updated_at = now()
      where holder_id = ${holderId} and unit = ${unit}
        and (select amount from take) > 0
        and not exists (select 1 from seen)
      returning balance
    ), entry as (
      insert into wallet_ledger (holder_id, unit, delta, reason, ref, note, actor_id)
      select ${holderId}, ${unit}, -(select amount from take), 'refund', ${ref}, ${note}, ${actorId}
      where not exists (select 1 from seen)
      returning delta
    )
    select (select amount from take) as taken,
           (select count(*) from entry)::int as recorded`;

  try {
    const [row] = await rows<{ taken: number; recorded: number }>(db, statement);
    const recorded = (row?.recorded ?? 0) > 0;
    return {
      applied: recorded,
      taken: recorded ? Number(row?.taken ?? 0) : 0,
      balance: await walletBalance(db, holderId, unit),
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { applied: false, taken: 0, balance: await walletBalance(db, holderId, unit) };
  }
}

/**
 * A staff adjustment: add or take away, with a note and an actor. Taking away
 * more than is held refuses (`InsufficientCreditsError`) rather than clamping:
 * a staff member who thinks someone holds ten and takes ten should be told
 * they hold three, not silently given a different adjustment than they made.
 * The caller writes the audit row, in the same transaction.
 */
export async function adjustWallet(db: WalletDb, input: AdjustInput): Promise<WalletMovement> {
  if (input.note.trim() === "" || input.actorId.trim() === "") throw new AdjustmentNoteRequiredError();
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    assertCreditAmount(input.delta); // throws with the standard wording
  }
  const base = {
    holderId: input.holderId,
    unit: input.unit,
    amount: Math.abs(input.delta),
    ref: input.ref,
    note: input.note.trim(),
    actorId: input.actorId,
    reason: "adjust" as const,
  };
  return input.delta > 0 ? credit(db, base) : debit(db, base);
}

async function credit(
  db: WalletDb,
  input: MovementInput & { readonly reason: "grant" | "adjust" },
): Promise<WalletMovement> {
  checkMovement(input);
  const { holderId, unit, amount, ref, reason } = input;
  const statement = sql`
    with entry as (
      insert into wallet_ledger (holder_id, unit, delta, reason, ref, note, actor_id)
      values (${holderId}, ${unit}, ${amount}::int, ${reason}, ${ref}, ${input.note ?? null}, ${input.actorId ?? null})
      on conflict (holder_id, unit, reason, ref) do nothing
      returning delta
    ), moved as (
      insert into wallet_balances (holder_id, unit, balance)
      select ${holderId}, ${unit}, delta from entry
      on conflict (holder_id, unit) do update
        set balance = wallet_balances.balance + excluded.balance, updated_at = now()
      returning balance
    )
    select (select balance from moved) as balance`;
  const [row] = await rows<{ balance: number | null }>(db, statement);
  if (row && row.balance !== null && row.balance !== undefined) {
    return { applied: true, balance: Number(row.balance) };
  }
  return { applied: false, balance: await walletBalance(db, holderId, unit) };
}

async function debit(
  db: WalletDb,
  input: MovementInput & { readonly reason: "spend" | "adjust" },
): Promise<WalletMovement> {
  checkMovement(input);
  const { holderId, unit, amount, ref, reason } = input;
  // The `not exists` answers the ordinary repeat. Two calls RACING on one ref
  // both pass it (it reads the statement's snapshot), so the ledger insert has
  // no ON CONFLICT: the loser violates the unique index, its whole statement
  // rolls back — balance included — and is reported as already applied.
  const statement = sql`
    with seen as (
      select 1 from wallet_ledger
      where holder_id = ${holderId} and unit = ${unit} and reason = ${reason} and ref = ${ref}
    ), paid as (
      update wallet_balances
      set balance = balance - ${amount}::int, updated_at = now()
      where holder_id = ${holderId} and unit = ${unit}
        and balance >= ${amount}::int
        and not exists (select 1 from seen)
      returning balance
    ), entry as (
      insert into wallet_ledger (holder_id, unit, delta, reason, ref, note, actor_id)
      select ${holderId}, ${unit}, -${amount}::int, ${reason}, ${ref}, ${input.note ?? null}, ${input.actorId ?? null}
      from paid
      returning id
    )
    select (select balance from paid) as balance,
           exists (select 1 from seen) as seen`;
  try {
    const [row] = await rows<{ balance: number | null; seen: boolean }>(db, statement);
    if (row && row.balance !== null && row.balance !== undefined) {
      return { applied: true, balance: Number(row.balance) };
    }
    const balance = await walletBalance(db, holderId, unit);
    if (row?.seen) return { applied: false, balance };
    throw new InsufficientCreditsError(unit, amount, balance);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { applied: false, balance: await walletBalance(db, holderId, unit) };
  }
}

function checkMovement(input: MovementInput): void {
  assertCreditUnit(input.unit);
  assertCreditAmount(input.amount);
  if (typeof input.ref !== "string" || input.ref.trim() === "" || input.ref.length > 200) {
    throw new InvalidWalletReferenceError();
  }
  if (typeof input.holderId !== "string" || input.holderId.trim() === "") {
    throw new TypeError("A wallet movement needs a holder id.");
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What one holder has of one unit: 0 when they have never had any. */
export async function walletBalance(db: WalletDb, holderId: string, unit: string): Promise<number> {
  const [row] = await db
    .select({ balance: walletBalances.balance })
    .from(walletBalances)
    .where(and(eq(walletBalances.holderId, holderId), eq(walletBalances.unit, unit)))
    .limit(1);
  return row ? Number(row.balance) : 0;
}

export interface UnitBalance {
  readonly unit: string;
  readonly balance: number;
}

/** Every unit one holder has ever held, alphabetically. A unit spent to zero still shows, as 0. */
export async function balancesOf(db: WalletDb, holderId: string): Promise<UnitBalance[]> {
  const found = await db
    .select({ unit: walletBalances.unit, balance: walletBalances.balance })
    .from(walletBalances)
    .where(eq(walletBalances.holderId, holderId))
    .orderBy(walletBalances.unit);
  return found.map((r) => ({ unit: r.unit, balance: Number(r.balance) }));
}


export interface WalletRow {
  readonly holderId: string;
  readonly unit: string;
  readonly balance: number;
  readonly updatedAt: Date;
}

/** Holders by balance, largest first: the staff list. */
export async function listWallets(
  db: WalletDb,
  options: { readonly unit?: string; readonly limit?: number; readonly holderIds?: readonly string[] } = {},
): Promise<WalletRow[]> {
  const conditions: SQL[] = [];
  if (options.unit) conditions.push(eq(walletBalances.unit, options.unit));
  if (options.holderIds) {
    if (options.holderIds.length === 0) return [];
    conditions.push(sql`${walletBalances.holderId} in (${sql.join(options.holderIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  const found = await db
    .select({
      holderId: walletBalances.holderId,
      unit: walletBalances.unit,
      balance: walletBalances.balance,
      updatedAt: walletBalances.updatedAt,
    })
    .from(walletBalances)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(walletBalances.balance), walletBalances.holderId)
    .limit(clampLimit(options.limit));
  return found.map((r) => ({ ...r, balance: Number(r.balance) }));
}

export interface LedgerEntry {
  readonly id: number;
  readonly holderId: string;
  readonly unit: string;
  readonly delta: number;
  readonly reason: WalletReason;
  readonly ref: string;
  readonly note: string | null;
  readonly actorId: string | null;
  readonly createdAt: Date;
}

/** The ledger, newest first, filterable; page with `beforeId`. */
export async function listWalletLedger(
  db: WalletDb,
  options: {
    readonly holderId?: string;
    readonly unit?: string;
    readonly reason?: WalletReason;
    readonly limit?: number;
    readonly beforeId?: number;
    readonly since?: Date;
  } = {},
): Promise<LedgerEntry[]> {
  const conditions: SQL[] = [];
  if (options.holderId) conditions.push(eq(walletLedger.holderId, options.holderId));
  if (options.unit) conditions.push(eq(walletLedger.unit, options.unit));
  if (options.reason) conditions.push(eq(walletLedger.reason, options.reason));
  if (options.beforeId !== undefined) conditions.push(lt(walletLedger.id, BigInt(options.beforeId)));
  if (options.since) conditions.push(gt(walletLedger.createdAt, options.since));
  const found = await db
    .select()
    .from(walletLedger)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(walletLedger.id))
    .limit(clampLimit(options.limit));
  return found.map((r) => ({
    id: Number(r.id),
    holderId: r.holderId,
    unit: r.unit,
    delta: Number(r.delta),
    reason: r.reason,
    ref: r.ref,
    note: r.note,
    actorId: r.actorId,
    createdAt: r.createdAt,
  }));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * `execute` answers in the driver's own shape: `{ rows }` from node-postgres,
 * Neon's WebSocket pool and PGlite, a bare array from some HTTP drivers. One
 * place reads both.
 */
async function rows<T>(db: WalletDb, statement: SQL): Promise<T[]> {
  const result: unknown = await db.execute(statement);
  if (Array.isArray(result)) return result as T[];
  const found = (result as { rows?: unknown }).rows;
  return Array.isArray(found) ? (found as T[]) : [];
}

/** 23505, on the error or on the cause drizzle wraps it in. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
