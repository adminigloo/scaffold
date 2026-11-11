/**
 * WHAT A CHARACTER IS. Hinderstap's keepers taught the same lesson twice, in two different
 * worlds: a character bound to a world is a persona, a pile of verified facts gated by how
 * far the visitor has read, and a handful of stories held back until they're earned. All of
 * it is data, and none of it needs a model call to pick, gate or rotate. A model is only
 * ever handed what this package already decided she may say.
 *
 * These types carry no brand name and no world: "book" reads naturally for a shelf of
 * novels, but stands in just as well for a season, an arc or an era — whatever ordered
 * unit your world's spoilers are gated by. Swap the word when you write your own persona;
 * the field stays `book` so every function below reads the same way for every world.
 */

/** The character's face or tone on a line: a mood tag, a portrait key, an emote — whatever
 *  your UI draws from a tag at the front of a reply. Left as a plain string so a world
 *  can define its own closed set (Hinderstap's bars used a six-mood union each). */
export type Mood = string;

/** A canned line: what she says, whole, without a model, and the face she wears saying it. */
export interface Line {
  readonly mood: Mood;
  readonly text: string;
}

/**
 * WHO SHE IS, IN TWO HALVES. A character bound to a world where night (or any other
 * recurring state) changes who she is keeps one full set of sections for each half, never
 * one prompt with a mood flag: Hinderstap's Hessa is a different person after dark, not a
 * grumpier one. A character whose world has no such split repeats the day section as the
 * night one.
 *
 * Nothing here is consumed by this package — a persona's sections ride into a model's
 * system prompt, which is the host app's business, not this one's. They're typed and
 * carried here because the day/night (or "by era") split is as structural to a character
 * as her lore cards are, and because `primerFor` below applies the same book gate to it
 * that `cardsFor` applies to a card.
 */
export interface PersonaSections {
  /** Who she is by default: worldview and situation, never a list of adjectives. */
  readonly persona: string;
  /** Who she is in the world's other state (night, a different season, a different shift). */
  readonly nightPersona: string;
  /** What matters for every single reply: code-owned, since a UI may parse tags out of it. */
  readonly checklist: string;
  readonly nightChecklist: string;
  /** What she knows of her world, always in scope: the parts that spoil nothing. */
  readonly primer: string;
  /** The world as it reaches her by a given book: added only for a visitor gated that far. */
  readonly primerAt?: { readonly book: number; readonly text: string };
}

/** Something she knows, brought to mind when a visitor mentions one of its keys. */
export interface LoreCard {
  readonly id: string;
  readonly keys: readonly string[];
  readonly text: string;
  /**
   * The same facts as her other self holds them, for a card whose `text` carries one
   * self's attitude. Without it, `text` is used for both.
   */
  readonly night?: string;
  /** Where it comes from in the source material: for spoiler audits, never shown to her. */
  readonly when: string;
  /**
   * The book (or era, arc, season — see the file header) its facts come from. The card
   * only reaches a visitor gated that far or past it (`cardsFor`, `opensAt`).
   */
  readonly book?: number;
  /**
   * The last book the card is still true for: past it, the card is hidden, for a fact a
   * later book overturns.
   */
  readonly maxBook?: number;
  /**
   * True in the source material, but not public in her world: told only to a visitor who
   * has earned it (a spend tier, a favor, whatever your world's `cardsFor` tier means).
   */
  readonly secret?: boolean;
}

/**
 * A story told in two halves: the part a visitor who hasn't paid hears, cut at its best
 * moment, and the rest, which the first reply after a purchase tells in full. The
 * character is only ever handed the half she may tell right now, so a cliffhanger is
 * always real material and never something she invented, and the payoff is always the
 * same true ending.
 */
export interface Hook {
  /** Stored on her line (your own history store), so a later payoff is this story's. */
  readonly id: string;
  /** What a visitor might mention that makes this the story to start. */
  readonly keys: readonly string[];
  /** The half she tells on free talk, stopping at its end. */
  readonly setup: string;
  /** The rest, told only once they've bought something, or when they ask her to go on. */
  readonly payoff: string;
  /**
   * The same two halves as her other self tells them: the same facts, a different spin,
   * so the two never tell a story alike.
   */
  readonly night?: { readonly setup: string; readonly payoff: string };
  /**
   * Cards that tell this story's ending. While she's telling only its setup, they're kept
   * out of her notes: a card in front of her is an ending she will tell.
   */
  readonly endingCards?: readonly string[];
  readonly when: string;
  readonly book?: number;
}

