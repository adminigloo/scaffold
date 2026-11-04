# @adminigloo/social

Social posts for each company, written by the app and posted by a person.

A business types what's true ("We're open on Saturdays now, 9 to 1") or the
app works out a fact it already knows (a release, a number). The package turns
it into **one draft per platform, each in that platform's own format**, with
its images, and puts the drafts in a queue. A person edits and approves them,
then **posts them by hand** (or an agent in their browser does, from the
posting-session list) and marks each one posted with its link.

- **Code writes every fact.** The AI writes only the words around them: the
  line on the image and a short sign-off in the business's voice ("aside"
  mode), or each platform's words ("words" mode). Every number the AI writes
  must already be in the facts (the number guard: `70%`, `$45` and `17 of 24`
  are fine; `$15` worked out from them is refused). Links, hashtags and
  @-mentions are code's, never the AI's.
- **Honest by default.** The AI is told never to promise, predict or claim more
  than the facts say, and code checks every word it writes against a generic
  list (guarantees, hype, pressure to buy, miracle claims) plus the app's own
  rules. Any part that fails goes out in the business's own words, with the
  reason on the draft's card.
- **Cheap and metered.** One call per post, Claude Haiku 4.5 by default, about
  a third of a cent at worst, held against the company's AI allowance before
  it's asked and settled at what the provider reported.
- **Each platform's format** (the founder's list, Oct 2026; hashtags and Bluesky's link card, Nov 2026):

  | Platform | Text | Link | Hashtags | Image |
  | --- | --- | --- | --- | --- |
  | X | punchy, 280 (links count 23) | in the first comment | 2 | 1:1 quote card |
  | LinkedIn | the hook first, short paragraphs | in the first comment | 5 | 4:5 quote card |
  | Bluesky | a few short lines, 300 | a link card (not in the 300) | 3 | 1:1 quote card |
  | Threads | a few short lines | in the text | 1 | 1:1 quote card |
  | Facebook | the hook first, a few lines | in the text | 2 | 4:5 carousel |
  | Instagram | the hook first, a caption | "Link in bio." | 5 | 4:5 carousel |
  | TikTok | a short caption (hook, sign-off, hashtags) | "Link in bio." | 5 | 9:16 carousel, inside TikTok's safe zone |
  | Telegram, Discord | a few short lines | in the text | none | 1:1 quote card |
  | Reddit | a plain title line, then the body | in the text | none | none |

  The hashtags are the post's own, the first few in order. Where a text runs
  long they go one at a time, after the sign-off and before any fact.

- **Per company.** Every draft belongs to one company (`tenant_id`), and every
  read and write is inside it: one company never sees, approves or forgets
  another's posts, even under the same key. `"*"` is the site's own posts.

## New in 0.2 (from Almanac's month of posting by hand)

- **One card per post**, a tab per platform, and "Approve all" on each post
  (a card per platform read as the same post over and over). `<PostQueue>`
  groups the rows itself (`groupPosts`).
- **Posts go stale.** Give the handler a `life` (a `PostLife`: how long each
  kind is worth posting) and a stale draft reads expired on the spot: it
  can't be approved, it leaves the posting list, and the page shows it under
  Expired. A rebuild keeps the day a draft was first built, so Build now on a
  later day can't stretch its life.
- **Hashtags on X, LinkedIn, Bluesky, Threads and Facebook** (the table above).
- **Bluesky's link is a link card.** Its 300 counted the whole address, so a
  tagged link crowded out the facts. The draft keeps its link (`linkUrl`):
  paste it in Bluesky's composer, wait for the card, delete the address.
- **Tagged links** (`tagLinks: true`): each draft's link carries the platform,
  "social", the post's kind and its key, so the site's visit numbers say
  which post brought each visit.
- **The AI-smell check** (`smell`): the patterns that give a line away as a
  model's (dashes, "it's not X, it's Y", lists of three, invented names).
  Pass your own names (`{ names: [...APPROVED_NAMES, "Lou"] }`).
- **Asides that sound like a person**: in "aside" mode the AI writes six
  candidates and code keeps the least likely one that passes every check;
  an author's fixed lines (`fallbackAsides`) go in wherever none does; a
  post can carry banter between characters.
