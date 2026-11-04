/**
 * THE AI-SMELL CHECK (docs/character-playbook.md, section 5): the patterns
 * that give a line away as written by a model, and one function that says
 * why a line smells, or null. Plain TypeScript, no app: an app wires it into
 * its own checks (Almanac's: its characters' voices), with the parts that differ by
 * who's speaking and by what the line is for.
 *
 * A model writes the most likely line, and humor lives in the unlikely one,
 * so code does the rejecting: any hit here means the line is thrown away and
 * another (or the app's own fixed line) is used. The list stays short and
 * aimed at specific patterns: banning thousands of tokens wrecks a model's
 * output, and a short list is one a person can read.
 */

/** Section 5A, as the playbook writes it: any hit means reject. */
export const REJECT = {
  dash: /[–—]|\s--?\s/,
  neg1: /\b(?:it'?s|that'?s|that is|this is|it is|he'?s|she'?s)\s+not\s+(?:just\s+|only\s+|about\s+)?[^.!?]{1,40}?[,;.]\s*(?:it'?s|that'?s|that is|this is|it is|but)\b/i,
  neg2: /\bnot\s+(?:just|only|merely|simply)\b[^.!?]{0,50}\bbut\b/i,
  neg3: /\bno\s+\w+(?:\s\w+)?[.,]\s*no\s+\w+(?:\s\w+)?[.,]\s*just\b/i,
  // Run on the line with its vocatives taken out (VOCATIVES), so a chatty line's commas don't trip it.
  triad: /\b[\w']+(?:\s[\w']+){0,2},\s+[\w']+(?:\s[\w']+){0,2},?\s+(?:and|or)\s+[\w']+/i,
  isAvoid: /\b(?:serves as|stands as|acts as|functions as|a testament to|a reminder (?:of|that))\b/i,
  ingTail: /,\s+(?:highlighting|underscoring|showcasing|reflecting|emphasizing|ensuring|fostering|proving|reminding)\b/i,
  assistant:
    /\b(?:it'?s (?:important|worth) (?:to note|noting)|remember,? that|let'?s (?:dive|be honest|talk)|fun fact|pro tip|spoiler alert|plot twist|buckle up|here'?s the thing|the truth is|in a world where|at the end of the day|when it comes to|honestly|basically|needless to say|i must say|dare i say|just saying|i think not|we'?ve all been there)\b/i,
  vocab:
    /\b(?:delve|tapestry|testament|vibrant|crucial|pivotal|realm|landscape|journey|navigate|embark|symphony|elevate|unleash|unlock|seamless|robust|nuanced?|multifaceted|profound|intricate|meticulous(?:ly)?|quietly|steady|showcas\w*|foster\w*|leverag\w*|underscor\w*|whimsy|whimsical|quirky|curated|crafted|nestled|boasts?)\b/i,
  sass: /\b(?:delightful(?:ly)?|chaos|chaotic|vibes?|absolutely|simply|truly|literally|utterly|quite the|iconic|epic|legendary|magical|sassy|spicy|unhinged|energy|slay|bestie|mood|no cap|lowkey|main character|it'?s giving|rent[- ]free|vibe check|we love to see it|that'?s the tweet|iykyk)\b/i,
  qa1: /^\s*(?:why|what|how)\s+(?:did|do|does|is|was|would)\b[^?]*\?\s*\S/i,
  qa2: /\bwhat do you call\b/i,
  explain: /\b(?:get it|pun intended|no pun|see what i did|if you know what i mean|that'?s the joke)\b/i,
  wpun: /\b(?:brr\w*|sun-?sational|under the weather|steal(?:s)? (?:my|the) thunder|rain(?:s|ed)? on (?:my|your|the) parade|chill out|hot take|snow way|weather(?:ed)? the storm|hail (?:yes|no|mary)|spooktacular|boo-?tiful|breez(?:e|ed|y) through|snowed under|right as rain|calm before the storm|when it rains|silver lining|fair[- ]weather|on cloud)\b/i,
  // On top of an app's own number check.
  numx: /[°%]|\b(?:half|dozen|percent|degrees?|first|second|third|once|twice|single|double|triple|million|billion)\b/i,
  // On top of an app's own honesty check.
  pred: /\b(?:tomorrow|later today|this (?:afternoon|evening|week)|soon|wager|my money|easy money|fade|hammer|sure thing|can'?t lose)\b/i,
  emoji: /\p{Extended_Pictographic}/u,
  bang2: /!.*!/,
  moral: /\b(?:lesson|moral of the story|the takeaway|learned|in the end|after all|turns out|the real \w+ (?:is|was))\b/i,
  ghostpun: /\b(?:spooktacular|boo-?tiful|ghoul(?:ish)?ly|fang-?tastic|spoopy|so spooky)\b/i,
  // A costume voice's words: refused for a plain speaker, skipped for the one who wears the costume.
  costumeAG: /\b(?:thee|thou|thy|ye|verily|alas|forsooth|hark|behold|mortals?|beware|tremble)\b/i,
  // A live (model-written) line refuses these; a fixed line may keep them, as the editor decides (LIVE_ONLY).
  frag3: /^(?:[^.!?]{1,25}[.!?]\s+){2}[^.!?]{1,25}[.!?]\s*$/,
  weakEnd: /\b(?:it|too|though|anyway|again|really|now|then|there|here|indeed|actually|apparently|since|either|also|still|so|well)[.!?"*]*$/i,
  ellipsis: /\.\.\.|…/,
  question: /\?/,
} as const satisfies Readonly<Record<string, RegExp>>;

export type RejectName = keyof typeof REJECT;

/** What each REJECT pattern caught, in a note's words. */
export const REJECT_WHY: Readonly<Record<RejectName, string>> = {
  dash: "a dash",
  neg1: "an it's-not-this-it's-that turn",
  neg2: "a not-just-this-but-that turn",
  neg3: "a no-this, no-that, just-this turn",
  triad: "a list of three",
  isAvoid: "a stands-as phrase",
  ingTail: "an -ing tail",
  assistant: "an assistant's phrase",
  vocab: "a model's favorite word",
  sass: "a brand's sass word",
  qa1: "a question-and-answer setup",
  qa2: "a what-do-you-call setup",
  explain: "it explained itself",
  wpun: "a weather pun",
  numx: "a number word",
  pred: "a word about what's coming",
  emoji: "an emoji",
  bang2: "two exclamation points",
  moral: "a moral",
  ghostpun: "a ghost pun",
  costumeAG: "a costume word",
  frag3: "three short fragments in a row",
  weakEnd: "a weak last word",
  ellipsis: "an ellipsis",
  question: "a question",
};

/** The four a model's line refuses and a person's fixed line may keep (the playbook flags them for its editor). */
export const LIVE_ONLY: readonly RejectName[] = ["frag3", "weakEnd", "ellipsis", "question"];

/** A name said to someone mid-line (", dearie,"), taken out before the triad test. */
export const VOCATIVES = /,\s*(?:dearie|sweetheart|sweetie|honey|friends?|folks|bless (?:him|her|his heart|her heart|it))\s*(?=[,.!?])/gi;

/** A word in capitals, three letters or more: two in a line is always a reject. */
export const CAPS_WORD = /\b[A-Z]{3,}\b/g;

/** A contraction ("it's", "don't", "I've"), for a speaker who never uses one. Not a possessive ("today's"). */
export const CONTRACTION = /\b(?:it|that|he|she|there|what|who|here)'s\b|\b\w+n't\b|\b\w+'(?:re|ve|ll|d|m)\b/i;

/** A stage direction: *rattles keys*. */
export const STAGE_DIRECTION = /\*[^*]+\*/g;

/**
 * Section 5B: the patterns the playbook caps over a speaker's last twenty
 * lines rather than refusing in one. Kept here so an app counting them (or
 * refusing one outright, as Almanac does for a ghost's atmosphere words)
 * reads the same list.
 */
export const CAPPED = {
  costumeOpen: /^(?:\*[^*]+\*\s*)?(?:hark|behold|mortals?|beware|tremble|lo|weep|o{3,}h*)\b/i,
  capsWord: /\b[A-Z]{3,}\b/,
  stageDir: /\*[^*]+\*/,
  atmosphere: /\b(?:echo\w*|whisper\w*|hum(?:s|ming)?|shadows?|spectral|ethereal|haunt\w*|eerie|veil|beyond|spirits?)\b/i,
  endearment: /\b(?:dearie|sweetheart|sweetie|honey|(?:poor )?lamb)\b/i,
  bless: /\bbless (?:him|her|it|them|his heart|her heart)\b/i,
  interjection: /^(?:ah|oh|well|ahem|hmm+|ooh+|ugh|listen|look),?\s/i,
} as const satisfies Readonly<Record<string, RegExp>>;

/**
 * The names any line may use mid-sentence: "I", the days (singular and
 * plural) and the months. Any other capitalized word mid-sentence is an
 * invented one, unless the app adds it: its characters, its business, the
 * products it names (Almanac adds its cast, "Almanac", "Kalshi" and
 * "Polymarket"). A name taken off an app's list is refused from then on, so a
 * renamed character can never reach a post under the old name.
 */
export const APPROVED_NAMES: readonly string[] = ["I", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** How one speaker talks, as code can check it. Absent rules don't apply. */
export interface SpeakerStyle {
  /** Their name, for a note: "it broke Doldrum's voice". */
  readonly name?: string;
  /** False: never a contraction. */
  readonly contractions?: boolean;
  /** The most exclamation points in one line (two is a reject for anyone: REJECT.bang2). */
  readonly maxBangs?: number;
  /** The most words in capitals in one line; 1 when absent, since two is a reject for anyone. */
  readonly maxCapsWords?: number;
  /** False: never a stage direction. */
  readonly stageDirections?: boolean;
  /** More of this speaker's refusals, each with why: a ghost's atmosphere words. */
  readonly refuse?: readonly (readonly [RegExp, string])[];
  /** The fewest and the most words in a line. */
  readonly words?: readonly [number, number];
  /** The most sentences in a line. */
  readonly sentences?: number;
  /** The most words in each sentence after the first. */
  readonly laterSentenceWords?: number;
}

export interface SmellOptions {
  /** REJECT patterns that don't apply here: LIVE_ONLY for a person's fixed line, the numbers and names for a hook that carries the facts'. */
  readonly skip?: readonly RejectName[];
  /** The names a line may use mid-sentence (APPROVED_NAMES when absent); false skips the invented-names check. */
  readonly names?: readonly string[] | false;
  readonly style?: SpeakerStyle;
}

/** Curly quotes as straight ones, so "it’s" is checked like "it's". */
const straight = (text: string) => text.replace(/[‘’ʼ]/g, "'");

const DAYS = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s$/;

/** Capitalized words after a sentence's first that aren't on the list: "Uncle Bartholomew left a hat" names Bartholomew. */
export function inventedNames(text: string, approved: readonly string[] = APPROVED_NAMES): string[] {
  const allowed = new Set(approved);
  const tokens = straight(text).replace(STAGE_DIRECTION, " ").split(/\s+/).filter(Boolean);
  const found: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const word = tokens[i]!.replace(/[^A-Za-z']/g, "").replace(/'s$/, "");
    if (!/^[A-Z][a-z]/.test(word) || /[.!?]["')*]*$/.test(tokens[i - 1]!)) continue;
    if (allowed.has(word) || (DAYS.test(word) && allowed.has(word.slice(0, -1)))) continue;
    found.push(word);
  }
  return [...new Set(found)];
}

/** A line's sentences, stage directions aside. */
function sentencesOf(text: string): string[] {
  return text
    .replace(STAGE_DIRECTION, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Every reason a line smells, in order; empty when it passes. */
export function smells(line: string, options: SmellOptions = {}): string[] {
  const text = straight(line.trim());
  const skip = new Set(options.skip ?? []);
  const style = options.style ?? {};
  const voice = style.name ? `${style.name}'s voice` : "the speaker's voice";
  const found: string[] = [];
  const unvoiced = text.replace(VOCATIVES, "");
  for (const name of Object.keys(REJECT) as RejectName[]) {
    if (skip.has(name)) continue;
    if (REJECT[name].test(name === "triad" ? unvoiced : text)) found.push(`it smelled of AI (${REJECT_WHY[name]})`);
  }
  if (options.names !== false) {
    const invented = inventedNames(text, options.names ?? APPROVED_NAMES);
    if (invented.length) found.push(`it named someone nobody knows (${invented.join(", ")})`);
  }
  const caps = text.match(CAPS_WORD) ?? [];
  const maxCaps = Math.min(style.maxCapsWords ?? 1, 1);
  if (caps.length > maxCaps) found.push(caps.length > 1 ? `it had more than one word in capitals (${caps.join(", ")})` : `it broke ${voice} (a word in capitals: ${caps[0]})`);
  const bangs = (text.match(/!/g) ?? []).length;
  // Two or more are REJECT.bang2's already, unless it's skipped.
  if (style.maxBangs !== undefined && bangs > style.maxBangs && (bangs < 2 || skip.has("bang2"))) found.push(`it broke ${voice} (${style.maxBangs ? "too many exclamation points" : "an exclamation point"})`);
  if (style.contractions === false) {
    const contraction = CONTRACTION.exec(text)?.[0];
    if (contraction) found.push(`it broke ${voice} (a contraction: ${contraction})`);
  }
  if (style.stageDirections === false && /\*[^*]+\*/.test(text)) found.push(`it broke ${voice} (a stage direction)`);
  for (const [re, why] of style.refuse ?? []) if (re.test(text)) found.push(`it broke ${voice} (${why})`);
  if (style.words) {
    const n = wordCount(text);
    const [least, most] = style.words;
    if (n < least || n > most) found.push(`it was the wrong length for ${voice} (${n} words, ${least} to ${most})`);
  }
  if (style.sentences !== undefined || style.laterSentenceWords !== undefined) {
    const sentences = sentencesOf(text);
    if (style.sentences !== undefined && sentences.length > style.sentences) found.push(`it was the wrong shape for ${voice} (${sentences.length} sentences, at most ${style.sentences})`);
    const later = style.laterSentenceWords;
    if (later !== undefined && sentences.slice(1).some((s) => wordCount(s) > later)) found.push(`it was the wrong shape for ${voice} (a later sentence over ${later} words)`);
  }
  return found;
}

/** Why a line smells (the first reason), or null when it passes. */
export function smell(line: string, options: SmellOptions = {}): string | null {
  return smells(line, options)[0] ?? null;
}
