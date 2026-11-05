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

## New in 0.6: switch a post's look, and rain

- **The Look picker.** Give the handler your looks and a way to redraw a
  post's pictures in one (`looks: () => [{ key, name }]` and
  `restyle(images, look)`, which re-signs each of your cards with the look),
  and each post on the queue gets a **Look** select under its pictures. One
  choice redraws every platform's pictures that hasn't been posted or skipped
  (`POST v1/admin/posts/{post}/look`); what went out keeps its pictures, and
  what a person has typed isn't touched. A post made before your looks shows
  "Plain". `QueueWire.looks` carries the list; `lookOf(images)` reads a post's.
- **Rain.** `enter: "rain"` falls a piece through the card the whole clip
  long, behind the words, from where the card has it (the first frame is the
  card as posted), wrapping back in at the top: `fall` (seconds to cross the
  card), `sway` (px) and `spin` (degrees a second; none, and it wobbles, as a
  ball with a word on it should). Each repeats a whole number of times in the
  clip, so the loop has no seam, and every card of a video draws it on the
  clip's own clock, so a cross never doubles it. `rainAt` in `./video`.
- **A post that moves.** Each platform with pictures says so on its panel:
  Make a video, then upload the video in place of the picture. A pasted or
  uploaded picture stays still.

## New in 0.5: looks, cards that move, and a viewer

- **Looks.** Give the card route your own looks (`assets.looks`, by key) and
  a post's cards can wear one (`look` in the spec, signed with the words): its
  colours over your theme, and the pieces around its words. A piece is a
  picture (`kind: "art"`, a spray of paint, say, tinted before you hand it
  over), a ball (`kind: "ball"`, a disc in a colour with a picture or a short
  word on it), or a bit of confetti (`kind: "bit"`: a card, a strip or a dot),
  laid out per card size by your `decor(frame)`, clear of the words. A look
  can put a picture behind the small capitals (`eyebrow`, a brush stroke
  stretched to fit them) and give the call its own button colour
  (`theme.button`, `theme.onButton`). A company's card never wears the app's
  look, and a look you retire draws the plain card, so old posts still work.
- **Cards that move.** **Make a video** is on every platform with pictures,
  at the pictures' own size (TikTok's 9:16, Instagram's and Facebook's 4:5,
  X's 1:1). The card route draws each card's parts for it (`&layer=ground`,
  `words`, `piece-N`, and `motion`, the motion sheet, outside the signature:
  a part only ever draws less of the signed card), and the video moves them:
  each piece comes on its own way and in turn (`enter`: a ball pops up and
  settles, paint sprays out from its nozzle, confetti falls in spinning, or a
  fade), a ball bobs once it's on (`bob`), paint sprays once and stays
  (`stays`), the ground pushes in slowly while the words hold still, and a
  later card's words come on as it crosses in (`words`: up from below, in from
  the left, or a fade). The first card's words are whole at the first frame,
  and the clip loops with no seam. `makeCardVideo` in `@adminigloo/social/video`.
- **A viewer.** A picture on the posts screen (and in **See every card
  format**) opens in a pop-up, one at a time with arrows and the ← → keys, or
  side by side; Esc, ✕ or the backdrop closes it; Ctrl- or Cmd-click still
  opens the image itself. `<ImageViewer>` and `useImageViewer()` in `./ui`.
- **The samples show your looks.** `sampleCardSets(undefined, { looks })`
  adds a set per look, with a video for each of its sizes.

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

## Set it up in your app: one command

In a Next.js app on Drizzle and Postgres (a project made with `create-app
--social` has all of this already):

```sh
npm install @adminigloo/social
npx adminigloo-social init          # --dry-run to see first; --ai to choose the AI
```

It finds your app directory, your Drizzle `db`, your schema and the AI library
you already use (OpenAI, the Vercel AI SDK, Claude, or none), and writes:

