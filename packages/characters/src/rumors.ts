import type { RumorRecord } from "./types.js";

/**
 * THE DAY'S RUMOR PICK: the village's — or the club's rail's, or the Waystone's taproom's
 * — daily talk, deterministic by day and by world, from a hand-checked deck. Replaces
 * what a three-model-call-a-day web-search job used to do in Hinderstap, and can't make
 * that job's mistake (a last-book spoiler slipping through a spoiler check that was
 * itself only as careful as that day's model call): every record's own `book` is checked
 * against the books its `cards` actually come from by a test, not guessed at by a model.
 */

/** How many of a deck's records make up one day's talk, when a caller doesn't say. */
export const DEFAULT_RECORDS_PER_DAY = 3;

export interface RecordsForOptions {
  /** No record past this book reaches the day's public sheet. Defaults to open (no gate). */
  readonly boundary?: number;
  /** How many records make up the day's talk. Defaults to `DEFAULT_RECORDS_PER_DAY`. */
  readonly perDay?: number;
}

/**
 * Today's few records from `deck`: a day-picked, wrapping window over the records inside
 * `boundary`, so every visitor who reads the day's talk that day sees the same thing, and
 * a different few tomorrow. Stable: the same day and deck always pick the same records.
 * Empty when nothing in the deck is inside the boundary (including a deck that's simply empty).
 */
export function recordsFor(deck: readonly RumorRecord[], day: string, options: RecordsForOptions = {}): RumorRecord[] {
  const boundary = options.boundary ?? Number.POSITIVE_INFINITY;
  const perDay = options.perDay ?? DEFAULT_RECORDS_PER_DAY;
  const inBounds = deck.filter((r) => r.book <= boundary);
  if (!inBounds.length) return [];
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 864e5);
  const start = ((n % inBounds.length) + inBounds.length) % inBounds.length;
  const count = Math.min(perDay, inBounds.length);
  return Array.from({ length: count }, (_, i) => inBounds[(start + i) % inBounds.length] as RumorRecord);
}