- **Strict approval, if you want it** (`approval: "strict"` on the store or
  the handler): only an approved post can be marked posted, and editing an
  approved post sends it back to draft. The default stays open.
- **Breaking, for code on 0.1:** `<PostQueue>` lost `filter` and
  `approveAllLabel`; `<PostCard>` takes a post group and a `kindLabel`;
  `PlatformRule.hashtags` is a number; the AI's answer in "aside" mode is
  `{ "hook", "asides": [{ "text", "probability" }] }`; `QueueWire.sections`
  gains `expired`. The table is unchanged: no migration.

## What you install, and what you get

| Install | You get |
| --- | --- |
| `pnpm add @adminigloo/social` | Everything below, in one package. |
| … `@adminigloo/social` (the root) | Each platform's format and limits, the number guard, the writer (`writePost`), the AI-smell check (`smell`), tagged links (`taggedLink`), what goes stale (`effectiveStatus`, `asOf`), the queue in sections (`queueSectionsOf`), one view a post (`groupPosts`), the generic honesty list, the launch and release sources, the view, `SOCIAL_ADMIN_ROUTES` and the permission keys. Pure: safe anywhere, a browser included. |
| … `@adminigloo/social/schema` | The table (`social_posts`, or your own prefix with `defineSocialTables({ prefix })`). |
| … `@adminigloo/social/server` | The queue (`postStore(db, { tenantId })`), the HTTP handler the screens talk to (`createSocialAdminHandlers`), and `forgetTenant`. |
| … `@adminigloo/social/ui` | The screens: `<PostsAdmin>` (the whole page), `<PostQueue>`, `<PostCard>`, `<ComposeForm>`, `<CardFormats>`. Their CSS comes with them. |
| … `@adminigloo/social/cards` | The card images: quote cards and carousels from plain specs, signed addresses, the layout that never lets words run off, and `createCardRoute` for the image route. |
| … `@adminigloo/social/fonts` | The cards' fonts, embedded (DM Serif Display and Inter): no file to trace, for the card route alone. |
| … `@adminigloo/social/anthropic` | The metered Claude call (`createAnthropicComplete`). Needs `pnpm add @anthropic-ai/sdk`. |
| `sql/social-0.1.0.sql` | The table's DDL, for a host without drizzle-kit. |
| `pnpm add next` (yours already) | `next/og`'s `ImageResponse` paints the cards. Any painter of the same shape works. |

A project made with `create-app --social` has all of it wired: the page, the
routes, the card route, the metering, the migration and the nav entry.

## Not included

- **No posting.** Nothing in this package posts anything, to any platform,
  ever. A person posts each approved draft by hand (Copy text, Open X, attach
  the images) and pastes its link.
- **No platform APIs.** No X, LinkedIn, Meta, TikTok, Reddit or Bluesky API
  calls, no app reviews, no OAuth tokens to keep.
- **No scheduling to post at a time.** A draft has the day it's meant for;
  nothing goes out by itself at an hour.
- **No analytics from the platforms.** No likes, views or followers are read
  back. (A post's own link is kept, so you can open it.)
- **No image uploads.** The cards are drawn from words; a business's own photos
  aren't attached by the package.
- **No hashtag or trend research**, and the AI never picks hashtags: a person
  types them, or the app's code passes them.

## Plugging it into an app

1. **The table.** `export * from "@adminigloo/social/schema"` in your drizzle
   schema (or `export const posts = defineSocialTables({ prefix: "myapp_social_" }).posts`
   when `social_posts` is taken), then generate your migration. Without
   drizzle-kit, run `sql/social-0.1.0.sql`.
2. **The queue.** `const queue = postStore(db, { tenantId })` on any drizzle
   Postgres handle: one company's queue. There is no queue across companies.
3. **The AI.** `complete` is your model call: `({ system, prompt, maxTokens, schema }) => text`,
   throwing when it fails. With Claude:

   ```ts
   import Anthropic from "@anthropic-ai/sdk";
   import { createAnthropicComplete } from "@adminigloo/social/anthropic";
   const complete = createAnthropicComplete({ client: new Anthropic(), rate: MODEL_RATES["claude-haiku-4-5"], spend, tenantId, userId });
   ```

   `spend` is your meter: `reserve` holds the call's worst case (refuse with a
   sentence and the model is never asked), `settle` records what the provider
   reported. create-app wires @adminigloo/ai's `reserveAiAllowance` and
   `settleAiReservation` here, against each company's month. Pass
   `complete: null` where there's no AI: every draft is then your own words.
