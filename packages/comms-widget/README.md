# @adminigloo/comms-widget

The Messages screen for AdminIgloo comms: the emails (and texts) a business
sends, read and edited in plain words, who they went to and what happened, and
a "Send due messages now" button.

```
<MessagesConsole baseUrl="/api/app/{company id}/messages" />    what's set up, the templates, the log   (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no CSS
import) and follows the host page's light or dark theme.

It talks to `@adminigloo/comms` 0.3's `createCommsAdminHandlers` over a small
JSON contract. The contract's types are declared in this package; it does
**not** depend on the server package.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/comms-widget/admin` | `<MessagesConsole>`: who customers see the emails from and where their replies go, a plain warning when emails aren't going out or messages are running late, every template grouped by feature with its wording, an editor (subject and body, listing the `{{placeholders}}` filled in for you), an on/off switch per template, the recent-messages log with who each went to and what happened, and "Send due messages now". | One staff page that renders it, and `createCommsAdminHandlers` mounted behind your sign-in. |
| `@adminigloo/comms-widget` | The client (`createCommsClient`) and the wire types, for a host building its own screen. | Your screen. |

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

and your token to your **user-level** `~/.npmrc`, never the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

Then:

```sh
npm install @adminigloo/comms-widget     # pnpm add / yarn add work the same
```

## Quick start: a Next.js app

Mount the handlers (see `@adminigloo/comms`'s README, "Companies"):

```ts
// app/api/app/[tenantId]/messages/[...path]/route.ts
import { createCommsAdminHandlers } from "@adminigloo/comms";
import { createCompanyRouteSeams } from "@adminigloo/tenancy/server";

const seams = createCompanyRouteSeams({ tenancy, principal: (req) => getSignedInUser(req) });
const { handle } = createCommsAdminHandlers({ db, senders, resolveTenant: seams.resolveTenant, authorize: seams.authorize });
export { handle as GET, handle as POST };
```

and render the screen on a staff page:

```tsx
// app/app/messages/page.tsx
import { MessagesConsole } from "@adminigloo/comms-widget/admin";

export default async function Page() {
  const { company, can } = await requireCompany("comms.view");      // your page gate
  return <MessagesConsole baseUrl={`/api/app/${company.id}/messages`} canManage={can.includes("comms.manage")} />;
}
```

A single-business project mounts the same handlers at one route with a fixed
`tenantId` and passes that route as `baseUrl`.

## `<MessagesConsole>` props

| Prop | Default | What it does |
| --- | --- | --- |
| `baseUrl` | | Where `createCommsAdminHandlers` is mounted. |
| `transport` | | Your own transport (wins over `baseUrl`). |
| `canManage` | `true` | Shows Edit, the on/off switches and "Send due messages now". The server still refuses a viewer; this only avoids offering what they can't do. |
| `locale` | the viewer's | Date formats in the log. |
| `theme` | `"auto"` | `"light"` / `"dark"` pin it. |
| `nonce` | | A CSP nonce for the injected `<style>`. |
| `className`, `style` | | On the root. |

## Theme

`"auto"` follows the host page (a `data-theme` or `dark` class on a parent,
`<body>` or `<html>`, then the background it sits on, then the system), and
follows changes live. Every colour is a custom property on `.aicw-root`,
declared at zero specificity, so one ordinary rule re-themes it:

```css
.aicw-root {
  --aicw-accent: #7c3aed;
  --aicw-accent-strong: #6d28d9;
  --aicw-on-accent: #ffffff;
  --aicw-font: "Inter", sans-serif;
}
```

Tokens (all `--aicw-`): `ground surface ink muted line line-strong accent
accent-strong on-accent ok ok-soft warn warn-soft danger danger-soft on-danger
focus radius radius-sm shadow shadow-lg scrim font`. Every pair it prints text
with passes WCAG AA in light and dark (a test checks each). Styles are added
once as a `<style>` tag; `commsWidgetCss()` returns the text if you render it
yourself.

## Transports

`createCommsClient({ baseUrl, fetch?, headers? })` is what `baseUrl` builds.
Every method returns `{ ok: true, data }` or `{ ok: false, error }` and never
throws: a failed fetch is `network`, a proxy's HTML page is `bad_response`, a
401 reads "You've been signed out. Sign in again to keep working.", and the
server's own refusals keep their code and message. A host on tRPC or server
actions still mounts the handler and passes a `transport` built on
`createCommsClient` with its own `fetch`.

## Words

Every email the features send has a written name and a line on when it goes
out ("Visit reminder — to the customer, the day before the visit"), never its
key; a key the console doesn't know is title-cased. Subjects are previewed
with example values ("Confirmed: Lawn mowing, Tue, Nov 4, 9:00 AM"); the edit
form shows the wording with its blanks. The status says when queued messages
missed their run.

## Not included

- **Writing a new kind of message.** The templates are the ones the features
  register (visit confirmations, reminders, estimates, invoices); the owner
  edits their wording and turns them on or off.
- **Sending a one-off message to a customer** from this screen.
- **Logo and colour inside emails.** Bodies are plain text.
- **Per-company sending domains or phone numbers.**
- **Payments to companies, plans and billing per company, custom domains,
  impersonation, per-company SEO.**
- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call**: Tenancy 2b.
- **Translations.** The words are English; `locale` changes date formats.