/** How generous the character is right now: a spend tier, a loyalty level, a relationship
 *  stage — whatever your world calls the thing that makes free talk one tier and a paid
 *  reply another. Only `tier` and `freeLeft` are read by this package. */
export interface Tab {
  /** 0 is free talk; 1 and up is paid, generous in proportion to the tier. */
  readonly tier: number;
  /** Free questions left before the next tier (or the paywall) kicks in. */
  readonly freeLeft: number;
}

/** How a tier reads and what it buys, as data: never a model name or a price here — those
 *  are a deployment's own business, not this engine's. */
export interface Tier {
  /** "two or three short sentences, under 45 words" */
  readonly length: string;
  /** What the spending means to her, in her terms. */
  readonly note?: string;
  /** How many secrets ("whispers") she may let slip at this tier. */
  readonly whispers?: number;
}

/**
 * What a character's replies lean on, taken in turn so she never reaches for the same
 * trick twice running: something to lean on once she's answered, a way to end, and
 * (optionally) what her stage direction is about this time. A character's day and night
 * lists should never share an entry, so her two selves never sound alike.
 */
export interface Flourishes {
  readonly leans: readonly string[];
  readonly endings: readonly string[];
  readonly staging?: readonly string[];
}

/** How sure the character is of a rumor's telling, and so how hard she defends it when argued with. */
export type Sureness = "sure" | "likely" | "doubtful";

/**
 * One telling of a rumor the room passes around, from an in-world kind of person, never a
 * real visitor.
 */
export interface RumorVersion {
  readonly text: string;
  /** Who told her: an in-world kind of person ("a peddler out of Tear", "a crawler from the
   *  Iron Tangle line"), never a named visitor. */
  readonly source: string;
  readonly sureness: Sureness;
  /** Why she trusts or doubts that source, for the day she's asked to defend it. */
  readonly why: string;
}

/**
 * A hand-checked rumor in a character's rumor deck. The day's talk and the arguing a
 * visitor can pick with her are both drawn from these, never from a model's memory, so a
 * rumor can never carry a fact its `cards` don't, and a challenge always finds a real
 * source to stand on or concede from.
 */
export interface RumorRecord {
  readonly id: string;
  /** The latest book its facts need: the reading gate for this record. */
  readonly book: number;
  /** Words that bring it up, keyed the way a card's keys are. */
  readonly keys: readonly string[];
  /** A short title: a day's-talk heading. */
  readonly topic: string;
  /** The lore card ids its truth comes from: never a fact invented past them. */
  readonly cards: readonly string[];
  /** The true version, from those cards. */
  readonly truth: string;
  /** One or two garbled tellings the room passes around. */
  readonly versions: readonly RumorVersion[];
  /** Her usual take on it. */
  readonly verdict: string;
  /** Her other self's take, when it reads differently. */
  readonly nightVerdict?: string;
}

/**
 * A line of the conversation so far, as this package reads it: not a full chat transcript
 * type, just the handful of fields the engine needs. Your own store can carry whatever
 * else it likes alongside these.
 */
export interface HistoryLine {
  readonly role: "guest" | "character";
  readonly content: string;
  /** For a `role: "character"` line: the hook id this reply started and stopped short on,
   *  if any — read back later for the payoff after a purchase (`storyLeftHanging`). */
  readonly hook?: string | null;
  /**
   * For a `role: "character"` line: true when this line marks a purchase (an order served,
   * a favor spent) rather than an answer. Hinderstap derived this by comparing a stored
   * line's text against a bar's own canned "serving" lines; a plain flag the host sets when
   * it stores the line is simpler to port into a new world and just as exact.
   */
  readonly purchase?: boolean;
  /** Which of her two selves said or heard this line, when that matters to your history
   *  store (a visitor who talked by day and returns at night meets someone else). */
  readonly hour?: "day" | "night";
}

/** A traveler's/visitor's ledger row, as this engine reads it (one row per character per
 *  visitor, however your database keys it). */
export interface LedgerView {
  readonly name: string | null;
  /** Your own exact form for "read this far" ("has read through Book 6", "caught up", or
   *  whatever `formatReading` in your world renders) — kept as free text on purpose, so the
   *  ledger and your reading-gate notes always use the one wording. */
  readonly reading: string | null;
  readonly nickname: string | null;
  readonly joke: string | null;
  /** What she told them she'd say more about, next time. */
  readonly promised: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly visits: number;
}

/** Which of three a character is greeting: never seen them, a regular, or someone back
 *  after a long time away (`relationshipFor`). */
export type Relationship = "first" | "regular" | "absence";