4. **The honesty check.** `honesty: genericHonesty`, or your own on top:
   `combineHonesty(genericHonesty, honestyFrom([[/\bfree\b/i, "a promise of something free"]]))`.
   A source's own `check` adds a rule for that post.
5. **The handler.** Mount `createSocialAdminHandlers` at a route of yours:

   ```ts
   const { handle } = createSocialAdminHandlers({
     db,
     resolveTenant: (req) => companyIdFromPath(req), // or tenantId: "*"
     authorize: (req, permission, tenantId) => can(req, permission, tenantId), // social.view / social.manage
     compose: (input) => launchSource({ ...input, author: company.name, voice, link: input.link ?? companyPage, images }),
     writer: ({ tenantId, userId }) => ({ complete: completeFor(tenantId, userId), honesty: genericHonesty, mode: "aside" }),
     cardFormats: (tenantId) => cardFormatSets(sampleCardSets(brandOf(tenantId)), sign),
     today: (tenantId, now) => dayIn(company.timeZone, now),
   });
   export const GET = handle;
   export const POST = handle;
   ```

   Its routes (`SOCIAL_ADMIN_ROUTES`): the queue, compose, approve, edit,
   mark posted, skip, the posting-session list and the card formats. Each asks
   `authorize` for its one key; a post named in the path is read inside the
   company the request resolved to, so another company's is "not found". POSTs
   from another site are refused.
6. **The screen.** `<PostsAdmin baseUrl="/api/app/{company id}/posts" canManage />`:
   today's posts with Approve all, drafts waiting from earlier days, what's
   ready to post (with the posting session's list as JSON), a post from your
   own facts, the history, and "See every card format". It reads the app's
   colour tokens (`--color-ink`, `--color-accent`, …); set `--social-*` on a
   wrapper to use others.
7. **The cards.** Sign each card's address when a draft is written (`cardImage(spec, { base, secret, byline })`)
   and serve them from one public route:

   ```tsx
   import { ImageResponse } from "next/og";
   import { createCardRoute } from "@adminigloo/social/cards";
   import { cardFonts, CARD_SANS, CARD_SERIF } from "@adminigloo/social/fonts";
   export const GET = createCardRoute({ secret: () => CARD_SECRET, assets: () => ({ fonts: cardFonts(), serif: CARD_SERIF, sans: CARD_SANS, theme, author, brand }), paint: ImageResponse });
   ```

   A query whose signature doesn't match its words is a 403: nobody can make a
   card say something the business didn't. A company's card carries its own
   name, address and colour in its signed address (`cardBrand({ name, site, accent })`),
   so it's drawn in that company's name, never the site's.

## Your own posts

A `PostSource` is one thing worth saying: a `key` (unique per company:
`"report:2026-10"`), the `facts` (a title and lines holding every number the AI
may use), the `author` and its `voice` (null: your words go out as they are),
your `hook`, the `linkUrl` and `linkLabel`, the `hashtags`, `template(platform)`
(your own words for each platform, longest version first) and
`images(platform, hook)`. Then:

```ts
if (!(await queue.keysWithPosts([source.key])).size)
  for (const d of await writePost(source, { complete, honesty, mode: "aside" }))
    await queue.upsertDraft({ ...d, key: source.key, kind: source.kind, author: source.author, day: source.day, linkUrl: source.linkUrl, facts: source.facts });
```

Checking the key first means a rerun costs no AI call; `upsertDraft` never
writes over a draft a person edited, approved, posted or skipped.
`launchSource` (an announcement a person typed) and `releaseSource` (a release
from your changelog: its version, title and items) are ready-made.
