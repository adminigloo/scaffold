# @adminigloo/characters

## 0.2.0

### Minor Changes

- 6049eda: New package: the pure, model-free engine behind an AI character bound to a world, ported from building Hinderstap's keepers (the Wheel of Time's Tipsy Gelding, Dungeon Crawler Carl's Desperado Club) so the next world — a Name of the Wind or Dragonlance tavern, say — starts at the same polish.
  
  - `cardsFor` / `keyPattern` / `opensAt` / `mentionedCardIds` / `lintCards`: lore cards matched by possessive-tolerant keyword, gated by book, tie-broken toward the latest book a visitor has reached, validated before they're even wired into a test.
  - `hookFor` / `storyLeftHanging` / `storyAskedFor` / `storyHanging`: two-part story hooks — a cliffhanger on free talk, the true payoff after a purchase, never from a book past the visitor's own.
  - `endingFor` (`PAID_ENDING`): free talk's rotating tease, swapped for a thread offered freely the moment a visitor's tier goes above free — fixes the exact bug Hinderstap shipped, where a paying visitor was still told "not tonight."
  - `isChallenge` / `challengedRecord` / `challengedNote`: a visitor arguing with the day's talk gets handed a real rumor-deck record to stand on, hedge over or concede from, never a model inventing a source on the spot.
  - `relationshipFor` / `arrivalNote` / `formatReading`: greetings that know whether this is a first visit, a regular, or someone back after a long absence.
  - `characterOfDay`: one lore card per visitor per day, deterministic, gated, steered away from what they've already mentioned.
  - `recordsFor`: the day's rumor pick, a deterministic window over a hand-checked deck — no model call, so it can't repeat the mistake of a web-search job that once let a spoiler through.
  - `personaFor` / `checklistFor` / `primerFor`: a character's day/night persona split, with the same book gate applied to her dated world knowledge that `cardsFor` applies to a card.
  
  Also adds `docs/character-playbook.md`: the writing rules (worldview over adjectives, no example lines and why, nothing in threes, one stage direction, faces), the content pipeline (master list, batched card writers with a brief, a validator, a unit test holding every card to its gate), the latest-book rule, the two layers of truth and rumor, the paid-ending rule, and the no-API testing method (Claude Code subagents standing in for the live model, single-reply cases and whole scripted conversations, code grading before a Claude Code review, a live check only through the UI after the owner names a cost and a cap and says yes).
  
  Deliberately not ported in this first cut (see the package README): rumor corrections ("setting the record straight"), any prompt assembly or text post-processing, and the keeper test-kit scripts themselves — scaffolding those into `create-app` is a follow-up.
