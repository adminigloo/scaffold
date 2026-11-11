# The character playbook

How to write and test an AI character bound to a world, so the next one — a Name of the
Wind or Dragonlance tavern, say — starts at the polish Hinderstap's keepers reached.
`@adminigloo/characters` (`packages/characters`) is the pure engine this playbook assumes;
this page is the half of the lesson that isn't code: how to write her, how to build and
check her lore, and how to test every bit of it without spending a cent of a live API key.

## 1. The writing rules

A persona is a system prompt a small, cheap model (Claude Haiku) has to hold a voice
against for an entire conversation. Four rules kept Hinderstap's keepers from reading like
a list of adjectives stapled to a chatbot:

- **Worldview and situation, not adjectives.** Don't write "she's warm, nosy and funny."
  Write what she believes, what she's afraid of, what she wants, and what's actually
  sitting in front of her ("gossip is your trade and your weakness," "you keep one eye on
  the light through the window, because every outsider must be on the road before
  sunset"). A model reasons its way into a voice described by situation; an adjective list
  only ever gets asserted back at you, flatly, forever.
- **No example lines — and this one has a cost attached to it, not just a preference.**
  The character-card community (SillyTavern, Character.AI) favors a few short sample
  exchanges to teach a voice. Hinderstap tried it and banned it again: Haiku copied sample
  lines back verbatim, word for word, instead of generalizing the voice they were meant to
  demonstrate. A cheap model pattern-matches on the literal text you hand it far more
  eagerly than it generalizes from it. If you want to test whether your world is the
  exception, the kit in section 6 can answer that for $0 — run the same conversations with
  and without samples and compare the replies, never guess.
- **Nothing in threes.** Don't write an instruction, or a line of her own voice, as a
  list of three. A model mirrors the *shape* of what it's shown as readily as the
  content — three adjectives in the persona becomes three-beat rhythms in every reply
  (three clauses, three gestures, three items offered), which is one of the fastest ways
  a character starts reading as "a model wrote this" rather than as her.
- **One stage direction, and it goes first.** At most one parenthetical about her own
  action, at the very start of a reply, never partway through, written as "she"/"her" the
  way a stage play would put it — `(she sets down her rag)` — and never one she's used
  with this visitor already. Everything else in the reply is her own voice, with no
  further narration of herself or the room. `smooth()`-style cleanup (moving a stray
  direction to the front, stripping a second one, turning asterisked emphasis back to
  plain words) is presentation-layer work for your own app, not something this package
  does for you — but the rule it's enforcing is the one above.
- **Faces.** Every reply opens with a mood tag in brackets, from a short, closed list
  (Hinderstap used six: warm, delighted, sly, shocked, deadpan, spooked), each one
  described by *when* to use it, not what it looks like. A finite, named set of faces is
  something a small model can actually pick from consistently; "show the right emotion"
  is not. Keep a world's whole face vocabulary small enough that each one still means
  something distinct, and — if the character has two selves (day/night, two shifts) — let
  the same six tags mean something different for each (`warm` by day is an easy welcome;
  at night it's a sinister little smile), rather than inventing a second vocabulary.

## 2. The content pipeline

Lore cards don't get written one at a time against a blank page; they get written in a
pipeline that catches its own mistakes before a test ever runs:

1. **A master list.** Before any card gets written, list everything the world's keeper
   might plausibly be asked about — every named character, place, faction and event a fan
   of the source material would expect her to know something about. Hinderstap's did this
   per series (Wheel of Time's "who's who," Dungeon Crawler Carl's floors, factions and
   peoples) before a single card existed.
2. **Batched card writers, each with a brief.** The master list gets worked in batches of
   around 25, each batch scoped to a theme or an era ("25 secondary figures from the
   Salidar/Black Tower/Last Battle era"), one Claude Code subagent per batch. The brief
   names the batch's slice, the book range its facts may draw from, and the exact card
   shape (`id`, `keys`, `text`, `when`, `book`). Small, themed batches are reviewable; "write
   me 150 cards" is not.
3. **A validator.** Before a batch's cards are trusted at all: every id unique (a
   duplicate silently stands in for another card and nobody notices), every card has at
   least one key (a card with none can never be matched and is dead weight), every key
   lowercase (`keyPattern` lowercases what a visitor said before matching, so an
   uppercase key never matches anything), and — if the world's cards open with a `[B5]`
   book tag, as Hinderstap's did — the tag agrees with the card's own `book` field. This
   package's `lintCards` (`packages/characters/src/cards.ts`) is exactly this check,
   runnable before a batch is even wired into a test file.
4. **A unit test holding every card to its gate.** Once a batch is wired in, a test asks
   the actual gating function (`cardsFor` in this package, or your own) the same question
   for every book a visitor could be reading: does this card ever come back past its own
   `book`? Hinderstap's version of this test loops every card at every gate value from 1
   to the series' latest book and asserts the card appears exactly when `book <= through`
   — never "probably," never "we didn't notice it leak." See
   `packages/characters/src/__tests__/cards.test.ts` for the same check, generalized.

## 3. The latest-book rule

When two cards match a question equally well, hand back the one from the latest book the
visitor has reached, not the first one written. "Tell me about Rand" should answer with
his present and the steps that got him there, not only the first book's farm boy, for a
reader who has read far enough to know better. `cardsFor`'s sort — equal hits break
toward the higher `book` — is this rule in one line of code; see the "puts the latest book
they've reached first" test in `cards.test.ts`.

This rule exists because the alternative failure mode is subtle and easy to ship by
accident: nothing crashes, nothing looks wrong in a quick check, the character just always
sounds a little behind where the reader actually is.

## 4. Two layers: truth and the rumor mill

A character who knows a whole series has to keep two kinds of talk straight, and say so
out loud in her own persona so the model never blends them:

- **What's known, she tells exactly.** A lore card's `text` is never hedged, never
  softened into "I heard that…" — it's what she, in-world, simply knows.
- **Gossip, she tells as gossip.** A rumor deck record (`RumorRecord` in this package) is
  explicitly a *telling*, with a `source` (an in-world kind of person, never a named
  visitor), a `sureness`, and a `why`. It can be wrong the way talk is always a little
  wrong, and it comes with her own `verdict` on whether to believe it — but it is never
  presented as settled fact, and a garbled `RumorVersion` is never allowed to carry a fact
  its cited `cards` don't support in the first place (that's what the "every record's book
  is at least as late as every card it cites" test checks).

Keeping these layers apart in the persona's own words ("what's known you tell exactly;
gossip you tell as gossip, and it never goes past the news as it's reached you") is what
lets a visitor *argue* with the gossip layer (`challenge.ts`) without ever being able to
argue a lore card into saying something it doesn't.

## 5. The paid-ending rule

Free talk's rotation should end on a held-back tease — that's what sells the next
purchase. The moment a visitor has already paid for something, that exact same tease
becomes a broken promise: Hinderstap caught itself telling a visitor who'd just bought a
room "not tonight" and "when you've earned it," found only once someone scripted a whole
visit turn by turn instead of testing single replies in isolation (section 6's
conversations, not cases). `endingFor` (`packages/characters/src/flourishes.ts`) is the
fix, kept as its own tiny function for exactly one reason: so a new world's rotation logic
can't reintroduce the bug by copy-pasting the free-talk branch into the paid one. Once a
tier is above free, the ending is always a thread offered freely — `PAID_ENDING` — whatever
the world's own `Flourishes.endings` list says.

The general lesson behind the specific bug: **test whole conversations, not only single
replies.** A case that hands the model one isolated turn can't catch a rule that only
breaks across a sequence of turns (free talk, then a purchase, then the next reply). Build
both kinds of test (section 6).

## 6. The no-API testing method

**The rule, from the top:** Claude Code tests and grades a character. The live model key
pays for real visitors on a deployed site, and nothing else — not a script, not an eval,
not a coding agent's own test harness. This was learned the expensive way: on 2026-11-10,
test scripts burned through an entire month's API credit in about two hours grading
replies with a frontier model, against an explicit instruction to keep costs low. The fix
wasn't "spend less" — it was "never spend at all" for anything that isn't a real visitor.

The method that costs $0:

1. **Cases.** Each case is a visitor's message and its setting — day or night, how far
   they've read, free or paid, the conversation so far — plus an answer key: facts the
   reply must state, claims it must never make, the expected face, and whether it should
   end on a cliffhanger or pay one off. Keys come only from verified lore cards, never from
   memory of the source material. Aim for a mix: canon questions at set reading levels,
   traps (a false premise, a made-up name), spoiler probes, personality checks, and a few
   full purchase flows.
2. **Dump.** Build the *exact* request the live site would send — the same system prompt,
   the same turn notes, the same conversation — using the engine's own functions (this
   package's, or your app's wrapper around them), and write it to a file. This step makes
   no model call and needs no key: it's pure request assembly.
3. **Reply, as a stand-in.** A Claude Code subagent on the same model tier a real visitor
   would get (a cheap model for free talk, a stronger one for paid) reads the dumped
   prompt and writes a reply, playing the character. This is the one step that stands in
   for the live model, and it costs whatever Claude Code itself already costs — never a
   separate API key.
4. **Grade in code first.** Check every reply against its case's answer key
   mechanically: are the required facts present, are the banned claims absent, is there a
   face tag, is the reply the right length, did it end on a cliffhanger or a payoff as
   expected. Only *then* does a Claude Code reviewer read the handful that failed, plus a
   small fixed sample of passes for a personality read — never the whole batch, every
   round.
5. **Fix and repeat.** Fix the persona or the lore, dump again, re-run only the cases the
   change touches, grade again. Commit only when a round beats the one before it.
6. **Whole conversations, not only single turns.** A case alone can't catch a rule that
   only breaks across a sequence (section 5's paid-ending bug). Script a whole visit
   instead — walking in, a books question, some gossip, "go on" after a cliffhanger, a
   purchase paid off mid-conversation, something personal, goodnight — turn by turn, each
   turn handed to a subagent the same way a single case is.
7. **The live check is a separate, approved step — never a default.** Once the kit's
   rounds look good, a *small*, costed check through the real site's UI (not a script
   calling the API directly) confirms the stand-in's replies match the live model's
   closely enough to trust the kit. This step is the only one that touches the real key,
   and it only runs after: the model and the estimated cost in cents are named up front, a
   hard cap is set, and the owner says yes. Nothing upstream of this step ever needs that
   permission, because nothing upstream of it spends anything.

**Why a stand-in is good enough for every step except the last:** Claude Code wraps the
dumped prompt in its own instructions and can't set the live model's sampling temperature
or run its web lookups, so a stand-in's replies are close to the live site's but not
byte-identical. That's fine for comparing one version of a persona against the next —
which is what every round before the live check is actually trying to measure — and the
one short, approved live check at the end is what confirms "close" was close enough.

**A fixture pitfall worth naming, found the same way as the paid-ending bug:** if a test
case's clock fixture says a visitor's nightfall (or any other "time until X" value) is
*zero minutes away*, the character will behave as though that threshold is always already
crossed — Hinderstap's day keeper spent entire scripted visits trying to hurry a visitor
out the door because every case had nightfall arriving in zero minutes rather than a
plausible few hours out. When a case needs a "time until something changes" value, give it
a realistic offset, not a zero you thought was a neutral default.

## Using this with `@adminigloo/characters`

Everything in sections 1, 3 and 4 that's actually *logic* (the book gate, the latest-book
tie-break, the two-layer truth/rumor split, the paid-ending swap) is ported into
`packages/characters` with its own tests — see that package's README for the exact
function list and which specific Hinderstap bug each one fixes. Sections 1, 2, 5 (the
non-code half) and 6 are process, not code, and apply to any world built on top of the
package. The package's own README lists what was deliberately left out of this first cut
(rumor corrections, the test-kit scripts themselves) and why.

## Follow-up: a `create-app` venue template (not done here)

`create-app` already has the shape this would need, just not pointed at a character yet:

- A new capability (`packages/create-app/src/capabilities.ts` lists every capability
  `adminigloo.json` is allowed to claim, each with proof that something emitted actually
  provides it — `assertCapabilitiesAreProvable` refuses a claim nothing backs). A
  `characters` capability's evidence would be an emitted file that imports
  `@adminigloo/characters` and a venue folder under the generated project's `src/`.
- An emit module (see any `*-emit.ts` in `packages/create-app/src`) that writes a venue
  folder — a persona, lore cards, hooks, a rumor deck, following this playbook's content
  pipeline — plus the keeper test-kit scripts (`dump`/`grade`/`talk`, docs/KEEPER-TESTING.md
  in Hinderstap is the model to generalize from) scoped to that venue.
- An overlay (`packages/create-app/overlays/`, one folder per generator flag) if the venue
  scaffold should be opt-in rather than bundled with every `characters` install.

This is deliberately not built in this pass: it's a generator feature with its own
review surface (new CLI flags, new emitted files, new capability-evidence rules), and
the engine it would scaffold around needed to exist and be tested first.
