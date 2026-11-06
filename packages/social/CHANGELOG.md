# @adminigloo/social

## 0.7.5

### Patch Changes

- 80298be: See every card format's videos start afresh in another look: a video made in one look no longer stays under another look's cards.
  
  - create-app pins social 0.7.5.

## 0.7.4

### Patch Changes

- 2b3df86: Each platform's panel starts afresh when its tab is chosen: a video made on one platform (TikTok's 9:16) no longer shows on the next (Instagram) as "Send video to Instagram", and neither do its shared pictures.
  
  - create-app pins social 0.7.4.

## 0.7.3

### Patch Changes

- 1186637: The look's switch is back as its own button beside the dropdown, as in 0.7 (0.7.2's single dropdown undone; its `toggle.label` is gone).
  
  - create-app pins social 0.7.3.

## 0.7.2

### Patch Changes

- 3d62199: The look is one dropdown: the backgrounds, then the entry that turns the switch on or off.
  
  - `<LookControls>` is a single dropdown: the options, and (under the switch's name) "Turn on confetti" / "Turn off confetti". The chosen option reads "Blue + confetti" when the switch is on (`toggle.label`, new and optional). There is no separate button.
  - create-app pins social 0.7.2.

## 0.7.1

### Patch Changes

- d492c64: The Look controls are switched off, saying where, on a post whose pictures this server can't redraw.
  
  - The handler's `canRestyle(images, { tenantId })`: false for pictures another server made. The queue marks each such row (`QueuePostView.canRestyle`), and the post's Background and confetti controls show switched off with "Its pictures were drawn by <site>, so its look can be changed there, not here." instead of offering a change and refusing it.
  - The refusal, when a redraw still can't happen, says why: the pictures were made somewhere else.
  - create-app pins social 0.7.1.

## 0.7.0

### Minor Changes

- 9762f4c: A look is two choices: a background and a switch over it (confetti); See every card format shows one look at a time.
  
  - `LookChoices` (`label`, `options`, `toggle?: { suffix, turnOn, turnOff }`) replaces 0.6's flat list from the handler's `looks()` and in `QueueWire.looks` (pass `{ label, options }` for 0.6's picker). A look's key is an option's, plus the toggle's suffix when it's on. `lookKeys`, `lookKey`, `lookParts`, `firstLook` (root).
  - `<LookControls>` (./ui): the dropdown and the switch's button, on each post and at the top of See every card format.
  - See every card format shows every format in the chosen look: `cardFormats(tenantId, { look })`, `GET v1/admin/card-formats?look=` (an unknown look is refused), `client.cardFormats(look)`, `sampleCardSets(brand, { look })`. It opens on the first option with the switch on.
  - create-app pins social 0.7.0.

## 0.6.0

### Minor Changes

- a3b23ec: Switch a post's look from the queue, and let a look's pieces rain.
  
  - The Look picker: the handler's `looks(tenantId)` (their keys and names) and `restyle(images, look, { tenantId })` (the app re-signs each card), `POST v1/admin/posts/{post}/look` (every platform of the post not posted or skipped; words and their edit stamp untouched), `QueueWire.looks`, `QueueActions.restyle`, `<PostQueue looks>`, and `lookOf(images)`. A handler given looks without restyle throws.
  - Rain: `enter: "rain"` with `fall`, `sway` and `spin` on a piece; the motion sheet carries them; `rainAt` and `RainClip` in `./video`; `MotionLayer.time`, the frame's own time in the clip. Rain falls on the clip's clock, outside the ground's push-in, and repeats a whole number of times in the clip.
  - Each platform with pictures says how to post something that moves: the video, in place of the picture.
  - create-app pins social 0.6.0.

## 0.5.0

### Minor Changes

- 018a674: Social cards wear looks and move in video; the posts screen's pictures open in a viewer.
  
  - Looks: `CardAssets.looks` by key, and a spec's signed `look`. A look's colours over the theme (and `theme.button` / `onButton` for the call), its pieces around the words per card size (`decor(frame)`: a picture, a ball with a face or a word, a bit of confetti), and a picture behind the small capitals (`eyebrow`). A company's card never wears the app's look; a look the app doesn't have draws the plain card. `LineBlock.measured` is a line's own width.
  - The card route's parts for a video, outside the signature: `&layer=ground`, `words`, `piece-N` and `motion` (the motion sheet, JSON). `cardLayerUrl`, `splitCardLayer`, `cardMotion`, `CardMotion` and `CardMotionPiece`.
  - Make a video on every platform with pictures, at their own size: `makeCardVideo` brings each piece on its own way (`enter`: pop, spray, fall, fade; `bob`; `stays`), the words on as each card crosses in (`words`: rise, slide, fade), the ground pushing in, and loops with no seam. Falls back to the slideshow for a card route without parts.
  - `<ImageViewer>`, `useImageViewer()` and `viewOnPlainClick()`: a picture opens in a pop-up, one at a time or side by side, in the queue and in See every card format.
  - `sampleCardSets(brand, { looks })` adds a set per look, and See every card format makes a video of each of its sizes.
  - create-app pins social 0.5.0.

## 0.4.0

### Minor Changes

- a2f40a9: Social cards take the brand's whole logo.
  
  - `brand.logo` (`{ src, width, height }`, any width: a wordmark or a lockup, as the brand's site and emails show it) is the cards' header: top left of every slide in place of the mark and the name, and on the brand's own quote card in place of the avatar and the name, with the handle under it. It keeps its shape at 88px tall and narrows to its room. The mark stays in the footers; a company's card and a quote card a named author posted never show it.
  - New exports: `cardLogo(spec, assets)`, `logoSize` and `LOGO`.
  - create-app pins social 0.4.0.

## 0.3.0

### Minor Changes

- 901aad6: Social posts 0.3.0: TikTok pictures or a video, one-command setup, any AI.
  
  - Send to TikTok (phone share sheet, the caption on the clipboard) and Download images on every card with pictures.
  - Make a video: a TikTok draft's slides as an MP4 made in the browser (H.264, 1080 x 1920, 30 fps, push-in, crossfades, a seamless loop), to send or download; the same clip is a Reel or a Short. `@adminigloo/social/video` for your own screens.
  - `npx adminigloo-social init`: finds the app's directory, Drizzle db, schema and AI library, writes the glue, routes and page, adds the table and a card key, never overwrites, and stays closed until the staff check is wired.
  - `@adminigloo/social/ai-sdk` (the Vercel AI SDK, any provider) and `openAIFetchClient` (OpenAI with no SDK) beside Claude, all metered the same way.
  - From Almanac: hashtags per platform, Bluesky link cards, hook-first opening lines, strict approval, posts that go stale and expire, tagged links and the AI-smell check.
  - create-app `--social`: tagged links, the AI-smell check and stale posts on by default; pins social 0.3.0.

## 0.2.3

### Patch Changes

- a81413e: Social posts 0.2.3: any AI provider. New `@adminigloo/social/openai` (`createOpenAIComplete`): the metered call for OpenAI, or any service that speaks its Chat Completions API (Azure OpenAI, OpenRouter, Groq, Together, a local server), with the same rules as Claude's: the worst case held before the call and settled at what the provider reported, Structured Outputs (strict), no retries, a refusal or a cut-off answer turned into the app's own words. The app names the model and its price; there's no SDK import (hand it `new OpenAI()` or any client with `chat.completions.create`). The meter's types and `worstCaseMicros` now live in a shared module, still exported from `./anthropic` as before. Projects made with `--social` get 0.2.3.

## 0.2.2

### Patch Changes

- 4ffcfed: Social posts 0.2.2, from running 0.2.1 with the real model (Claude Haiku 4.5) and in dark mode. A typed post no longer says its first fact twice where a platform opens with the hook (LinkedIn, Facebook, Instagram, TikTok): it opens with the person's own first sentence and goes on with the rest (`PostSource.openingLine`), and Reddit's title is that sentence whole. Dark mode: native scrollbars and controls follow it (`color-scheme`), a plain link is the accent rather than the browser's blue, and the posts page paints its own ground so its titles read on any host. The AI-smell check refuses "has a way of". Projects made with `--social` get 0.2.2.

## 0.2.1

### Patch Changes

- 01b9f93: Social posts 0.2.1, from running 0.2.0 in a browser: a long tagged link no longer pushes the posts page sideways on a phone; the compose form's hashtag field says which platforms take them; a Bluesky draft's link card has a Copy link button; and a company's card is drawn in the company's name only, never one of the app's own characters. Projects made with `--social` get 0.2.1.

## 0.2.0

### Minor Changes

- 927fa93: Social posts 0.2, from Almanac's month of posting by hand: one card per post with a tab per platform and Approve all; posts that go stale (a `life` on the handler, an Expired section, the day kept as first built); hashtags on X (2), LinkedIn (5), Bluesky (3), Threads (1) and Facebook (2), given up one at a time before any fact; Bluesky's link as a link card; tagged links; the AI-smell check; six-candidate asides, fixed asides and banter; an opt-in strict approval. Projects made with `--social` get 0.2 (pin `social` in create-app's versions.ts to the released version). Breaking for 0.1 code: see the README's "New in 0.2". No migration.

## 0.1.0

### Minor Changes

- 42e3996: First release: social posts for each company, written by the app and posted by a person. One draft per platform in that platform's own format — X (280, links count 23, the link in the first comment, a 1:1 quote card), LinkedIn (the hook first, the link in the first comment, a 4:5 quote card), Instagram and Facebook (4:5 carousels; Instagram "Link in bio." and hashtags), TikTok (a 9:16 carousel inside its safe zone under a short caption), Threads, Bluesky, Telegram and Discord (1:1 cards), Reddit (a title line and a body, no image). Code writes every fact; the AI writes only the hook and a short sign-off ("aside" mode) or each platform's words ("words" mode), every number checked against the facts, every word against the generic honesty list (guarantees, hype, pressure, miracle claims) and the app's own rules, with the business's own words wherever a check fails. `createAnthropicComplete` (`./anthropic`): Claude Haiku 4.5 by default, one call per post, held and settled on the app's meter. The queue (`postStore(db, { tenantId })`) is one company's, every query filtered by `tenant_id`; `upsertDraft` never writes over a draft a person edited, approved, posted or skipped. `defineSocialTables({ prefix })` (default `social_posts`) and `sql/social-0.1.0.sql`. `createSocialAdminHandlers` and `SOCIAL_ADMIN_ROUTES` with `social.view` and `social.manage`: the queue, compose, approve, edit, mark posted, skip, the posting-session list and the card formats. `forgetTenant`. The screens (`./ui`: `PostsAdmin`, `PostQueue`, `PostCard`, `ComposeForm`, `CardFormats`) with their CSS on the app's tokens. The cards (`./cards`): quote cards and carousels from plain specs, HMAC-signed addresses that carry a company's own name and colour, text fitted from the fonts' own widths, `createCardRoute`; the fonts embedded (`./fonts`). Nothing in the package posts anything or calls any platform.
