import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adjustWallet,
  AdjustmentNoteRequiredError,
  balancesOf,
  creditWallet,
  InvalidWalletReferenceError,
  listWalletLedger,
  listWallets,
  refundWallet,
  spendWallet,
  walletBalance,
  type WalletDb,
} from "../server.js";
import { InsufficientCreditsError, InvalidCreditAmountError, InvalidCreditUnitError } from "../units.js";

/**
 * A REAL Postgres: PGlite, in-process, built from the package's own SQL file,
 * so the file a non-drizzle project would run is the one under test, and the
 * statements meet a real unique index, a real CHECK and real CTE semantics.
 */
const here = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(join(here, "..", "..", "sql", "wallet-0.1.0.sql"), "utf8");

let client: PGlite;
let db: WalletDb;
let n = 0;
const person = () => `user_${(n += 1)}`;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client) as unknown as WalletDb;
});

afterAll(async () => {
  await client.close();
});

async function ledgerSum(holderId: string, unit: string): Promise<number> {
  const result = await client.query<{ total: number }>(
    "select coalesce(sum(delta), 0)::int as total from wallet_ledger where holder_id = $1 and unit = $2",
    [holderId, unit],
  );
  return result.rows[0]?.total ?? 0;
}

describe("credit", () => {
  it("credits once per reference, however many times it arrives", async () => {
    const who = person();
    const first = await creditWallet(db, { holderId: who, unit: "crowns", amount: 25, ref: "pi_1:grant_a" });
    const again = await creditWallet(db, { holderId: who, unit: "crowns", amount: 25, ref: "pi_1:grant_a" });
    expect(first).toEqual({ applied: true, balance: 25 });
    expect(again).toEqual({ applied: false, balance: 25 });
    expect(await walletBalance(db, who, "crowns")).toBe(25);
    expect(await ledgerSum(who, "crowns")).toBe(25);
  });

  it("keeps two grants on one order apart", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "pi_2:grant_a" });
    const second = await creditWallet(db, { holderId: who, unit: "crowns", amount: 5, ref: "pi_2:grant_b" });
    expect(second.balance).toBe(15);
  });

  it("keeps units apart", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "a" });
    await creditWallet(db, { holderId: who, unit: "ai-credits", amount: 3, ref: "a" });
    expect(await balancesOf(db, who)).toEqual([
      { unit: "ai-credits", balance: 3 },
      { unit: "crowns", balance: 10 },
    ]);
  });

  it("survives a race on one reference: one credit", async () => {
    const who = person();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => creditWallet(db, { holderId: who, unit: "crowns", amount: 7, ref: "pi_race" })),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await walletBalance(db, who, "crowns")).toBe(7);
  });

  it("refuses a bad unit, amount or reference before touching the database", async () => {
    const who = person();
    await expect(creditWallet(db, { holderId: who, unit: "Crowns", amount: 1, ref: "r" })).rejects.toBeInstanceOf(InvalidCreditUnitError);
    await expect(creditWallet(db, { holderId: who, unit: "crowns", amount: 0, ref: "r" })).rejects.toBeInstanceOf(InvalidCreditAmountError);
    await expect(creditWallet(db, { holderId: who, unit: "crowns", amount: 1.5, ref: "r" })).rejects.toBeInstanceOf(InvalidCreditAmountError);
    await expect(creditWallet(db, { holderId: who, unit: "crowns", amount: 1, ref: " " })).rejects.toBeInstanceOf(InvalidWalletReferenceError);
    expect(await walletBalance(db, who, "crowns")).toBe(0);
  });
});

