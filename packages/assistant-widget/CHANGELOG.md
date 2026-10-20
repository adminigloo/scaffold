# @adminigloo/assistant-widget

## 0.3.1

### Patch Changes

- 3c427cc: Dates read in en-US, never in the browser's locale.

## 0.3.0

### Minor Changes

- b525490: The assistant's screens (0.3.0).
  
  - **`AssistantLauncher`** (new): a floating "Ask the assistant" button that opens the chat as a slide-over panel — full screen under 640 px — as a real dialog: labelled, focus moved in and trapped (Tab and Shift+Tab cycle), Escape or the scrim closes it, focus returns to the button, the page behind doesn't scroll. The conversation is kept while it's closed.
  - **`AssistantChat`** speaks the company handler (`config.baseUrl`, e.g. `/api/app/${company.id}/assistant`): starter questions (the site's, then the business's own FAQ questions, answered without AI), streamed answers with tool activity, **Stop**, history (your own earlier conversations, to read or carry on), **safely rendered Markdown** (bold, lists, code, links to http(s)/mail/phone/this site only — never HTML), and the **"ask before acting" card**: "Yes, do it" / "No", locked on the first click, with the server's sentence after. When the month's allowance is used up it says so in the server's words (FAQ answers still work); a refusal shows its own sentence, never a raw error. 0.2's `chatUrl`/`confirmUrl` still work.
  - After an independent review: the card shows **exactly what will be saved, in full, as plain text**, with **Change it** to edit before "Yes, do it" (the edits are what's saved); an answer the business saved is shown with its links as plain text (only this site's paths stay links); an answer that broke off says "This answer was cut short"; when the month is used up only the business's own answers are offered as starters; a closed plan or a suspended company is said the moment the chat opens.
  - **`./admin`** (new): `AssistantSettings` — the owner's screen: about your business, answers to common questions, house rules, words you use, this month's AI use (figures from the server) and recent changes.
  - Follows the host page's light or dark theme (`resolveHostTheme`, the notifications widget's rules), WCAG AA pairs in both, 44 px controls on a phone, nothing sideways at 360 px. The wire types are a byte-for-byte copy of @adminigloo/assistant's (`ChatMessageWire`, `ActionWire`, `AssistantStatusWire`, `AssistantSettingsWire`, …), checked by a parity test.

### Patch Changes

- Updated dependencies [b525490]
  - @adminigloo/assistant@0.9.0
