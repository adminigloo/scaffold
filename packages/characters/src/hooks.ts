import type { HistoryLine, Hook, Tab } from "./types.js";
import { keyPattern } from "./cards.js";

/**
 * HOOK PICKING AND THE PAYOFF AFTER A PURCHASE. A hook is cliffhanger material she already
 * owns, split into a `setup` a free visitor hears and a `payoff` nobody gets for free. The
 * picking is all here, in code, never left to a model: a model is only ever handed the
 * half of a story it may tell right now.
 */

/** A hook's own id, found in `hooks`, or null for one a world no longer carries. */
export function hookById(hooks: readonly Hook[] | undefined, id: string | null | undefined): Hook | null {
  return (id && hooks?.find((h) => h.id === id)) || null;
}

const hookMatchers = new WeakMap<Hook, readonly RegExp[]>();
function hookPatterns(hook: Hook): readonly RegExp[] {
  let list = hookMatchers.get(hook);
  if (!list) {
    list = hook.keys.map((k) => keyPattern(k));
    hookMatchers.set(hook, list);
  }
  return list;
}

/** Does what was said mention this hook's subject? */
export function isAbout(hook: Hook, said: string | undefined): boolean {
  const text = String(said ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'");
  return hookPatterns(hook).some((p) => p.test(text));
}

/** The setup and payoff for this side of her: her other self tells the same story her own way. */
export function hookTelling(hook: Hook, night: boolean): { readonly setup: string; readonly payoff: string } {
  return night && hook.night ? hook.night : hook;
}

/** Is this one of her lines that marks a purchase (`HistoryLine.purchase`)? */
export function justServed(history: readonly HistoryLine[]): boolean {
  const last = [...history].reverse().find((m) => m.role === "character");
  return Boolean(last?.purchase);
}

/** The hook her latest line left hanging, if it did: nothing has been bought since. */
export function storyHanging(hooks: readonly Hook[] | undefined, history: readonly HistoryLine[]): Hook | null {
  const last = [...history].reverse().find((m) => m.role === "character");
  return last ? hookById(hooks, last.hook) : null;
}

/**
 * The story they've paid for, when they've just bought something. With `hooks`, the
 * story her lines left hanging since the purchase before this one, if any — one already
 * paid off isn't paid again — handed back whole so she finishes it, truly. Without
 * `hooks`, how her last reply before the purchase ended, quoted, so she finishes that one
 * and not another (cut to the last 260 characters at a word boundary, parentheses
 * stripped, since a stage direction isn't part of the story she's picking back up).
 */
export function storyLeftHanging(
  history: readonly HistoryLine[],
  hooks?: readonly Hook[],
  options: { readonly quoteChars?: number } = {},
): Hook | string | null {
  if (!justServed(history)) return null;
  const said = history.filter((m) => m.role === "character");
  if (hooks) {
    for (let i = said.length - 2; i >= 0; i--) {
      const line = said[i] as HistoryLine;
      if (line.purchase) break;
      const hook = hookById(hooks, line.hook);
      if (hook) return hook;
    }
    return null;
  }
  const before = said[said.length - 2];
  if (!before) return null;
  const words = before.content.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const max = options.quoteChars ?? 260;
  return words.length > max ? `…${words.slice(-max).replace(/^\S*\s/, "")}` : words;
}

/** Are they asking her to go on with what she was telling them? */
export function wantsTheRest(said: string | undefined): boolean {
  const text = String(said ?? "").trim().replace(/[’`]/g, "'");
  if (!text) return false;
  if (/^(and|so|well|more|then|annnd+)\W*$/i.test(text)) return true;
  return /\b(go on|and then|then what|what happened|what happens next|what came next|tell me more|tell me the rest|keep going|continue|finish (it|the story)|the rest|what next|don't stop|don't leave me hanging|how does it end|how did it end)\b/i.test(
    text,
  );
}

/**
 * Free talk asking her to go on with a story still hanging. She tells the rest, never a
 * tollbooth — holding it back reads as pushy — and the reply opens the next story and
 * stops short instead (`hookFor`), so free talk still ends on a cliffhanger.
 */
export function storyAskedFor(
  hooks: readonly Hook[] | undefined,
  history: readonly HistoryLine[],
  said: string | undefined,
  tab: Tab | null,
): Hook | null {
  if (!hooks?.length || !tab || tab.tier > 0 || !wantsTheRest(said)) return null;
  return storyHanging(hooks, history);
}

/**
 * Is the visitor after news, or leaving her room to bring some: asking for news, gossip,
 * a story or a secret, nudging her on, or just saying hello. A question about one thing
 * gets that answered and nothing tacked on.
 */
export function wantsNews(said: string | undefined): boolean {
  const text = String(said ?? "").trim();
  if (!text) return true;
  if (text.split(/\s+/).length <= 3 && !/\b(who|what|which|where|why|how|when)\b/i.test(text)) return true;
  return /\b(news|gossip|rumou?rs?|heard|hear|latest|tidings|word|secrets?|stor(y|ies)|juic\w*|strange|happening|going on|new|else|more|go on|tell me something)\b/i.test(
    text,
  );
}

/**
 * A plain question asking how something turned out: a story about it would hold back the
 * very answer, so none is started. "Why" belongs here too — asked why they must leave by
 * a deadline, a story about the deadline would hand over its first half and hold back the
 * answer, which is the question itself (found building Hinderstap's Tipsy Gelding,
 * keeper test kit, 2026-11-10).
 */
const ASKS_THE_OUTCOME =
  /\b(dead|alive|die|died|dies|killed|kill|survive[ds]?|true|happened|happen|end(ed|s)?|won|win|lost|became|become|where is|where's|who won|still|why)\b/i;

export interface HookForInput {
  readonly said?: string;
  readonly history: readonly HistoryLine[];
  readonly tab: Tab | null;
  readonly arriving: boolean;
  /** How far they've read: no story from a book past it. Defaults to open. */
  readonly through?: number;
}

/**
 * The hook free talk's cliffhanger starts this turn, picked here and never by a model, so
 * a cliffhanger is always real material: none on arrival or once they've bought anything.
 * Otherwise the hook about what they said, unless they asked how it turned out
 * (`ASKS_THE_OUTCOME`, where a story would only withhold their answer); failing that, when
 * they're after news, asking her to go on, or nearly out of free questions, the best one
 * they haven't heard (`hooks` are read best first). A plain question with no story to it
 * gets its answer and nothing tacked on.
 */
export function hookFor(hooks: readonly Hook[] | undefined, input: HookForInput): Hook | null {
  const through = input.through ?? Number.POSITIVE_INFINITY;
  const open = hooks?.filter((h) => (h.book ?? 0) <= through);
  if (!open?.length || input.arriving || !input.tab || input.tab.tier > 0) return null;
  // Spent: a hook she's started for them, or one about something they've already asked
  // her about (she answered it then, so as a cliffhanger it would only be told twice).
  const told = new Set(input.history.flatMap((m) => (m.role === "character" && m.hook ? [m.hook] : [])));
  for (const line of input.history) {
    if (line.role === "guest") for (const hook of open) if (isAbout(hook, line.content)) told.add(hook.id);
  }
  const untold = open.filter((h) => !told.has(h.id));
  const said = String(input.said ?? "")
    .toLowerCase()
    .replace(/[’`]/g, "'");
  const news = wantsNews(input.said) || wantsTheRest(input.said);
  const about = untold
    .map((hook, i) => ({ hook, i, hits: hookPatterns(hook).filter((p) => p.test(said)).length }))
    .filter((m) => m.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)[0];
  // Asked how it turned out: answering gives the ending away, so that story isn't the
  // cliffhanger. "A story that happened in this room" only names which story; it doesn't
  // ask the ending (keeper test kit, 2026-11-11).
  const answered = about && ASKS_THE_OUTCOME.test(said.replace(/\b(?:that|which) happened\b/g, " ")) ? about.hook : null;
  if (about && !answered) return about.hook;
  if (!news && input.tab.freeLeft > 2) return null;
  return untold.find((h) => h !== answered) ?? null;
}
