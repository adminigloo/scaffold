import type { HistoryLine, RumorRecord, RumorVersion } from "./types.js";
import { keyPattern } from "./cards.js";

/**
 * ARGUING WITH THE DAY'S TALK. A visitor who pushes back on something she just told them
 * gets handed a real record to stand on, hedge over or concede from — never a model
 * inventing a source on the spot, and never a fact that moves off what the record's own
 * `cards` support.
 */

/**
 * Words a visitor uses to push back on something she just told them: asking who told
 * her, or flatly saying it's wrong. Code spots this, never a model, so a challenge always
 * lands on a real record.
 */
const CHALLENGE =
  /\b(who told you|who said(?:\s+(?:that|so))?|says who|your source|where'?d you hear|where did you hear|prove it|that'?s not (?:true|right|what happened)|that'?s wrong|i heard (?:different|otherwise)|no way|liar)\b/i;

/** Is this visitor pushing back on something she just said? */
export function isChallenge(said: string | undefined): boolean {
  return CHALLENGE.test(String(said ?? "").replace(/[’`]/g, "'"));
}

interface DeckMatcher {
  readonly record: RumorRecord;
  readonly patterns: readonly RegExp[];
}

const deckCache = new WeakMap<readonly RumorRecord[], readonly DeckMatcher[]>();
function matchersForDeck(deck: readonly RumorRecord[]): readonly DeckMatcher[] {
  let list = deckCache.get(deck);
  if (!list) {
    list = deck.map((record) => ({ record, patterns: record.keys.map((k) => keyPattern(k)) }));
    deckCache.set(deck, list);
  }
  return list;
}

/**
 * THE CHALLENGED-RECORD LOOKUP. The record a challenge is about, found the same way a
 * card is matched: from the last couple of turns, her own last line first (that's what's
 * being argued with), then what the visitor just said. Never a record past the visitor's
 * reading gate (`through`): a rumor they haven't earned the right to hear straight is
 * never handed over just because they argued for it.
 */
export function challengedRecord(
  deck: readonly RumorRecord[],
  history: readonly HistoryLine[],
  said: string | undefined,
  through: number,
): RumorRecord | null {
  const last = [...history].reverse().find((m) => m.role === "character");
  const text = `${last?.content ?? ""} ${said ?? ""}`.toLowerCase().replace(/[’`]/g, "'");
  const found = matchersForDeck(deck)
    .map((m) => ({ record: m.record, hits: m.patterns.filter((p) => p.test(text)).length }))
    .filter((m) => m.hits > 0 && m.record.book <= through)
    .sort((a, b) => b.hits - a.hits);
  return found[0]?.record ?? null;
}

/** Which of a record's tellings is closest to what was just said, or the first when nothing picks one out. */
function tellingFor(record: RumorRecord, text: string): RumorVersion {
  const said = text.toLowerCase();
  const scored = record.versions
    .map((v) => ({ v, hits: v.text.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && said.includes(w)).length }))
    .sort((a, b) => b.hits - a.hits);
  const best = scored[0];
  return (best && best.hits > 0 ? best.v : record.versions[0]) as RumorVersion;
}

/** How she answers a challenge, by how sure the telling she gave was. */
function stanceFor(sureness: RumorVersion["sureness"]): string {
  if (sureness === "sure") return "Stand firm: your source is a good one and you don't budge an inch.";
  if (sureness === "likely") return "Hold your ground, but leave a little room: your source is solid, not certain.";
  return "Concede with style: own that this one might not hold up, lightly, the way you'd laugh off a bad bet, and tell them the other telling.";
}

/**
 * The note for a challenged rumor: her source, how sure she is and why, the other
 * telling if there is one, and the truth it all comes from, so she can stand firm, hedge
 * or concede with style, in character, never moving the facts off the record and never
 * inventing a source that isn't hers.
 */
export function challengedNote(
  record: RumorRecord,
  history: readonly HistoryLine[],
  said: string | undefined,
  night: boolean,
): string {
  const last = [...history].reverse().find((m) => m.role === "character");
  const told = tellingFor(record, `${last?.content ?? ""} ${said ?? ""}`);
  const other = record.versions.find((v) => v !== told);
  const verdict = night && record.nightVerdict ? record.nightVerdict : record.verdict;
  return [
    "<challenged>",
    `They're pushing back on what you said about ${record.topic}. You had it from ${told.source}, and you're ${told.sureness} of it: ${told.why}`,
    other ? `Another telling going around: ${other.text}` : null,
    `What's actually true, as far as it's reached you: ${record.truth}`,
    `Your own take: ${verdict}`,
    stanceFor(told.sureness),
    "Never move the facts off what's reached you, and never invent a source you don't have. A visitor who hasn't read far enough never gets a rumor past their own book, argued for or not.",
    "</challenged>",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
