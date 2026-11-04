import { describe, expect, it } from "vitest";
import { APPROVED_NAMES, CAPPED, inventedNames, LIVE_ONLY, REJECT, REJECT_WHY, smell, smells, type RejectName } from "../smell.js";

/** Almanac's cast, as an app adds its own names (the package's own list is only I, the days and the months). */
const CAST = [...APPROVED_NAMES, "Doldrum", "Mortimer", "Mercury", "Granny", "Gale", "Doug", "Earl"];

/**
 * THE AI-SMELL CHECK (src/social/smell.ts; docs/character-playbook.md,
 * section 5): every REJECT pattern catches its case and lets the plain line
 * beside it through; the names, the capitals and a speaker's style hold;
 * and the playbook's negative control, twelve AI-sounding lines, is refused
 * whole.
 */

/** Each REJECT pattern: a line it catches, and a near line it lets by. */
const CASES: Readonly<Record<RejectName, readonly [string, string]>> = {
  dash: ["My nest — mine.", "A well-measured leak."],
  neg1: ["It's not just a nest, it's a lifestyle.", "It is not a nest."],
  neg2: ["Not just a ladder but a way of life.", "Not just a ladder."],
  neg3: ["No crystal ball. No fuss. Just the thermometer.", "No crystal ball. Just the thermometer."],
  triad: ["Cold, wet, and ruined.", "Cold and wet."],
  isAvoid: ["The ladder serves as my crystal ball.", "The ladder is my crystal ball."],
  ingTail: ["The leak dripped all night, highlighting my bucket.", "The leak dripped all night into my bucket."],
  assistant: ["Fun fact: the nest is mine.", "The nest is mine."],
  vocab: ["The nest is a tapestry of twigs.", "The nest is a heap of twigs."],
  sass: ["Delightfully chaotic vibes in the attic.", "Twigs in the attic."],
  qa1: ["Why did the cloud quit? It needed space.", "Why the cloud quit is not my business."],
  qa2: ["What do you call a wet wizard.", "What I call it is a bucket."],
  explain: ["The leak is a drip, get it.", "The leak is a drip."],
  wpun: ["Some days you weather the storm.", "Some days the weather is in the attic."],
  numx: ["I have read it twice.", "I have read the thermometer."],
  pred: ["The leak stops soon.", "The leak stopped."],
  emoji: ["The nest \u{1FAB9}", "The nest."],
  bang2: ["Behold! The VACUUM!", "Behold, the vacuum!"],
  moral: ["Turns out the bucket was full.", "The bucket was full."],
  ghostpun: ["A spoopy evening in the attic.", "A dark evening in the attic."],
  costumeAG: ["Behold, the ladder.", "Hold the ladder."],
  frag3: ["Tea. Nest. Thermometer.", "Tea. Nest."],
  weakEnd: ["I measured the leak again.", "I measured the leak."],
  ellipsis: ["Hmm, the nest... it remembers.", "The nest remembers."],
  question: ["The future?", "The future."],
};

/** The playbook's negative control (section 0): twelve lines that sound like a model. Every one is refused. */
const AI_SOUNDING = [
  "It's not just a nest, it's a lifestyle.",
  "Cold, wet, and ruined.",
  "Delightfully chaotic vibes in the attic!",
  "Why did the cloud quit? It needed space.",
  "Doldrum sips his tea quietly, a testament to patience.",
  "Some days you just have to weather the storm.",
  "Not a prediction, but a reminder that the past matters.",
  "Hmm, the nest... it remembers.",
  "Behold, the THERMOMETER!",
  "Tea. Nest. Thermometer.",
  "I measured the leak again.",
  "Uncle Bartholomew left a hat.",
];

describe("the REJECT list", () => {
  it("has every pattern the playbook lists, each with words for a note", () => {
    expect(Object.keys(REJECT).sort()).toEqual(Object.keys(CASES).sort());
    expect(Object.keys(REJECT_WHY).sort()).toEqual(Object.keys(REJECT).sort());
    expect([...LIVE_ONLY].sort()).toEqual(["ellipsis", "frag3", "question", "weakEnd"]);
  });

  it.each(Object.entries(CASES) as [RejectName, readonly [string, string]][])("%s: catches its case, lets the plain line by", (name, [caught, plain]) => {
    expect({ name, line: caught, reasons: smells(caught, { names: false }) }).toMatchObject({ reasons: expect.arrayContaining([`it smelled of AI (${REJECT_WHY[name]})`]) });
    expect({ name, line: plain, hit: smells(plain, { names: false }).includes(`it smelled of AI (${REJECT_WHY[name]})`) }).toEqual({ name, line: plain, hit: false });
  });

  it("refuses the playbook's twelve AI-sounding lines, every one", () => {
    for (const line of AI_SOUNDING) expect({ line, refused: smell(line) !== null }).toEqual({ line, refused: true });
  });

  it("runs the triad test without the vocatives, so a chatty line's commas don't trip it", () => {
    expect(smell("Then you checked it with a spoon, dearie, several times.")).toBeNull();
    expect(smell("Mercury thanks me every morning, bless him, through the closet door.", { names: CAST })).toBeNull();
    // A real list of three is still one, whoever it's said to.
    expect(smell("The soup, the cat, dearie, and the kettle.")).toBe("it smelled of AI (a list of three)");
  });

  it("skips what doesn't apply here: a fixed line's question, a hook's numbers", () => {
    expect(smell("The future? Never been. I hear it is mostly opinions.")).toBe("it smelled of AI (a question)");
    expect(smell("The future? Never been. I hear it is mostly opinions.", { skip: ["question"] })).toBeNull();
    expect(smell("Oct 26: 17 of 24 favorites came in, 71°F at the high.", { skip: ["numx"], names: false })).toBeNull();
  });

  it("reads curly apostrophes as straight ones", () => {
    expect(smell("It’s not just a nest, it’s a lifestyle.")).toBe("it smelled of AI (an it's-not-this-it's-that turn)");
  });

  it("gives every reason in order, and the first as the reason", () => {
    expect(smells("Behold, the THERMOMETER! Fun fact.", { style: { name: "Al", maxCapsWords: 0 } })).toEqual(["it smelled of AI (an assistant's phrase)", "it smelled of AI (a costume word)", "it broke Al's voice (a word in capitals: THERMOMETER)"]);
    expect(smell("The nest.")).toBeNull();
  });
});