describe("spend", () => {
  it("spends what there is and refuses what there isn't, spending nothing", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 3, ref: "pack" });
    expect(await spendWallet(db, { holderId: who, unit: "crowns", amount: 2, ref: "ale-1" })).toEqual({ applied: true, balance: 1 });
    const refused = spendWallet(db, { holderId: who, unit: "crowns", amount: 2, ref: "stew-1" });
    await expect(refused).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(refused).rejects.toMatchObject({ wanted: 2, balance: 1, unit: "crowns" });
    expect(await walletBalance(db, who, "crowns")).toBe(1);
    expect(await ledgerSum(who, "crowns")).toBe(1);
  });

  it("refuses a holder who never had any", async () => {
    await expect(spendWallet(db, { holderId: person(), unit: "crowns", amount: 1, ref: "x" })).rejects.toMatchObject({ balance: 0 });
  });

  it("spends once per reference: a repeat is applied:false, not a second spend or a refusal", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 1, ref: "pack" });
    expect(await spendWallet(db, { holderId: who, unit: "crowns", amount: 1, ref: "ale-9" })).toEqual({ applied: true, balance: 0 });
    // The balance is now 0: a naive retry would read as "insufficient".
    expect(await spendWallet(db, { holderId: who, unit: "crowns", amount: 1, ref: "ale-9" })).toEqual({ applied: false, balance: 0 });
  });

  it("never overspends under a race of different spends", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 3, ref: "pack" });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => spendWallet(db, { holderId: who, unit: "crowns", amount: 1, ref: `bar-${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(await walletBalance(db, who, "crowns")).toBe(0);
    expect(await ledgerSum(who, "crowns")).toBe(0);
  });

  it("spends a repeated reference once under a race", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 5, ref: "pack" });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => spendWallet(db, { holderId: who, unit: "crowns", amount: 2, ref: "same-click" })),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await walletBalance(db, who, "crowns")).toBe(3);
  });
});

describe("refund", () => {
  it("takes back the pack, or what's left of it, never below zero, once", async () => {
    const who = person();
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "pi_9:g" });
    await spendWallet(db, { holderId: who, unit: "crowns", amount: 7, ref: "room" });
    const refund = await refundWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "pi_9" });
    expect(refund).toEqual({ applied: true, taken: 3, balance: 0 });
    // Bought more since: a second refund of the same order must not take them.
    await creditWallet(db, { holderId: who, unit: "crowns", amount: 25, ref: "pi_10:g" });
    expect(await refundWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "pi_9" })).toEqual({ applied: false, taken: 0, balance: 25 });
    expect(await ledgerSum(who, "crowns")).toBe(25);
  });

  it("records a refund that found nothing to take", async () => {
    const who = person();
    expect(await refundWallet(db, { holderId: who, unit: "crowns", amount: 10, ref: "pi_none" })).toEqual({ applied: true, taken: 0, balance: 0 });
    const [entry] = await listWalletLedger(db, { holderId: who });
    expect(entry).toMatchObject({ reason: "refund", delta: 0, ref: "pi_none" });
  });
});

describe("adjust", () => {
  it("adds and takes away with a note and an actor, and refuses going below zero", async () => {
    const who = person();
    expect(await adjustWallet(db, { holderId: who, unit: "crowns", delta: 5, note: "Sorry about the outage", actorId: "staff_1", ref: "form-1" })).toEqual({ applied: true, balance: 5 });
    expect(await adjustWallet(db, { holderId: who, unit: "crowns", delta: 5, note: "Sorry about the outage", actorId: "staff_1", ref: "form-1" })).toEqual({ applied: false, balance: 5 });
    expect(await adjustWallet(db, { holderId: who, unit: "crowns", delta: -2, note: "Duplicate pack", actorId: "staff_1", ref: "form-2" })).toEqual({ applied: true, balance: 3 });
    await expect(adjustWallet(db, { holderId: who, unit: "crowns", delta: -4, note: "Too much", actorId: "staff_1", ref: "form-3" })).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(adjustWallet(db, { holderId: who, unit: "crowns", delta: 1, note: "  ", actorId: "staff_1", ref: "form-4" })).rejects.toBeInstanceOf(AdjustmentNoteRequiredError);
    await expect(adjustWallet(db, { holderId: who, unit: "crowns", delta: 0, note: "zero", actorId: "staff_1", ref: "form-5" })).rejects.toBeInstanceOf(InvalidCreditAmountError);
    const entries = await listWalletLedger(db, { holderId: who, reason: "adjust" });
    expect(entries.map((e) => [e.delta, e.note, e.actorId])).toEqual([
      [-2, "Duplicate pack", "staff_1"],
      [5, "Sorry about the outage", "staff_1"],
    ]);
  });
});

describe("the database itself", () => {
  it("refuses a negative balance even from a hand-written statement", async () => {
    await expect(client.query("insert into wallet_balances (holder_id, unit, balance) values ('x', 'crowns', -1)")).rejects.toThrow();
  });

  it("lists wallets largest first", async () => {
    const a = person();
    const b = person();
    await creditWallet(db, { holderId: a, unit: "gems", amount: 2, ref: "p" });
    await creditWallet(db, { holderId: b, unit: "gems", amount: 9, ref: "p" });
    const listed = await listWallets(db, { unit: "gems" });
    expect(listed.map((w) => [w.holderId, w.balance])).toEqual([
      [b, 9],
      [a, 2],
    ]);
  });
});
