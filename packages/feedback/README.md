# @adminigloo/feedback

A feedback board for each company: the intake its customers' reports land in (from its own website, or its own feedback page), and the Kanban board its team answers and sorts them on. Your own site gets one too, for what your users report with the feedback button.

## What each install gets you

| You install | You get |
| --- | --- |
| `@adminigloo/feedback` | **The intake** (`createFeedbackHandlers`): what the [feedback widget](../feedback-widget) talks to — by a company's website key, or by the company in the request's address (`resolveTenant`), closed to new tickets for a company that isn't taking them (`admit`). **The staff routes** (`createFeedbackAdminHandlers`): the board, a ticket's report and conversation, replies, assign, move, archive, columns, categories and website keys — one company per request. **The server functions** under both, every one of which takes the company. **The contract**: `FEEDBACK_ADMIN_ROUTES` / `FEEDBACK_PUBLIC_ROUTES` (the routes as data, for an isolation proof), `feedbackPermissions` (the keys and their default roles), `feedbackAlertKinds` / `feedbackAlertsFor` (alerts for the team), `FEEDBACK_EMAIL_TEMPLATES` / `feedbackReporterEmailFor` (emails for the reporter). |
| `@adminigloo/feedback/schema` | The Drizzle tables to add to your schema and migrate. Shipped SQL for a host without drizzle-kit: `@adminigloo/feedback/sql/feedback-0.10.0.sql` and `…/sql/upgrade-0.9-to-0.10.sql`. |
| `@adminigloo/feedback/board` | `FeedbackWorkspace` — the whole board connected to the staff routes by a base URL (toolbar, board, ticket panel). `FeedbackBoard` and `TicketPanel` on their own, controlled, for tickets you store elsewhere. `FeedbackAdminClient`, the browser's client for the staff routes. React, `"use client"`. |
| `@adminigloo/feedback-widget` | The form people send feedback with: a floating button and screenshot for an app, or `FeedbackLauncher` inline on a page (a company's feedback page), and "My reports" to follow a ticket. |

The board components never read a database. `FeedbackBoard` renders the tickets and columns you pass it and tells you when someone moves one; `FeedbackWorkspace` fetches them from the routes at its `baseUrl`.

## Install

The package is private, published to GitHub Packages. Add the scope to your project's `.npmrc` (commit this line — it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

Your token goes in your **user-level** `~/.npmrc` (never the repo):

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
npm install @adminigloo/feedback   # or pnpm add / yarn add
```

**Every place that installs needs the token**, not only your laptop:

- **Vercel:** an environment variable `NPM_RC` containing both lines above (scope + auth), in Preview and Production.
- **GitHub Actions:** a repository secret, passed to the install step through `actions/setup-node`:

  ```yaml
  - uses: actions/setup-node@v5
    with:
      node-version: 22
      registry-url: https://npm.pkg.github.com
      scope: "@adminigloo"
  - run: npm install
    env:
      NODE_AUTH_TOKEN: ${{ secrets.ADMINIGLOO_PACKAGES_TOKEN }}
  ```

Without it, the build stops at install with `401 Unauthorized`.

Peer dependencies: `react` (only for `./board`), `drizzle-orm ^0.45`, `zod ^3.25 || ^4` (only for the server entries; optional if you use the board alone).

## The board

```tsx
"use client";
import { FeedbackBoard, type BoardStatusView } from "@adminigloo/feedback/board";

const statuses: BoardStatusView[] = [
  { key: "open", label: "Open", sortOrder: 0 },
  { key: "in_progress", label: "In progress", sortOrder: 1 },
  { key: "done", label: "Done", sortOrder: 2, isTerminal: true },
];

export function Board({ tickets }) {
  return (
    <FeedbackBoard
      statuses={statuses}
      tickets={tickets}
      theme="light"
      onMove={async (ticketId, statusKey) => {
        const result = await moveTicketAction({ ticketId, statusKey });
        if (!result.ok) throw new Error(result.error); // ← throw to put the card back
        router.refresh();
      }}
      onMoveError={(error) => toast.error(String(error))}
      ticketHref={(ticket) => `/admin/tickets/${ticket.id}`}
      onOpen={(ticket) => router.push(`/admin/tickets/${ticket.id}`)}
    />
  );
}
```

### The move contract — read this one

The card moves on screen as soon as it is dropped, then the board awaits `onMove`.

- **Resolve** → the move stands.
- **Throw (reject)** → the card goes back to where it was, and `onMoveError` is called.

A promise that *resolves* always counts as a landed move. If your API reports failure as a value — a Next.js server action's `{ ok: false }`, a `fetch` with a 4xx — you must turn that into a throw, or a refused move stays in the wrong column on screen.

`onMoveMany` (bulk) has the same contract, with one addition: if only some of the batch was refused, resolve `{ failed: [ticketIds] }`. Those cards go back, and the rest stay moved and leave the selection. Throwing still sends the whole batch back.

After a move, refresh the `tickets` you pass in. The board shows its optimistic position only until the prop catches up, and the server always wins: if the prop says something else, the board shows that.

### Props

| Prop | Required | What it does |
| --- | --- | --- |
| `statuses` | yes | The columns. Only `key` and `label` are required. Optional per column: `color` (any CSS colour, including `var(--your-token)`), `sortOrder`, `isTerminal`, `wipLimit` (shows `count/limit`, warns at and past it), `agingWarnHours` / `agingStaleHours` (a ring, then a filled dot, on cards that have sat too long). |
| `tickets` | yes | The cards. Required: `id`, `ticketNumber`, `title`, `priority` (`critical`/`high`/`medium`/`low` are styled), `status`, `createdAt` (a `Date` or an ISO string). |
| `onMove` | yes | `(ticketId, statusKey)` — see the contract above. |
| `onMoveMany` | no | Turns on selection: a checkbox on every card, a select-all on every column, and a "Move to…" bar. This is the board's touch path and its non-drag alternative for pointer users (WCAG 2.5.7). May resolve `{ failed: [ids] }` for a partial batch. |
| `onMoveError` | no | `(error, ticketIds, statusKey)` — a move was refused. Tell the person why. |
| `onOpen` | no | Card click. Open your panel or navigate. |
| `ticketHref` | no | Makes each card's title a real link (middle-click, copy link, keyboard). With `onOpen` as well, a plain click calls `onOpen` and a modified click follows the link. |
| `theme` | no | `"auto"` (default, follows the OS), `"light"`, `"dark"`. If your app has no dark mode, pass `"light"`. |

A ticket whose `status` matches no column shows up in a trailing **"Unrecognised status"** column. You can drag it out of there, but you can't drop anything into it. Give every status you store a column.

### Keyboard, touch and screen readers

- With `onOpen` or `ticketHref`, each card's title is a button (or a link). Tab reaches it and Enter opens it. **Pass one of them**: without either, a card has nothing to focus, so it can't be opened or moved from the keyboard.
- **Alt+→ / Alt+←** on a focused card moves it one column, and focus stays on the card, including when the server refuses the move and the card goes back. This is the keyboard equivalent of dragging. In the first or last column, or on a card whose status has no column, nothing moves and the reason is announced. The board still handles the keys, so they never become the browser's Back or Forward.
- Drag-and-drop uses the mouse. On touch screens, use the checkboxes and "Move to…" (pass `onMoveMany`). Every checkbox and bar control is a 44×44px target.
- Columns are labelled groups with lists of cards. Counts, WIP limits and card aging are spelled out for screen readers, and every move is announced through a polite live region.
- Windows High Contrast (forced colours) keeps the checkboxes, ticks and aging marks visible.

### Theming

All colours are CSS custom properties. Set them on `.aib-root` (the board) and `.aib-panel-layer` (the panel: its scrim and dialog together). Set them only on those two outer elements, because a value set on an inner element doesn't reach its siblings. The package's defaults have zero specificity, so a plain class rule in your stylesheet wins in either theme, whatever the load order. The same goes for the board's `font-family` and `color`:

```css
.aib-root,
.aib-panel-layer {
  --aib-accent: var(--color-primary);
  --aib-surface: var(--color-surface);
  font-family: inherit;
}
```

Tokens: `surface`, `surface-2`, `ink`, `ink-muted`, `ink-faint`, `line`, `line-strong`, `accent`, `accent-strong`, `accent-soft`, `danger`, `warn`, `on-accent`, `shadow-card`, `shadow-panel`, `scrim`. Each is used as `--aib-<name>`. The defaults meet WCAG AA in both themes, and a unit test checks every pair. If you change them, keep that property.

Placement:

| Variable | Default | What it moves |
| --- | --- | --- |
| `--aib-bar-bottom` | `16px` | The bulk bar's distance from the bottom of the window. Raise it above a floating chat or feedback button. |
| `--aib-bar-left` | `50%` | The bar's horizontal centre. Use e.g. `calc(50% + 120px)` to centre it on your content beside a 240px sidebar. |
| `--aib-z-bar` | `40` | The bar's stacking order. |
| `--aib-z-panel` | `2147483003` | The panel's stacking order (its scrim is one below). The default sits above the feedback widget's launcher, so the launcher can't cover Send. To show toasts above the scrim, lower it on `.aib-panel-layer`. |

Set the bar variables on `.aib-root`.

The bulk bar is `position: fixed`: it floats at the bottom of the window whenever cards are ticked, and the board gains bottom padding so the last cards can scroll clear of it.

On React 19 the stylesheet is rendered with the component, so server-rendered HTML arrives already styled. On React 18 it is injected on mount.

## The ticket panel

`TicketPanel` is one ticket's workspace. It shows the report, the screenshot, the captured context, the conversation, and status, assignee and archive controls.

It is a modal dialog:

- Focus moves into it, and Tab stays inside.
- Escape closes it and doesn't reach handlers outside it.
- On close, focus returns to the ticket's card title, even if the card has since moved column or was opened by clicking its body.
- It only answers keys aimed at itself, so a dialog stacked above it keeps its own Tab and Escape.

The Status select applies a pick from its list, or a mouse pick, immediately. Stepping through the options with the arrow keys on the closed control only stages a choice. Enter applies it, as does leaving the control, and Escape reverts it.

Toasts raised from the panel's callbacks render under its scrim at the default `--aib-z-panel`. Lower it on `.aib-panel-layer` (see Theming) if your toasts must show above an open panel.

```tsx
<TicketPanel
  ticket={ticket}
  messages={messages}
  statuses={statuses}
  detail={detail}            // optional: description, context, errors — fetch on open
  currentUser="Dana"
  onClose={() => setOpenId(null)}
  onSend={async (body) => { await addMessage(body); }}
  onAssign={async (assignee) => { await assign(assignee); }}
  onMove={async (statusKey) => { await move(statusKey); }}
  onArchive={async () => { await archive(); }}        // optional
  onError={(error, action) => toast.error(`Couldn't ${action}`)}
  formatTime={(date) => date.toLocaleString()}         // optional; default is the viewer's locale
  theme="light"
/>
```

Each callback may throw. The panel catches the error and passes it to `onError`, and a failed send keeps the draft so nothing typed is lost.

## A board per company

Every staff function, route and table row belongs to ONE company (its `tenantId`, your id for it). A ticket, column, category or website key of another company, asked for by id, is "not found" — the same answer as an id that never existed. Each company's board gets the default columns and categories the first time it's used, its tickets are numbered on their own (each company starts at FB-00001), and `"*"` (`FEEDBACK_PLATFORM_BOARD`) is your own site's board.

### The staff routes

```ts
// app/api/app/[tenantId]/feedback/[...path]/route.ts
import { createFeedbackAdminHandlers } from "@adminigloo/feedback";

const { handle } = createFeedbackAdminHandlers({
  db,
  resolveTenant: (req) => companyIdFromPath(req),          // or tenantId: "*" for your own board
  authorize: (req, permission, tenantId) => yourCheck(req, permission, tenantId), // true | { userId } | false | Response
  staffName: (userId) => nameOf(userId),                   // the name a reporter sees on a reply
  onEvent: (event) => emailTheReporter(event),             // staff.replied, ticket.moved
});
export { handle as GET, handle as POST };
```

`authorize` is asked for exactly one key per route (`FEEDBACK_ADMIN_ROUTE_PERMISSIONS`): `false` answers 403 "You don't have permission to do that.", a `Response` (your 401) is returned as it is. POSTs from another site are refused before any work. Then the page:

```tsx
<FeedbackWorkspace
  baseUrl={`/api/app/${company.id}/feedback`}
  canManage={can("feedback.manage")}
  settingsHref={can("feedback.settings.manage") ? "/app/feedback/settings" : null}
  initialTicketId={searchParams.ticket}      // an alert's link opens its ticket
/>
```

The same component serves your own board over its own routes (`baseUrl="/api/admin/feedback"`).

### The keys

| Key | Lets someone | Default roles |
| --- | --- | --- |
| `feedback.view` | see the board, a ticket and its conversation | owner, admin, member, viewer |
| `feedback.manage` | reply (the reporter is emailed), move, assign, archive | owner, admin, member |
| `feedback.settings.manage` | change the columns and categories; make and switch off website keys | owner, admin |

Crew holds none. Spread `feedbackPermissions` into your `definePermissions("tenant", …)`, or map the keys onto your own checks.

### The intake, for a company's customers

```ts
// app/api/t/[slug]/feedback/[...path]/route.ts — a company's own feedback page, no key
const { handle } = createFeedbackHandlers({
  db,
  resolveTenant: (req) => companyIdFromWebAddress(req),
  admit: async (tenantId) => (isTakingWork(tenantId) ? { open: true } : { open: false, message: "Green Acres isn't taking requests online right now." }),
  rateLimit: createFeedbackRateLimit(async (key, policy) => (await yourLimiter.limit({ key, policy })).allowed),
  onEvent: (event) => alertTheTeam(event), // ticket.created, reporter.replied
});
```

A company's feedback page sends no key, and takes **no screenshots**: an upload there is refused. Its form carries a hidden field a person never fills (`website`); a report with it filled is refused. `createFeedbackRateLimit` holds the open door to a size a business can live with (`FEEDBACK_INTAKE_LIMITS`): per form and visitor, per visitor across every company, and a feedback page's whole day; a request with no forwarded address is counted as one shared visitor. A report keeps only a category the board offers its customers (a team-only one, or an unknown one, is dropped).

A closed company takes no NEW ticket — submit and upload answer 409 `feedback_closed` with your sentence, and the form's settings say so — while a reporter can still read their ticket and reply on it. A website key sent under another company's address is "not found". Without `resolveTenant`, every request needs a website key, which names its company: that is the intake a company's own website (and your app's own button) calls.

Website keys per company: `issueClientKey(db, { tenantId, label })` (the plaintext is returned once; only its hash is kept), `listClientKeys(db, tenantId)`, `revokeClientKey(db, tenantId, keyId)` — or the `keys` routes.

### Screenshots

Only a website key's form (an app's feedback button) takes screenshots. The intake checks the bytes are really a PNG, JPEG or WebP image (never what the browser said), keeps them through your `screenshots` store, and remembers each one: a report may carry only a screenshot THIS board's upload route stored, not used by another report — an address on another store, or another company's picture, is dropped. `sweepFeedbackUploads(db, { store })` (run it daily) deletes the ones no report used within a day.

With [@adminigloo/storage](../storage), keep a company's screenshots private: register `feedbackScreenshotPurpose` and `feedbackFileRecords(db, { ticketHref })` in `createStorage`, and adapt `storage.purposeStore("feedback.screenshot")` as the store (`put`, `attach` to `FEEDBACK_TICKET_RECORD`, `remove`). The screenshot then sits on its ticket, opens through the company's signed-in files route, and the ticket's permissions (`feedback.view`) decide who sees it. `screenshots` may be a function of the board, to use a different store per board.

### Alerts and reporter emails

`feedbackAlertKinds` is a fragment for [@adminigloo/notifications](../notifications)' registry: "A customer sends feedback" and "A customer answers on their feedback", to everyone holding `feedback.view`, in the app by default. `feedbackAlertsFor(event, { hrefs: { ticket: "/app/feedback?ticket={id}" } })` turns an intake event into its drafts.

`feedbackReporterEmailFor(event, { businessName, feedbackUrl })` turns a staff event into the reporter's email (the team replied; the ticket moved), or null when the reporter left no address — hand it to [@adminigloo/comms](../comms)' `sendNow` so it goes out in the company's name, with `FEEDBACK_EMAIL_TEMPLATES` added to the company's templates once.

## Upgrading from 0.9

0.9 had one board for the whole install. In 0.10 every board belongs to a company.

1. **The tables: run `sql/upgrade-0.9-to-0.10.sql`.** 0.9 had ONE board, your own, so the upgrade puts everything 0.9 had on `"*"`, your own site's board: its columns and categories, exactly as they were, and **every website key and every ticket** — whatever company id 0.9's issue-key script filed them under. Your site's feedback button keeps working with the key it has and keeps feeding your own board, and no company's board shows reports that were never sent to it. Column and category keys, and ticket numbers, become unique per company, and the screenshots table is created. That move runs only on a 0.9 database, so running the file again later moves nothing of the companies'. **With drizzle-kit**, run `drizzle-kit generate`, then replace the feedback statements in the migration it wrote with this file's contents: drizzle-kit can't know that the existing rows are your own board's, and its plain "add a column" can't add the company column without a default.
2. **After the upgrade, company columns have no default.** An insert into `feedback_statuses` or `feedback_categories` that forgets the company fails instead of landing on your own board.
3. **Every server function takes the company.** `listBoardData(db)` is now `listBoardData(db, tenantId)`, `moveTicket(db, { … })` is `moveTicket(db, tenantId, { … })` (and answers `{ moved, reason }`), `revokeClientKey(db, keyId)` is `revokeClientKey(db, tenantId, keyId)`, and so on. Pass `"*"` for the board you had. A tRPC router over the 0.9 functions can be replaced by `createFeedbackAdminHandlers({ tenantId: "*", … })` and `FeedbackWorkspace`.
4. **Events.** Every event now carries `tenantId`; `reporter.replied` carries the reply's `messageId`; `staff.replied` and `ticket.moved` are new (staff routes only). `FeedbackRateLimitInfo.keyId` is null for a request with no key.
5. **Errors.** The intake answers `{ error: "<a plain sentence>", code }`; the old field is still a string, so a 0.3 widget keeps working.

## Not included

- **Filters and search on the board**, a **"new ticket" button for the team**, and **epics** (grouping tickets) — next.
- **Column and category editors as package screens.** The routes are here (`columns`, `categories`); the screens are your app's own.
- **Custom domains** for a company's feedback page.
- **Checking a reporter's email address.** The address someone types on a feedback form isn't confirmed; the team's answer is emailed to it as typed.
- **Answering while a company's plan has ended.** Its customers can still read and reply on their tickets, but its team can't answer them until the company has a plan again (the host's plan check closes the staff routes).
- **"My reports" on another device.** A reporter follows their tickets on the device, and the web address, they sent them from: the follow-up key lives in that browser only.
- **Private screenshots without @adminigloo/storage.** Without it, screenshots go wherever your `screenshots` store puts them (create-app: the public Blob store, under addresses nobody can guess).

## The tables

Add the tables to your Drizzle schema and generate a migration:

```ts
// db/schema.ts
export * from "@adminigloo/feedback/schema";
```

The intake the widget talks to (`GET /v1/config`, `POST /v1/upload`, `POST /v1/submit`, `POST /v1/thread`, `POST /v1/reply`, with CORS built in) mounts in any route handler that receives a `Request`:

```ts
import { createFeedbackHandlers } from "@adminigloo/feedback";

const feedback = createFeedbackHandlers({ db, storeFile /* optional: uploads screenshots — Vercel Blob */ });
export const GET = feedback.handle;
export const POST = feedback.handle;
export const OPTIONS = feedback.handle;
```

**Screenshots: only the board's own uploads.** A report keeps a screenshot address only if this board's upload route stored it (see "Screenshots" above), so nobody can plant an image from somewhere else for whoever triages the ticket to open. Any store works (`screenshots`, or 0.9's `storeFile`); without one, reports are submitted without images.

The board's server functions — `listBoardData`, `getTicket`, `createTicket`, `moveTicket`, `moveTickets`, `archiveTicket`, `createStatus`, `reorderStatuses`, `listCategories`, `addTicketMessage`, `assignTicket`, and the rest — take your `db` and the company, and return plain data, so you can call them from route handlers, server actions or tRPC procedures. Gate them with your own check; the staff routes above already do.

The tests run on PGlite (a real Postgres, in-process), including a pass where one company calls every function and every route with another company's ids.