describe("the names, the capitals and a speaker's style", () => {
  it("refuses a capitalized word mid-sentence that isn't an approved name", () => {
    expect(smell("Uncle Bartholomew left a hat.")).toBe("it named someone nobody knows (Bartholomew)");
    expect(inventedNames("Granny's soup and Doug's tea, on Mondays and on Tuesday.", CAST)).toEqual([]);
    // A sentence's first word is anybody's; so is a stage direction.
    expect(inventedNames("I left. Then Doldrum left. *Rattles keys* Earl stayed. Then Mortimer Doldrum sat.", CAST)).toEqual([]);
    // The wizard's old name is off the list (Oct 30, 2026): a line that still says it is refused.
    expect(inventedNames("Granny says Al is asleep.", CAST)).toEqual(["Al"]);
    expect(inventedNames("Gerald and Mercury.", [...CAST, "Gerald"])).toEqual([]);
    expect(inventedNames("We met Gerald.", [...CAST, "Gerald"])).toEqual([]);
    expect(smell("We met Gerald by the shed.", { names: false })).toBeNull();
  });

  it("refuses two words in capitals for anyone, and one where a speaker takes none", () => {
    expect(smell("The VACUUM and the DRYER came for me.")).toBe("it had more than one word in capitals (VACUUM, DRYER)");
    expect(smell("The VACUUM came for me.")).toBeNull();
    expect(smell("The VACUUM came for me.", { style: { name: "Al", maxCapsWords: 0 } })).toBe("it broke Al's voice (a word in capitals: VACUUM)");
    // Two letters is no shout ("US", "AM").
    expect(smell("The US clocks went back at AM.", { style: { maxCapsWords: 0 } })).toBeNull();
  });

  it("holds a speaker to their own signals: contractions, exclamation points, stage directions, their own refusals", () => {
    const flat = { name: "Al", contractions: false, maxBangs: 0, stageDirections: false } as const;
    expect(smell("I don't do mornings.", { style: flat })).toBe("it broke Al's voice (a contraction: don't)");
    expect(smell("I've filed the morning.", { style: flat })).toBe("it broke Al's voice (a contraction: I've)");
    // A possessive isn't a contraction.
    expect(smell("Today's tea is cold.", { style: flat })).toBeNull();
    expect(smell("The tea is cold!", { style: flat })).toBe("it broke Al's voice (an exclamation point)");
    expect(smell("*sighs* The tea is cold.", { style: flat })).toBe("it broke Al's voice (a stage direction)");
    expect(smell("The tea is cold!", { style: { maxBangs: 1 } })).toBeNull();
    const ghost = { name: "Mercury", refuse: [[CAPPED.atmosphere, "a ghost-atmosphere word"]] as const };
    expect(smell("I rose from the shadows of the pantry.", { style: ghost })).toBe("it broke Mercury's voice (a ghost-atmosphere word)");
    expect(smell("I rose from the pantry.", { style: ghost })).toBeNull();
  });

  it("holds a live line to its shape: its length in words, its sentences, a short second one", () => {
    const shape = { name: "Al", words: [3, 12], sentences: 2, laterSentenceWords: 5 } as const;
    expect(smell("The nest lost a twig. I reported it missing.", { style: shape })).toBeNull();
    expect(smell("Logged.", { style: shape })).toBe("it was the wrong length for Al's voice (1 words, 3 to 12)");
    expect(smell("The nest lost a twig in the night and I have reported it missing to the porch.", { style: shape })).toMatch(/^it was the wrong length for Al's voice \(\d+ words, 3 to 12\)$/);
    expect(smell("The nest lost a twig. I reported the twig as missing.", { style: shape })).toBe("it was the wrong shape for Al's voice (a later sentence over 5 words)");
    expect(smells("Twig gone. Nest smaller. I noted the twig.", { style: shape })).toEqual(["it smelled of AI (three short fragments in a row)", "it was the wrong shape for Al's voice (3 sentences, at most 2)"]);
    // A stage direction alone is no sentence.
    expect(smell("*snuffs the lantern for effect* *relights it immediately*", { style: { words: [5, 16], sentences: 2 } })).toBeNull();
  });
});
