import { describe, expect, it } from "vitest";
import {
  hookById,
  hookFor,
  hookTelling,
  isAbout,
  justServed,
  storyAskedFor,
  storyHanging,
  storyLeftHanging,
  wantsNews,
  wantsTheRest,
} from "../hooks.js";
import type { HistoryLine, Hook, Tab } from "../types.js";

const FREE: Tab = { tier: 0, freeLeft: 8 };
const PAID: Tab = { tier: 1, freeLeft: 0 };
const hook = (id: string, book?: number, more: Partial<Hook> = {}): Hook => ({
  id,
  keys: [id],
  setup: `${id} setup`,
  payoff: `${id} payoff`,
  when: "test",
  ...(book !== undefined ? { book } : {}),
  ...more,
});

describe("hookById / isAbout / hookTelling", () => {
  const hooks = [hook("a"), hook("b", undefined, { night: { setup: "b night setup", payoff: "b night payoff" } })];

  it("finds a hook by id, or null for one that's gone", () => {
    expect(hookById(hooks, "a")?.id).toBe("a");
    expect(hookById(hooks, "missing")).toBeNull();
    expect(hookById(hooks, null)).toBeNull();
    expect(hookById(undefined, "a")).toBeNull();
  });

  it("matches a hook's subject possessive or not", () => {
    expect(isAbout(hook("growler-gary", undefined, { keys: ["growler gary"] }), "what about Growler Gary's hands")).toBe(true);
    expect(isAbout(hook("x"), "something unrelated")).toBe(false);
  });

  it("tells her other self's version when there is one", () => {
    expect(hookTelling(hooks[1] as Hook, false).setup).toBe("b setup");
    expect(hookTelling(hooks[1] as Hook, true).setup).toBe("b night setup");
    expect(hookTelling(hooks[0] as Hook, true).setup).toBe("a setup"); // no night half: falls back
  });
});

describe("justServed and storyHanging", () => {
  it("is true only when her last line marks a purchase", () => {
    expect(justServed([{ role: "character", content: "here", purchase: true }])).toBe(true);
    expect(justServed([{ role: "character", content: "here", purchase: false }])).toBe(false);
    expect(justServed([])).toBe(false);
  });

  it("finds the hook her latest line left hanging", () => {
    const hooks = [hook("a")];
    const history: HistoryLine[] = [{ role: "character", content: "setup", hook: "a" }];
    expect(storyHanging(hooks, history)?.id).toBe("a");
    expect(storyHanging(hooks, [{ role: "character", content: "no hook" }])).toBeNull();
  });
});