| File | What it is |
| --- | --- |
| `lib/social-posts.ts` | The glue: the handler, the cards, the AI, the rules. Three spots marked WIRE. |
| `app/api/admin/posts/[...path]/route.ts` | The posts screen's server route |
| `app/api/social/card/route.tsx` | The card images: public, so a platform can fetch them, and signed |
| `app/admin/posts/page.tsx` | The posts screen |
| one line in your Drizzle schema | The posts table, for `drizzle-kit generate` |
| `SOCIAL_CARD_SECRET` in `.env.local` | The key the card addresses are signed with (never printed) |

It never overwrites a file you have, and the screen stays **closed to everyone
until you wire your staff check** into `authorize` (WIRE 1). Then generate and
apply the migration your usual way, add `SOCIAL_CARD_SECRET` to your host,
and link the screen from your admin menu.

## TikTok, Reels and Shorts: pictures or a video

A TikTok draft comes with 9:16 slides inside TikTok's safe zone and a short
caption with its hashtags. From the posts screen:

- **Send to TikTok** (on a phone): the slides go to the share sheet in order
  and the caption goes on the clipboard; TikTok opens them as a slideshow.
  Where TikTok isn't in the list (some iPhones), save them to Photos and pick
  them in TikTok. Pick a sound, paste the caption, post. A phone that can't
  take the files (Android shares at most 10, 50 MB each) gets Download only.
