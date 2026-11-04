# @adminigloo/social

## 0.2.1

### Patch Changes

- 01b9f93: Social posts 0.2.1, from running 0.2.0 in a browser: a long tagged link no longer pushes the posts page sideways on a phone; the compose form's hashtag field says which platforms take them; a Bluesky draft's link card has a Copy link button; and a company's card is drawn in the company's name only, never one of the app's own characters. Projects made with `--social` get 0.2.1.

## 0.2.0

### Minor Changes

- 927fa93: Social posts 0.2, from Almanac's month of posting by hand: one card per post with a tab per platform and Approve all; posts that go stale (a `life` on the handler, an Expired section, the day kept as first built); hashtags on X (2), LinkedIn (5), Bluesky (3), Threads (1) and Facebook (2), given up one at a time before any fact; Bluesky's link as a link card; tagged links; the AI-smell check; six-candidate asides, fixed asides and banter; an opt-in strict approval. Projects made with `--social` get 0.2 (pin `social` in create-app's versions.ts to the released version). Breaking for 0.1 code: see the README's "New in 0.2". No migration.

## 0.1.0

### Minor Changes

- 42e3996: First release: social posts for each company, written by the app and posted by a person. One draft per platform in that platform's own format — X (280, links count 23, the link in the first comment, a 1:1 quote card), LinkedIn (the hook first, the link in the first comment, a 4:5 quote card), Instagram and Facebook (4:5 carousels; Instagram "Link in bio." and hashtags), TikTok (a 9:16 carousel inside its safe zone under a short caption), Threads, Bluesky, Telegram and Discord (1:1 cards), Reddit (a title line and a body, no image). Code writes every fact; the AI writes only the hook and a short sign-off ("aside" mode) or each platform's words ("words" mode), every number checked against the facts, every word against the generic honesty list (guarantees, hype, pressure, miracle claims) and the app's own rules, with the business's own words wherever a check fails. `createAnthropicComplete` (`./anthropic`): Claude Haiku 4.5 by default, one call per post, held and settled on the app's meter. The queue (`postStore(db, { tenantId })`) is one company's, every query filtered by `tenant_id`; `upsertDraft` never writes over a draft a person edited, approved, posted or skipped. `defineSocialTables({ prefix })` (default `social_posts`) and `sql/social-0.1.0.sql`. `createSocialAdminHandlers` and `SOCIAL_ADMIN_ROUTES` with `social.view` and `social.manage`: the queue, compose, approve, edit, mark posted, skip, the posting-session list and the card formats. `forgetTenant`. The screens (`./ui`: `PostsAdmin`, `PostQueue`, `PostCard`, `ComposeForm`, `CardFormats`) with their CSS on the app's tokens. The cards (`./cards`): quote cards and carousels from plain specs, HMAC-signed addresses that carry a company's own name and colour, text fitted from the fonts' own widths, `createCardRoute`; the fonts embedded (`./fonts`). Nothing in the package posts anything or calls any platform.
