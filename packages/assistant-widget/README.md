# @adminigloo/assistant-widget

The assistant's screens: a launcher on every page (a floating button and a slide-over chat, full screen on a phone), and the owner's settings. It talks to [`@adminigloo/assistant`](../assistant)'s company handler. React is its only peer; it carries its own styles and follows your page's light or dark theme.

## What each install gets you

| You install | You get |
| --- | --- |
| `@adminigloo/assistant-widget` | `AssistantLauncher` — the "Ask the assistant" button and the chat as a real dialog (focus moved in and kept there, Escape and the backdrop close it, focus goes back to the button; the page behind doesn't scroll; the conversation is kept while it's closed). `AssistantChat` — the chat on its own, for a page of its own: streamed answers with what it's looking up, **Stop**, starter questions (yours, then the business's own FAQ questions), history (your earlier conversations, to read or carry on), **safely rendered Markdown**, the **"ask before acting" card** ("Yes, do it" / "No", locked on the first click), and the month's allowance when it's used up. `renderMarkdown`, `safeLink`, the transport (`createAssistantTransport`) and the wire types. |
| `@adminigloo/assistant-widget/admin` | `AssistantSettings` — the owner's screen: about your business, answers to common questions (add, edit, remove), house rules, words you use, this month's AI use (questions and cents against the allowance, and when it starts again) and recent changes, in plain words. |
| `@adminigloo/assistant` | The handler these speak to. Required on your server; the widget never imports it. |

## Install

```bash
npm install @adminigloo/assistant-widget   # with @adminigloo/assistant on the server
```

(The `.npmrc` lines are the same as for [`@adminigloo/assistant`](../assistant#install).)

## Use

```tsx
import { AssistantLauncher } from "@adminigloo/assistant-widget";

<AssistantLauncher
  config={{
    baseUrl: `/api/app/${company.id}/assistant`,
    title: `${company.name}'s assistant`,
    settingsHref: "/app/assistant", // shown only to someone who may change the settings
  }}
/>;
```

```tsx
import { AssistantSettings } from "@adminigloo/assistant-widget/admin";

<AssistantSettings baseUrl={`/api/app/${company.id}/assistant`} />;
```

Both are client components (`"use client"` is on the bundle), so a server component can render them with plain props. 0.2's `config.chatUrl` / `config.confirmUrl` still work (no history or starters there).

## Ask before acting

A change the assistant offers is a card with **everything it will save, in full, as plain text** — "Yes, do it", **Change it** (edit any of it first) and "No". What is saved is what the person saw and confirmed. The buttons lock on the first click.

## Safe Markdown

Answers are rendered as the subset people see — paragraphs, headings, bullets, numbers, **bold**, *italic*, `code`, fenced code, and links — as React elements. **Never HTML**: `<script>` in an answer shows as text. A link is kept only to `http(s)`, `mailto:`, `tel:` or a path on your site; anything else (`javascript:`, `data:`) is shown as plain text, and links to other sites open in a new tab with no referrer. An answer the business saved (answered word for word, to everyone who asks) keeps only links to your own site's paths; any other address is shown as text.

## Theming

Light or dark is decided the way your page decided it (a `data-theme` on an ancestor, a `dark` class, `color-scheme`, the background it sits on, then the OS) and follows a theme switch live. `theme: "light" | "dark"` forces one. Every colour is a `--aia-*` custom property at zero specificity, so `.aia-root { --aia-accent: #7c3aed }` re-themes it; every text pair passes WCAG AA in both themes. On a phone (under 640 px) the chat is full screen and every control is at least 44 px tall.

## Upgrading from 0.2

Nothing to change: `AssistantChat` with `chatUrl`/`confirmUrl` behaves as before, with Markdown, Stop and the new card. To get history, starters and the allowance, mount `@adminigloo/assistant` 0.9's `createAssistantHandlers` and pass its mount as `config.baseUrl`; put `AssistantLauncher` where you want the button.

## Not included

- Voice, file uploads and images in the chat.
- A conversation shared between people: each person's conversations are their own.
- Editing the assistant's personality sections: that's the site's own editor (create-app's /admin/assistant); a company owner writes the profile, answers, rules and words.