- **Make a video**: the slides become an MP4 made in the browser (H.264,
  1080 × 1920, 30 fps, about 2.5 seconds a slide with a slow push-in,
  crossfades, the last slide held longer and a seamless loop), with no
  sound track: pick a TikTok sound, which reaches further than any file's.
  **Send video to TikTok** on a phone, **Download video** anywhere. The same
  clip works as an Instagram Reel or a YouTube Short, with no other app's
  watermark on it. On TikTok, video posts get more engagement than photo posts
  (3.39% against 1.92% median, Buffer's study of 45M posts, March 2026).
- **Download images** on a computer, for any platform's own upload page.
- Since 0.5 **Make a video** is on every platform with pictures, at the
  pictures' own size, and each card's parts move (see New in 0.5). A card
  route from before 0.5 has no parts to give, and the clip is the slideshow.
- `@adminigloo/social/video` (`makeCardVideo`, or `makeSlideshowVideo` for
  plain pictures) makes the clip for your own screens. It needs a browser with WebCodecs (Chrome, Edge, Safari 16.4+,
  Firefox 130+); where there's none, the button doesn't show. Keep `fps` at 23
  or more: TikTok and Instagram refuse slower video.

Not in 0.3: posting straight into a TikTok inbox. TikTok's Content Posting API
takes a reviewed TikTok developer app, each owner's sign-in, and JPEG (not PNG)
photos pulled from a verified domain.

## Any AI provider

The writer never calls a provider itself: it calls the `complete` function
you hand it, `({ system, prompt, maxTokens, schema }) => Promise<string>`.
Two come ready-made, each metered the same way (every call's worst case held
on your ledger before it's asked, then settled at what the provider reported):

```ts
// Claude (Haiku 4.5 by default)
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicComplete } from "@adminigloo/social/anthropic";
const complete = createAnthropicComplete({ client: new Anthropic(), rate, spend, tenantId, userId });

// OpenAI, or any Chat Completions service: you name the model and its price.
// No SDK needed: openAIFetchClient is plain fetch (or pass your own new OpenAI()).
import { createOpenAIComplete, openAIFetchClient } from "@adminigloo/social/openai";
const complete = createOpenAIComplete({ client: openAIFetchClient({ apiKey }), model: "<your model>", rate, spend, tenantId, userId });

// The Vercel AI SDK: any provider it has a model for
import { generateText } from "ai";
import { createAiSdkComplete } from "@adminigloo/social/ai-sdk";
const complete = createAiSdkComplete({ generateText, model: yourModel, rate, spend, tenantId, userId });
```

A reasoning model (OpenAI's gpt-5 family) thinks out of the same small bound
as its answer: pass `reasoningTokens` (room for its thinking, held too) and
keep its effort low.

Anything else (the Vercel AI SDK, a gateway, your own model) is a function of
that same shape. `null` means no AI: every post is your own words.

## What you install, and what you get

| Install | You get |
| --- | --- |
| `pnpm add @adminigloo/social` | Everything below, in one package. |
| … `@adminigloo/social` (the root) | Each platform's format and limits, the number guard, the writer (`writePost`), the AI-smell check (`smell`), tagged links (`taggedLink`), what goes stale (`effectiveStatus`, `asOf`), the queue in sections (`queueSectionsOf`), one view a post (`groupPosts`), the generic honesty list, the launch and release sources, the view, `SOCIAL_ADMIN_ROUTES` and the permission keys. Pure: safe anywhere, a browser included. |
| … `@adminigloo/social/schema` | The table (`social_posts`, or your own prefix with `defineSocialTables({ prefix })`). |
| … `@adminigloo/social/server` | The queue (`postStore(db, { tenantId })`), the HTTP handler the screens talk to (`createSocialAdminHandlers`), and `forgetTenant`. |
| … `@adminigloo/social/ui` | The screens: `<PostsAdmin>` (the whole page), `<PostQueue>`, `<PostCard>`, `<ComposeForm>`, `<CardFormats>`, `<MakeVideo>`, and the pictures' pop-up `<ImageViewer>` (0.5). Their CSS comes with them. |
| … `@adminigloo/social/cards` | The card images: quote cards and carousels from plain specs, signed addresses, the layout that never lets words run off, the looks (0.5), and `createCardRoute` for the image route and the parts a video moves. |
| … `@adminigloo/social/video` | The clip made in the browser: `makeCardVideo` (each card's parts moving, at the cards' size, 0.5) and `makeSlideshowVideo`. |
| … `@adminigloo/social/fonts` | The cards' fonts, embedded (DM Serif Display and Inter): no file to trace, for the card route alone. |
| … `@adminigloo/social/anthropic` | The metered Claude call (`createAnthropicComplete`). Needs `pnpm add @anthropic-ai/sdk`. |
| … `@adminigloo/social/openai` | The metered OpenAI call (`createOpenAIComplete`), or any service that speaks OpenAI's Chat Completions API (Azure OpenAI, OpenRouter, Groq, Together, a local server). No SDK needed: your `new OpenAI()`, or `openAIFetchClient({ apiKey })` over plain fetch. |
| … `@adminigloo/social/ai-sdk` | The metered call through the Vercel AI SDK (`createAiSdkComplete`): any provider it has a model for. Hand it your `generateText` and model. |
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

   `brand.mark` is a square tile (the first letter on the accent when left out). Give
   `brand.logo` your whole logo, as your site and emails show it (`{ src, width, height }`,
   any width), and it becomes the header: top left of every slide in place of the mark and
   the name, and on your own quote card in place of the avatar and the name, the handle under
   it. The mark stays in the footers; a company's card never shows your logo.

   Looks (0.5) go in the same assets, by key, and a spec names one:

   ```ts
   const looks = {
     confetti: {
       decor: ({ width }) => [
         { kind: "ball", color: "#59bc6c", size: 124, x: width - 50, y: 44, label: "GO", ink: "#fff", enter: "pop", delay: 0.1, bob: true },
         { kind: "bit", shape: "strip", color: "#f1a834", size: 40, x: 760, y: 40, rotate: -35, enter: "fall", delay: 0.3 },
       ],
       words: "rise",
     },
   };
   const assets = { ...yourAssets, looks };
   const image = cardImage({ ...quoteCard(hook, "square"), look: "confetti" }, signing);
   ```

   Keep each size's pieces clear of the words: the corners, the bands outside
   `SAFE_AREA`. A picture is drawn as it comes (satori can't size a mask), so
   hand it over in its colour.

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
