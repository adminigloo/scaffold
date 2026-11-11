import type { LoreCard } from "./types.js";
import { opensAt } from "./cards.js";

/**
 * THE DETERMINISTIC CHARACTER-OF-THE-DAY PICK: one lore card a visitor gets, per day,
 * picked deterministically from who they are and what day it is, so a regular hears
 * something new each day without a second model call. Meant to be offered to a model as
 * a story it MAY reach for, never one it must tell.
 */

/**
 * A small, stable hash: good enough to pick an index, not for anything cryptographic.
 * FNV-1a with a Murmur3-style finalizer, not a bare polynomial hash: a plain `h * 31 + c`
 * hash mixes its low bits poorly, and picking from a short pool (3 cards, say) is exactly
 * `% from.length` on those low bits — a bare hash gave every "traveler-N" the same card
 * for every N mod 3, since 31^k happened to land on a multiple of 3 for this string's
 * length (found building Hinderstap by this file's own tests).
 */
function hash(s: string): number {
  let h = 0x811c9dc5; // FNV-1a's 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV-1a's 32-bit prime
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function candidates(cards: readonly LoreCard[], through: number, exclude: ReadonlySet<string>): readonly LoreCard[] {
  return cards.filter((c) => !exclude.has(c.id) && !c.secret && opensAt(c, through));
}

export interface CharacterOfDaySeed {
  /** Namespaces the pick across worlds or characters sharing one process; a slug is fine. */
  readonly venueId: string;
  /** The visitor's own id (a cookie, a guest row's id — whatever your store keys them by). */
  readonly visitorId: string;
  /** The calendar day, as a plain string ("2026-11-12"): the pick is stable within a day. */
  readonly day: string;
}

/**
 * One card for this visitor, this character, this day: the same three inputs always pick
 * the same card (stable), never one past the visitor's reading gate, and steered away
 * from a card whose keys they've already brought up (`mentioned`, from
 * `mentionedCardIds`) whenever another choice is open to them. Null when nothing is
 * eligible at all — every card is either excluded, secret, or past the gate.
 */
export function characterOfDay(
  cards: readonly LoreCard[],
  seed: CharacterOfDaySeed,
  through: number,
  mentioned: ReadonlySet<string> = new Set(),
  exclude: readonly string[] = [],
): LoreCard | null {
  const pool = candidates(cards, through, new Set(exclude));
  if (!pool.length) return null;
  const fresh = pool.filter((c) => !mentioned.has(c.id));
  const from = fresh.length ? fresh : pool;
  const n = hash(`${seed.venueId}:${seed.visitorId}:${seed.day}`);
  return from[n % from.length] ?? null;
}
