import type { LedgerView, Relationship } from "./types.js";

/**
 * HER LEDGER: a regular's name, how far they've read, their nickname, a running joke, and
 * what she promised to tell next time, kept past her own forgetting even though the
 * conversation that filled it is wiped. This file is the pure half — the arithmetic that
 * decides how she greets someone from it — with no database underneath.
 */

/** How long an absence has to be before it's "a long absence", not just "gone a day". */
export const LONG_ABSENCE_DAYS = 14;

/**
 * The one place that spells out "through book N" (or caught up, for Infinity), so a
 * ledger panel's correction and a notebook's own note never drift into two different
 * wordings.
 */
export function formatReading(through: number): string {
  return through === Number.POSITIVE_INFINITY ? "caught up" : `has read through Book ${through}`;
}

/**
 * Which of three she's greeting: never seen them (no ledger row, or one with no visits
 * yet), a regular (a row, seen inside `LONG_ABSENCE_DAYS`), or someone back after a long
 * time away. `now` is a parameter, not `Date.now()`, so this stays a pure function a test
 * can run on a fixed clock.
 */
export function relationshipFor(ledger: LedgerView | null, now: number): Relationship {
  if (!ledger || ledger.visits <= 0) return "first";
  const days = (now - ledger.lastSeenAt.getTime()) / 86_400_000;
  return days >= LONG_ABSENCE_DAYS ? "absence" : "regular";
}

/**
 * ARRIVAL NOTES BY RELATIONSHIP. On arrival, the difference between a visitor she's
 * never met, a regular, and someone back after weeks away — with her ledger's name,
 * nickname and running joke, so she greets them by them rather than by guesswork. A
 * first visit adds nothing: a caller's own "they have just walked in" note already says
 * she's never seen them.
 */
export function arrivalNote(relation: Relationship, ledger: LedgerView | null): string {
  if (relation === "first") return "";
  const bits: string[] = [];
  if (ledger?.name) bits.push(`you know them as ${ledger.name}`);
  if (ledger?.nickname) bits.push(`you call them ${ledger.nickname}`);
  if (ledger?.joke) bits.push(`your running joke between you: ${ledger.joke}`);
  if (ledger?.promised) bits.push(`you told them last time you'd say more about ${ledger.promised}`);
  const known = bits.length ? `, ${bits.join("; ")}` : "";
  return relation === "absence" ? ` You haven't seen them in weeks${known}.` : ` A regular${known}.`;
}
