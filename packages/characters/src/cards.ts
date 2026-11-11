import type { LoreCard } from "./types.js";

/**
 * CARD MATCHING: a visitor's own words bring a card to mind, by keyword, never by a model
 * guessing at relevance. Gated by book, so a card a visitor hasn't earned the right to
 * read never reaches the conversation in the first place — the gate holds even if the
 * model is handed the card by some other mistake, because the card is never handed over.
 */

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * POSSESSIVE-TOLERANT KEYS. A card or hook key as a whole phrase, any case, possessive or
 * not. Found building Hinderstap (keeper test kit, 2026-11-11): a card keyed on "Mongo"
 * didn't match "Mongo's a father" because the apostrophe sat where the word boundary was
 * expected, so the card never came up for the one line that was about to make it true.
 */
export function keyPattern(key: string): RegExp {
  return new RegExp(`(^|[^a-z'])${escape(key.toLowerCase())}(?:'s)?($|[^a-z'])`, "i");
}

/**
 * Is this card open to a visitor gated at `through`? Not before its book, and not past
 * its `maxBook`, for a fact a later book has made untrue.
 */
export function opensAt(card: Pick<LoreCard, "book" | "maxBook">, through: number): boolean {
  return (card.book ?? 0) <= through && (card.maxBook ?? Number.POSITIVE_INFINITY) >= through;
}

interface Matcher {
  readonly card: LoreCard;
  readonly patterns: readonly RegExp[];
}

// Keyed on the exact `cards` array reference a caller passes: a world's own card list is
// normally a module-level constant, so this builds once per list and never per call.
const matcherCache = new WeakMap<readonly LoreCard[], readonly Matcher[]>();

function matchersFor(cards: readonly LoreCard[], exclude: ReadonlySet<string>): Matcher[] {
  let list = matcherCache.get(cards) as Matcher[] | undefined;
  if (!list) {
    list = cards.map((card) => ({ card, patterns: card.keys.map((k) => keyPattern(k)) }));
    matcherCache.set(cards, list);
  }
  return exclude.size ? list.filter((m) => !exclude.has(m.card.id)) : list;
}

export interface CardsForOptions {
  /** At most this many cards. Defaults to 3. */
  readonly max?: number;
  /** Use a card's `night` text where it has one. Defaults to false. */
  readonly night?: boolean;
  /** How far the visitor is gated: no card past this book, whatever they ask. Defaults to open. */
  readonly through?: number;
  /** The visitor's current spend tier: a `secret` card needs at least `secretTier` of it. Defaults to 0. */
  readonly tier?: number;
  /**
   * The tier a `secret` card needs to surface at all. Defaults to `Infinity`: a secret
   * card never surfaces unless a caller opts in by naming a reachable tier, so a world
   * that forgets to set this fails closed rather than handing out its secrets for free.
   */
  readonly secretTier?: number;
  /** Card ids never to match here — a world's "always known" cards, or a hook's own
   *  `endingCards` while only its setup may be told. */
  readonly leaveOut?: readonly string[];
  /** Card ids to leave out of matching entirely (e.g. the "always known" cards already
   *  carried elsewhere): excluded up front, same effect as `leaveOut` but cached by id. */
  readonly exclude?: readonly string[];
}

/**
 * The cards whose subjects come up in `said`, best matches first. A card from a book past
 * `through` never comes up at all, nor does a `secret` card below `secretTier`, nor one
 * named in `leaveOut` (a hook's own ending, kept out of her notes while she's only
 * telling the setup).
 *
 * Equal hits break toward the latest book the visitor has reached: "tell me about Rand"
 * should give his present and the steps before it, not only the first book's farm boy.
 */
export function cardsFor(cards: readonly LoreCard[], said: string, options: CardsForOptions = {}): string[] {
  const {
    max = 3,
    night = false,
    through = Number.POSITIVE_INFINITY,
    tier = 0,
    secretTier = Number.POSITIVE_INFINITY,
    leaveOut = [],
    exclude = [],
  } = options;
  const text = String(said || "")
    .toLowerCase()
    .replace(/[’`]/g, "'");
  return matchersFor(cards, new Set(exclude))
    .map((m) => ({ card: m.card, hits: m.patterns.filter((p) => p.test(text)).length }))
    .filter(
      (m) =>
        m.hits > 0 &&
        opensAt(m.card, through) &&
        (!m.card.secret || tier >= secretTier) &&
        !leaveOut.includes(m.card.id),
    )
    .sort((a, b) => b.hits - a.hits || (b.card.book ?? 0) - (a.card.book ?? 0))
    .slice(0, max)
    .map((m) => (night && m.card.night ? m.card.night : m.card.text));
}

/**
 * Every card whose keys turn up anywhere in `text`, gated or not, capped or not: used to
 * steer a day's pick (`characterOfDay`) away from a card the visitor has already brought
 * up. Unlike `cardsFor` this only asks what's been mentioned, never what should be told.
 */
export function mentionedCardIds(cards: readonly LoreCard[], text: string): ReadonlySet<string> {
  const said = String(text || "")
    .toLowerCase()
    .replace(/[’`]/g, "'");
  const ids = new Set<string>();
  for (const m of matchersFor(cards, new Set())) if (m.patterns.some((p) => p.test(said))) ids.add(m.card.id);
  return ids;
}

export interface LintCardsOptions {
  /**
   * A leading tag a card's `text` should carry, and the book number inside it should
   * match `card.book` exactly — Hinderstap's cards all open `[B5] ...`. Defaults to that
   * pattern; pass `null` to skip the check entirely for a world that doesn't tag its text.
   */
  readonly tag?: RegExp | null;
}

const DEFAULT_TAG = /^\[B(\d+)\]/;

/**
 * THE VALIDATOR, as its own function rather than only a test's assertions, so a card
 * batch can be checked before it's even wired into a test file. Every problem found, in
 * plain sentences: a duplicate id (one card would silently stand in for another), a card
 * with no keys at all (it can never be matched), an uppercase key (`keyPattern` lowercases
 * what a visitor says, so an uppercase key never matches anything), and — unless `tag` is
 * `null` — a card whose text tag disagrees with its own `book` field, the exact way
 * Hinderstap caught a batch of cards that said one thing twice and didn't agree with
 * itself (`docs/character-playbook.md`, the content pipeline).
 */
export function lintCards(cards: readonly LoreCard[], options: LintCardsOptions = {}): string[] {
  const tag = options.tag === null ? null : options.tag ?? DEFAULT_TAG;
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) problems.push(`${card.id}: the id is used twice`);
    seen.add(card.id);
    if (!card.keys.length) problems.push(`${card.id}: no keys`);
    for (const key of card.keys) if (key !== key.toLowerCase()) problems.push(`${card.id}: key "${key}" isn't lowercase`);
    if (tag) {
      const match = tag.exec(card.text);
      if (match && card.book !== undefined && Number(match[1]) !== card.book) {
        problems.push(`${card.id}: text says book ${match[1]}, book field is ${card.book}`);
      }
    }
  }
  return problems;
}