describe("storyLeftHanging", () => {
  const hooks = [hook("a"), hook("b")];

  it("is null when nothing was just bought", () => {
    expect(storyLeftHanging([{ role: "character", content: "x" }], hooks)).toBeNull();
  });

  it("with hooks: hands back the hook the purchase line's predecessor left hanging", () => {
    const history: HistoryLine[] = [
      { role: "guest", content: "tell me about a" },
      { role: "character", content: "a setup", hook: "a" },
      { role: "character", content: "here's your ale", purchase: true },
    ];
    const left = storyLeftHanging(history, hooks);
    expect((left as Hook | null)?.id).toBe("a");
  });

  it("with hooks: null once a purchase already paid it off (no double payoff)", () => {
    const history: HistoryLine[] = [
      { role: "character", content: "a setup", hook: "a" },
      { role: "character", content: "poured", purchase: true },
      { role: "character", content: "paid off, no new hook" },
      { role: "character", content: "another round", purchase: true },
    ];
    expect(storyLeftHanging(history, hooks)).toBeNull();
  });

  it("without hooks: quotes her last reply before the purchase, stage directions stripped", () => {
    const history: HistoryLine[] = [
      { role: "character", content: "(she leans in) the dice came up all sixes" },
      { role: "character", content: "here's your ale", purchase: true },
    ];
    expect(storyLeftHanging(history)).toBe("the dice came up all sixes");
  });

  it("without hooks: cuts a long quote to the tail, at a word boundary", () => {
    const long = "word ".repeat(100).trim();
    const history: HistoryLine[] = [
      { role: "character", content: long },
      { role: "character", content: "ale", purchase: true },
    ];
    const quoted = storyLeftHanging(history) as string;
    expect(quoted.startsWith("…")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(261);
  });
});

describe("wantsNews / wantsTheRest", () => {
  it("treats a greeting, or silence, as wanting news", () => {
    expect(wantsNews(undefined)).toBe(true);
    expect(wantsNews("hi")).toBe(true);
    expect(wantsNews("tell me the latest gossip")).toBe(true);
  });

  it("leaves a plain question about one thing alone", () => {
    expect(wantsNews("What is the Horn of Valere?")).toBe(false);
  });

  it("recognizes asking her to go on", () => {
    expect(wantsTheRest("go on")).toBe(true);
    expect(wantsTheRest("and?")).toBe(true);
    expect(wantsTheRest("what happened next")).toBe(true);
    expect(wantsTheRest("thanks")).toBe(false);
  });
});

describe("storyAskedFor", () => {
  const hooks = [hook("a")];

  it("is null without hooks, without a tab, on a paid tab, or without asking", () => {
    expect(storyAskedFor(undefined, [], "go on", FREE)).toBeNull();
    expect(storyAskedFor(hooks, [], "go on", null)).toBeNull();
    expect(storyAskedFor(hooks, [], "go on", PAID)).toBeNull();
    expect(storyAskedFor(hooks, [{ role: "character", content: "x", hook: "a" }], "thanks", FREE)).toBeNull();
  });

  it("hands back the hanging hook when they ask her to go on, on free talk", () => {
    const history: HistoryLine[] = [{ role: "character", content: "a setup", hook: "a" }];
    expect(storyAskedFor(hooks, history, "go on", FREE)?.id).toBe("a");
  });
});

describe("hookFor", () => {
  const hooks = [hook("late", 12), hook("early", 2)];

  it("picks nothing on arrival, without a free tab, or on a paid tab", () => {
    expect(hookFor(hooks, { history: [], tab: FREE, arriving: true })).toBeNull();
    expect(hookFor(hooks, { history: [], tab: null, arriving: false })).toBeNull();
    expect(hookFor(hooks, { history: [], tab: PAID, arriving: false })).toBeNull();
  });

  it("never starts a hook from a book past the reader's", () => {
    expect(hookFor(hooks, { said: "any gossip?", history: [], tab: FREE, arriving: false, through: 3 })?.id).toBe("early");
    expect(hookFor(hooks, { said: "any gossip?", history: [], tab: FREE, arriving: false, through: 12 })?.id).toBe("late");
    expect(hookFor(hooks, { said: "tell me about late", history: [], tab: FREE, arriving: false, through: 3 })).toBeNull();
    expect(hookFor(hooks, { said: "tell me about late", history: [], tab: FREE, arriving: false, through: 12 })?.id).toBe("late");
  });

  it("answers a 'why' instead of opening the story that holds the answer", () => {
    expect(hookFor(hooks, { said: "Why does everyone fuss about early?", history: [], tab: FREE, arriving: false, through: 12 })).toBeNull();
    // Asking for a story as well as the "why": another one, never the one that holds the answer.
    expect(
      hookFor(hooks, { said: "Why does everyone fuss about the early story?", history: [], tab: FREE, arriving: false, through: 12 })?.id,
    ).toBe("late");
  });

  it("never starts a hook she's already told, or already answered as a question", () => {
    const told: HistoryLine[] = [{ role: "character", content: "x", hook: "early" }];
    expect(hookFor(hooks, { said: "any gossip?", history: told, tab: FREE, arriving: false, through: 12 })?.id).toBe("late");
    const asked: HistoryLine[] = [{ role: "guest", content: "tell me about early" }];
    expect(hookFor(hooks, { said: "any gossip?", history: asked, tab: FREE, arriving: false, through: 12 })?.id).toBe("late");
  });

  it("holds off on an unrelated plain question until free questions run low", () => {
    const plenty: Tab = { tier: 0, freeLeft: 8 };
    expect(hookFor(hooks, { said: "What is the Horn of Valere?", history: [], tab: plenty, arriving: false, through: 12 })).toBeNull();
    const low: Tab = { tier: 0, freeLeft: 1 };
    expect(hookFor(hooks, { said: "What is the Horn of Valere?", history: [], tab: low, arriving: false, through: 12 })?.id).toBe("late");
  });
});
