# @adminigloo/characters

The pure, model-free engine behind an AI character bound to a world: lore cards gated by
book, two-part story hooks that pay off after a purchase, rotating flourishes with a
separate paid ending, a rumor deck she can argue about, and a ledger that remembers a
regular past her own forgetting. Ported from building Hinderstap's keepers (the Wheel of
Time's Tipsy Gelding, Dungeon Crawler Carl's Desperado Club) so the next world — a Name of
the Wind or Dragonlance tavern, say — starts at the same polish.

**Nothing here calls a model, and nothing here needs one to run or test.** Every function
is a deterministic pick over plain data (`Date.now()` aside, and even that's always an
injectable parameter). A model is only ever handed what this package already decided it
may say: a card's text, a hook's setup, a challenged record's truth. See
`docs/character-playbook.md` (repo root) for the writing rules, the content pipeline, and
the no-API testing method this package's own tests follow.

## What you get

| Concern | From | What it does |
| --- | --- | --- |
| Card matching | `cards.ts` | `keyPattern` (possessive-tolerant keyword matching), `opensAt` and `cardsFor` (the book gate, a `secret` card's tier, equal-match tie-breaking toward the latest book), `mentionedCardIds`, `lintCards` (the validator a card batch should pass before it ships) |
| Story hooks | `hooks.ts` | `hookFor` (which cliffhanger to open, never one that gives away the very answer asked), `storyLeftHanging` / `storyAskedFor` / `storyHanging` (the payoff after a purchase, or on request), `wantsNews` / `wantsTheRest`, `isAbout`, `hookTelling`, `justServed` |
| Flourishes | `flourishes.ts` | `endingFor` (free talk's rotating tease, swapped for `PAID_ENDING` the moment a tier is paid — the exact bug this fixes is below), `leanFor`, `stagingFor` |
| Arguing with the day's talk | `challenge.ts` | `isChallenge`, `challengedRecord` (the lookup, gated by reading), `challengedNote` (stand firm, hedge, or concede with style, by how sure the telling was) |
| Her ledger | `ledger.ts` | `relationshipFor` (first visit, regular, back after a long absence), `arrivalNote`, `formatReading`, `LONG_ABSENCE_DAYS` |
| Character of the day | `character-of-day.ts` | `characterOfDay`: one card per visitor per day, stable, gated, steered away from what they've already mentioned |
| The day's rumor pick | `rumors.ts` | `recordsFor`: a deterministic, wrapping window over a rumor deck, gated by a public boundary |
| Persona sections | `persona.ts`, `types.ts` | `PersonaSections` (the day/night-split shape), `personaFor` / `checklistFor` (pick the right half), `primerFor` (the same book gate, applied to dated world knowledge) |

Every function takes the narrow pieces it needs — a card array, a hook array, a rumor
deck — rather than one `Venue` megatype threading through everything. Compose them
however your own app's data shapes call for.

## The lessons each piece carries

- **Possessive keys** (`cards.ts`, `keyPattern`). A card keyed on a name didn't match that
  name's own possessive ("Mongo's a father") because the apostrophe sat where the word
  boundary was expected — found by Hinderstap's Claude Code test kit, never by a model
  complaining.
- **The paid-ending bug** (`flourishes.ts`, `endingFor`). Free talk's rotation ends on a
  held-back tease, which is exactly wrong once someone has already paid: Hinderstap told a
  visitor who'd just bought a room "not tonight" and "when you've earned it". `endingFor`
  is kept as its own function precisely so a new world's rotation can't reintroduce the
  bug by copy-pasting the free-talk branch.
- **`Hook.endingCards`** (`types.ts`, and `cardsFor`'s `leaveOut`/`exclude`). While a hook
  is only telling its setup, the cards that would give its ending away are kept out of
  what reaches the model entirely — not trusted to a instruction telling it to hold back,
  which a model can be talked out of.
- **The latest-book rule for uncertain facts** (`cardsFor`'s tie-break). Two cards that
  match equally well sort toward the one from the latest book the visitor has reached, so
  "tell me about Rand" gives his present and the steps before it, not only the first
  book's farm boy.
- **The rumor deck replaces model calls** (`rumors.ts`). A deterministic pick from a
  hand-checked deck can't leak a spoiler the way a web-search-and-summarize job can — and
  costs nothing to run as many times as a test needs.
- **The reading gate holds everywhere, including matching** (`opensAt`, used by both
  `cardsFor` and `characterOfDay`). A fact from past a visitor's book never reaches a
  model's notes in the first place, so there's nothing for a model to be instructed not to
  say.

## Not included (see `docs/character-playbook.md` for why, and what to do instead)

- **Any AI/model call, ever.** This package is tested entirely without one.
- **Rumor corrections** ("setting the record straight" once enough visitors argue a
  record toward the truth) — a real Hinderstap mechanic, closely related to
  `challenge.ts`, but outside this package's requested scope. Straightforward to add
  following `challenge.ts`'s own pattern, if a world wants it.
- **Prompt assembly, caching, or any text post-processing** (face-tag parsing,
  stage-direction cleanup, dash-to-comma smoothing). Those are presentation-layer and
  model-wiring concerns that belong in your own app, not in a pure engine package.
- **The keeper test-kit scripts** (`dump`/`grade`/`talk`) themselves. The method is
  documented in `docs/character-playbook.md`; scaffolding the scripts into `create-app` is
  a follow-up, not done here.
