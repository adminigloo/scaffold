/**
 * @adminigloo/characters — the pure, model-free engine behind an AI character bound to a
 * world, ported from building Hinderstap's keepers (Wheel of Time's Tipsy Gelding,
 * Dungeon Crawler Carl's Desperado Club). See docs/character-playbook.md for the writing
 * rules, the content pipeline and the no-API testing method this package's tests use.
 *
 * NOTHING HERE CALLS A MODEL, and nothing here needs one to be exercised or tested: every
 * function is a pure pick over plain data. A model is handed only what this package has
 * already decided it may say — a card's text, a hook's setup, a challenged record's
 * truth — never asked to decide any of that itself.
 */

export type {
  Mood,
  Line,
  PersonaSections,
  LoreCard,
  Hook,
  Tab,
  Tier,
  Flourishes,
  Sureness,
  RumorVersion,
  RumorRecord,
  HistoryLine,
  LedgerView,
  Relationship,
} from "./types.js";

export { personaFor, checklistFor, primerFor } from "./persona.js";

export { keyPattern, opensAt, cardsFor, mentionedCardIds, lintCards } from "./cards.js";
export type { CardsForOptions, LintCardsOptions } from "./cards.js";

export { PAID_ENDING, endingFor, leanFor, stagingFor } from "./flourishes.js";

export {
  hookById,
  isAbout,
  hookTelling,
  justServed,
  storyHanging,
  storyLeftHanging,
  wantsTheRest,
  storyAskedFor,
  wantsNews,
  hookFor,
} from "./hooks.js";
export type { HookForInput } from "./hooks.js";

export { isChallenge, challengedRecord, challengedNote } from "./challenge.js";

export { LONG_ABSENCE_DAYS, formatReading, relationshipFor, arrivalNote } from "./ledger.js";

export { characterOfDay } from "./character-of-day.js";
export type { CharacterOfDaySeed } from "./character-of-day.js";

export { DEFAULT_RECORDS_PER_DAY, recordsFor } from "./rumors.js";
export type { RecordsForOptions } from "./rumors.js";
