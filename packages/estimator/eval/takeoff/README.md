# The photo-reading eval

How well does the model count the steps in a customer's photo, and what does
each reading cost? This folder answers both with the package's own code: the
same shrunk photo, the same prompt, the same strict schema and the same
normalizer the estimator uses in production.

It is **not** part of `pnpm test` and never runs on its own, because it calls
the Anthropic API and spends money: about **$0.001 a photo** on Claude Haiku
4.5 ($1 / $5 per million tokens). The bundled synthetic diagrams cost well
under a cent together. Nothing in the test suite imports it, and it isn't
published (`files` in package.json leaves `eval/` out).

## What it measures

For each photo in `fixtures.json`:

- **The count**: did the model count the risers exactly? ("2 steps and a deck"
  is 3 risers: the founder's own porch.) A level entry should come back
  `seen: false`.
- **The height**: does the model's range for one riser overlap the expected
  range? Diagrams have no scale, so their height isn't scored.
- **The spend**: input and output tokens and the cost of every call, then the
  average per photo and the total.

The model never measures anything here, just as in production: it reports
what it sees, and the package's code does the arithmetic.

## Run it

```bash
pnpm --filter @adminigloo/estimator build                 # the eval uses dist/
node eval/takeoff/make-synthetic.mjs                       # (re)draws the 4 diagrams; free
node eval/takeoff/run.mjs                                  # shows what it would send and cost; sends nothing
ANTHROPIC_API_KEY=… node eval/takeoff/run.mjs --yes        # runs it
```

Options: `--model claude-haiku-4-5` (the default), `--only porch` (a part of a
file name or note), `--rates 1000000,5000000` (micro-dollars per million input
and output tokens, for a model the package has no price for).

Photos are shrunk exactly as the widget shrinks them (≤ 768 px on the long
edge, JPEG at 0.8) through `sharp`, a dev dependency of this package. Without
it the run **refuses**: a 12 MP phone photo sent whole is 2–3 times the tokens
at a different resolution, so the accuracy and the cost per photo it reported
would not be production's. `--full-size` sends the originals anyway, on
purpose. Before anything is sent the run says how many REAL photos it found
("0 real photos found: … add your porch photos at …"): the bundled diagrams
test the prompt, not the model's eye on a porch. Each run is saved to
`results/<timestamp>.json` (not committed).

## Add your own photos

Real photos are not committed. To include one, save it at the path
`fixtures.json` names (for example `photos/porch-2-steps-plus-deck.jpg`), or
add an entry:

```json
{ "file": "photos/back-door.jpg", "recipe": "ramp_over_steps", "subject": "the steps up to the door",
  "expect": { "risers": 4, "riserHeightIn": [6.5, 8] }, "note": "back door, 4 steps" }
```

A photo listed but not on disk is skipped with a line saying so. Use the
`expect.riserHeightIn` range a tape measure gave you; leave it `null` when you
don't know.
