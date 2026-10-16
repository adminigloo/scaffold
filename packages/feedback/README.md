# @adminigloo/feedback

A feedback board for each company, complete: the intake its customers' reports land in (from its own website, or its own feedback page), and the Kanban board its team answers and sorts them on — with filters and search, New ticket, editing with an activity trail, **epics** (bigger pieces of work, each with its tickets and its progress), and the column, category and website-key screens. Your own site gets one too, for what your users report with the feedback button.

## What each install gets you

ONE package for the team's side, with an entry point per job, and the widget for the reporter's side. There are no separate npm packages per feature: every screen below ships in `@adminigloo/feedback`.

| You install | You get |
| --- | --- |
| `@adminigloo/feedback` | **The intake** (`createFeedbackHandlers`): what the [feedback widget](../feedback-widget) talks to — by a company's website key, or by the company in the request's address (`resolveTenant`), closed to new tickets for a company that isn't taking them (`admit`). **The staff routes** (`createFeedbackAdminHandlers`): the board with its filters and search, New ticket, a ticket's report, conversation, editing and activity trail, replies, assign, move, archive, the company's people, columns, categories and website keys, and the epics — one company per request. **The server functions** under both, every one of which takes the company. **The contract**: `FEEDBACK_ADMIN_ROUTES` / `FEEDBACK_PUBLIC_ROUTES` (the routes as data, for an isolation proof), `feedbackPermissions` (the keys and their default roles), `feedbackAlertKinds` / `feedbackAlertsFor` (alerts for the team), `FEEDBACK_EMAIL_TEMPLATES` / `feedbackReporterEmailFor` (emails for the reporter). |
| `@adminigloo/feedback/schema` | The Drizzle tables to add to your schema and migrate. Shipped SQL for a host without drizzle-kit: `@adminigloo/feedback/sql/feedback-0.12.0.sql` (a fresh install), `…/sql/upgrade-0.11-to-0.12.sql` (from 0.11), `…/sql/upgrade-0.10-to-0.11.sql` (from 0.10, before that one) and `…/sql/upgrade-0.9-to-0.10.sql` (from 0.9, before both). |
| `@adminigloo/feedback/board` | `FeedbackWorkspace` — the whole board connected to the staff routes by a base URL: the toolbar (search, filters with counts, Mine / Unassigned / Critical, the active filters as chips, Clear, "Showing X of Y"), filters kept in the page's address and remembered per browser, **New ticket** (and a **+** on each column), the board — each card showing its epic — and the ticket panel with editing (title, priority, category, assignee picked from the company's people, epic) and the activity trail. The Epic filter ("No epic" included) is in the toolbar. The pieces on their own, controlled, for tickets you store elsewhere: `BoardToolbar`, `useBoardFilters`, `NewTicketDialog`, `FeedbackBoard`, `TicketPanel`. `FeedbackAdminClient`, the browser's client for the staff routes. React, `"use client"`. |
| `@adminigloo/feedback/admin` | The board's settings as screens: `ColumnEditor` (add, rename, colour, reorder, mark finished, limits and aging; deleting a column that holds tickets asks which column they go to), `CategoryEditor` (add, rename, describe, reorder, offer to customers or keep for sorting), `KeysPanel` (the company's feedback page address, and website keys: make, see once, switch off), and `FeedbackSettingsPanel` (all three). Over the staff routes by `baseUrl`, or any `FeedbackSettingsTransport` you pass. React, `"use client"`. |
| `@adminigloo/feedback/epics` | The epic screens (0.12.0): `FeedbackEpics` (the list — progress bar, status, who leads it, when it's due — with New epic) and `FeedbackEpic` (one epic: its tickets grouped as its progress counts them, add and take out tickets, move it along, edit, delete, and "every ticket is done — mark it completed?"), over the staff routes by `baseUrl`, or any `FeedbackEpicsTransport` you pass. The pieces, controlled: `EpicList`, `EpicDetail`, `EpicDialog`, `AddTicketsDialog`, `EpicProgressBar`, `EpicBadge`. React, `"use client"`. Included in `@adminigloo/feedback`: same install, same key. |
| `@adminigloo/feedback-widget` | The form people send feedback with: a floating button and screenshot for an app, or `FeedbackLauncher` inline on a page (a company's feedback page), and "My reports" to follow a ticket. |

The board components never read a database. `FeedbackBoard` renders the tickets and columns you pass it and tells you when someone moves one; `FeedbackWorkspace` and the `./admin` screens fetch from the routes at their `baseUrl`.

**What you still write** with npm alone: one route file per handler (the staff routes, the intake — the epics ride on the staff routes), your `authorize` check, `listPeople` if you want an assignee picker and epic owners, and a page per screen (a few lines around `FeedbackWorkspace`, `FeedbackSettingsPanel`, `FeedbackEpics` and `FeedbackEpic`). A project made with create-app has all of that already. **What none of the installs give you** is listed under [Not included](#not-included).

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

Peer dependencies: `react` (only for `./board`, `./admin` and `./epics`), `drizzle-orm ^0.45`, `zod ^3.25 || ^4` (only for the server entries; optional if you use the board alone).

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

## Filters, search and New ticket (0.11.0)

`FeedbackWorkspace` has all of this switched on. The pieces, for a board over your own data:

```tsx
"use client";
import { BoardToolbar, boardFilterFields, boardQuickFilters, filtersForRequest, useBoardFilters } from "@adminigloo/feedback/board";

const { filters, setFilters, isReady } = useBoardFilters({ persistKey: "my-board" }); // the page's ?query, remembered per browser
// Load only once isReady is true: remembered filters are back by then, so the board never flashes unfiltered.
const board = await client.board({ filters: filtersForRequest(filters) });

<BoardToolbar
  filters={filters}
  onChange={setFilters}
  fields={boardFilterFields({ statuses, categories, people, me, facets: board.facets })}
  quickFilters={boardQuickFilters({ me, facets: board.facets })}
  totalCount={board.totalCount}
  matchCount={board.matchCount}
  shownCount={board.tickets.length}
  truncated={board.truncated}
  onCreate={() => setCreating(true)}
/>
```

- **Every filter runs on the server**, in the same query as the company: status, priority, category (and "No category"), assigned to (a person, "Unassigned", and "Me" — the person asking, so a shared "mine" link means mine for whoever opens it), came in through (the feedback button, the feedback page, your team), and when it was sent. Text a database can't hold (a NUL character) and dates outside 1970–2999 are refused with a sentence. OR within a field, AND across fields, and the search ANDs with them.
- **Search** covers the ticket number (typed any way: `12`, `#12`, `fb-12`), the title, the report, and the reporter's name and email, in any case. `%`, `_` and `\` mean themselves.
- **Counts:** each choice shows how many tickets it would give with the other filters on — always exactly what ticking it gives, and the Assigned-to choices add up to the board. A name typed as the assignee before 0.11 is linked to the person with that name (when exactly one of `listPeople` has it) the first time the board opens (`linkTypedAssignees`); any other typed name is its own choice, "<name> (not linked)". "Showing X of Y" counts in the database; past the board's caps (300 unfinished, 100 finished — read separately, so a busy Done column never pushes open work off) the toolbar says how many more match instead of hiding them.
- **The address carries the filters** under the names the routes read (`?q=gate&status=open&assignee=__me`), so a link shares the view and Back undoes a filter; other parameters of the page (`?ticket=…`) are left alone. A visit with no filters in its address gets the ones this browser had last.
- **On a phone** the rows wrap and each menu is a sheet along the bottom of the screen. Menus close on Escape and move with the arrow keys.

**New ticket** — `NewTicketDialog`, or the routes' `POST v1/admin/tickets`: only a title is needed; it lands in the column whose **+** was pressed (else the first unfinished one), numbered in the company after the reports (race-safe with the intake), marked as from your team. "Filing this for a customer" takes their name and email (checked); they're emailed only if the team ticks "Email them when you reply or move it" (`tellReporter`) — they never used the feedback form, so those emails are worded for a request the team opened, without "My reports", and they answer by replying to the email (comms sends with the company's reply-to). If the board's filters hide the new ticket, the dialog says so, with "Clear filters" and "Open it". Server side: `createStaffTicket(db, tenantId, input, actor)`.

**Editing and the trail.** The panel edits the title, priority, category and assignee (`updateTicket(db, tenantId, …, actor)`; route `POST v1/admin/tickets/{id}`). Every change — and every move, archive and the ticket's arrival — is a line of its activity trail (`listTicketEvents`, route `GET v1/admin/tickets/{id}/events`, table `feedback_ticket_events`), in words: "Ada moved it from Open to In progress". The reply box says who reads a reply: emailed to the customer, seen under "My reports", or — on a team ticket nobody is told about — kept to the team. Pass `emailsReporters={false}` to `FeedbackWorkspace` on a board that sends no email.

**People.** Give the staff routes `listPeople(tenantId, req)` — the company's people, `{ id, name }`, your user ids — and the panel and New ticket offer a picker, the Assigned-to filter lists them, and an assignee id is checked against them (anyone else's is refused). Without it the board works as 0.10 did: the assignee is a typed name.

## The settings screens (./admin, 0.11.0)

```tsx
"use client";
import { FeedbackSettingsPanel } from "@adminigloo/feedback/admin";

<FeedbackSettingsPanel
  baseUrl={`/api/app/${company.id}/feedback`}
  canManage={can("feedback.settings.manage")}          // only what is OFFERED; the routes refuse the rest
  intakeUrl="https://app.example.com/api/igloo"           // for the website-key snippet
  publicPageUrl={`https://app.example.com/t/${company.slug}/feedback`}
/>
```

Or one at a time: `<ColumnEditor baseUrl=… />`, `<CategoryEditor … />`, `<KeysPanel … />`. Each takes `transport` instead of `baseUrl` — any object with the editors' methods (`FeedbackSettingsTransport`) — for a host whose columns live in its own tables. A column's short name (what tickets point at) is made from its name when it's added — with a number when it's taken ("open_2") — and is never shown or changed; renaming changes what people read, and only a NAME already on the board is refused. Deleting a column with tickets asks which column they go to (`deleteStatus(db, tenantId, id, { moveTo })`); each move goes on the ticket's trail and is announced as `ticket.moved`, like a drag. The last column can't be deleted. The default columns and categories come once per company (`feedback_boards` remembers): delete every category and the list stays empty.

## Epics (./epics, 0.12.0)

An epic is a bigger piece of work a company's tickets are grouped under — "New checkout", "Spring price list". A ticket is in one epic or none. Epics come with the board: same package, same routes, same two keys (`feedback.view` to look, `feedback.manage` to change).

```tsx
"use client";
import { FeedbackEpic, FeedbackEpics } from "@adminigloo/feedback/epics";

// /app/feedback/epics
<FeedbackEpics baseUrl={`/api/app/${company.id}/feedback`} canManage={can("feedback.manage")} epicsHref="/app/feedback/epics" boardHref="/app/feedback" />
// /app/feedback/epics/[id]
<FeedbackEpic baseUrl={`/api/app/${company.id}/feedback`} epicId={id} canManage={can("feedback.manage")} epicsHref="/app/feedback/epics" boardHref="/app/feedback" />
// and on the board, a link to them:
<FeedbackWorkspace baseUrl={…} epicsHref="/app/feedback/epics" />
```

- **On the board.** Every card in an epic shows its badge (the epic's colour and name). The toolbar's **Epic** filter lists the epics being worked on (and a finished one that still has tickets showing), then "No epic", each with its count; `?epic=` carries it in the address. The ticket panel and New ticket pick a ticket's epic from those still being worked on; the panel always shows the ticket's own epic, finished or not, and its badge opens the epic's page.
- **An epic** has a name (the only thing needed, unique in the company — case and spacing don't count, and the database holds to it even when two people press "Make the epic" at once), what it's for, who leads it (one of `listPeople` — a new epic starts with whoever makes it, and "Nobody yet" is a real choice; someone who has since left the team stays its leader, shown as "(no longer on the team)", until another is picked), a "done by" date, and one of ten colours (`EPIC_COLORS`).
- **Its life:** not started → in progress → completed → archived, by Ask Lou's moves (`EPIC_TRANSITIONS`): any live status to any other, and an archived epic only back to not started. The status picker offers only those, and a refusal is said in words. Completing stamps `completedAt`; archiving stamps `archivedAt`; going back to work clears both.
- **It starts by itself** the moment one of its tickets leaves the column new tickets land in — whatever that column is called — from a drag, a bulk move, a column delete, New ticket or the editor. **Nothing completes it by itself:** when every ticket is done, its page asks "Mark the epic completed?".
- **Progress is one rule, by the columns' flags** (`epicProgress`, `epic-core`): done = a finished column, or archived (an archived ticket has been put away, so it never holds an epic short of 100%); waiting = a column marked "Waiting on someone else" in the column editor (`isWaiting`); not started = the column new tickets land in; anything else in progress. The list, the epic's page and its groups all use it, so the numbers never disagree. The percent rounds down: 100% only ever means every ticket.
- **Adding and taking out tickets** is one change (`setEpicTickets(db, tenantId, epicId, { add, remove }, actor)`; route `POST v1/admin/epics/{id}/tickets`): every id must be one of the company's tickets, or nothing is changed; tickets are only added to an epic still being worked on ("Reopen it before adding tickets"); a ticket in another epic moves, and "Add tickets" says so first. Each change is a line on the ticket's trail: "Ada put it in the epic Checkout (was Pricing)".
- **Deleting an epic** is never refused: its tickets — archived ones too — stay on the board and leave the epic, each with a trail line. The page waits for the answer before it leaves, and the list then says "Deleted. Its N tickets are still on the board." A ticket's epic is a foreign key (ON DELETE SET NULL), so nothing done at the same moment — on any driver, in a transaction or not — can leave a ticket pointing at a deleted epic; an add that comes after the delete is refused in words.
- **Reopening or restoring** an epic whose tickets are already under way lands on In progress, not Not started. A refused change (someone else moved the epic first) is said in words and the page shows the epic as it now is.

The routes (all in `FEEDBACK_ADMIN_ROUTES`, so an isolation proof covers them): `GET v1/admin/epics` (with progress), `POST v1/admin/epics`, `GET v1/admin/epics/{id}` (with its tickets), `POST v1/admin/epics/{id}`, `POST v1/admin/epics/{id}/status`, `POST v1/admin/epics/{id}/tickets`, `POST v1/admin/epics/{id}/delete`; and `epicId` on New ticket and the ticket edit. Another company's epic is "not found"; one of its tickets put into this company's epic, one of its people as an owner, or its epic on this company's ticket is refused before anything is written. A company whose plan has ended keeps reading its epics and can't change them (the plan check refuses `feedback.manage`). The server functions: `listEpics`, `getEpic`, `createEpic`, `updateEpic`, `setEpicStatus`, `setEpicTickets`, `deleteEpic` — each takes the company.

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
| `feedback.manage` | reply (the reporter is emailed), move, assign, archive; make, change and delete epics | owner, admin, member |
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

## Upgrading from 0.11

Additions only: every 0.11 call keeps working.

1. **The tables: run `sql/upgrade-0.11-to-0.12.sql`** (safe to run twice), or with drizzle-kit generate and run a migration as usual — nothing in it needs hand-editing. `feedback_epics` is created (with a unique index on the company and the epic's name, case and spacing aside); tickets gain `epic_id` (empty for every 0.11 ticket, a foreign key to the epic, cleared when it's deleted); columns gain `is_waiting` (off — mark a column like "Waiting on customer" in the column editor and epics count its tickets as waiting).
2. **The board's answer** carries `epics` (the company's epics, for the badges and pickers), each ticket's `epicId`, and `facets.epic`. `BoardFilters` has an `epic` field (`?epic=`); a filters object built by hand needs `epic: []` (`EMPTY_FILTERS` has it).
3. **New routes** — the seven `epics` routes above — are in `FEEDBACK_ADMIN_ROUTES`, on `feedback.view` and `feedback.manage`. An isolation proof driven from the table needs an `{epic}` row planted for each company.
4. **The trail** has a new kind, `"epic"`; a screen that lists events by kind should word it ("put it in the epic …", as `TicketPanel` does).
5. **Pages:** add the epics pages (a few lines each, above) and pass `epicsHref` to `FeedbackWorkspace` for its link. create-app 0.28 does all of this.

## Upgrading from 0.10

Additions only: every 0.10 call keeps working. Then run the 0.11 → 0.12 upgrade above.

1. **The tables: run `sql/upgrade-0.10-to-0.11.sql`, then `sql/upgrade-0.11-to-0.12.sql`** (each safe to run twice), or with drizzle-kit generate and run a migration as usual — nothing in it needs hand-editing. Tickets gain `assignee_id`, `source`, `created_by` and `notify_reporter`; `feedback_ticket_events` (the trail) and `feedback_boards` (boards already set up, so their defaults never come back) are created. Every 0.10 ticket shows as from the feedback button (0.10 didn't record which tickets came from a company's feedback page) and starts with an empty trail. A typed assignee is linked to the matching person the first time the board opens, or stays its own "(not linked)" choice.
2. **`listBoardData(db, tenantId, { filters, viewerId })`** takes the filters and who is asking, and answers `totalCount`, `matchCount`, `truncated` and `facets` beside the tickets. `{ includeArchived }` still works. Finished columns are read separately (up to 100 cards) from unfinished ones (up to 300).
3. **The board route reads the filters from its query** (`?q=&status=&priority=&category=&assignee=&source=&from=&to=&archived=1`). `?archived=1` means what it did.
4. **New routes** — `POST v1/admin/tickets` (New ticket), `POST v1/admin/tickets/{id}` (edit), `GET v1/admin/tickets/{id}/events`, `GET v1/admin/people` — are in `FEEDBACK_ADMIN_ROUTES`, so an isolation proof driven from the table covers them. `POST v1/admin/columns/{id}/delete` takes `{ moveTo }`.
5. **Reporter emails:** two more templates, `feedback_team_ticket_reply` and `feedback_team_ticket_status`, for tickets the team filed (add `FEEDBACK_EMAIL_TEMPLATES` again; existing ones are kept). Events carry `source` and `notifyReporter`, and `feedbackReporterEmailFor` returns null when the reporter isn't to be told.
6. **Short names:** `createStatus` / `createCategory` take `key` as a suggestion and return the key actually stored.
7. **The trail needs who did it.** `moveTicket`, `moveTickets`, `unarchiveTicket`, `archiveTicket`, `archiveTerminalTickets` and `assignTicket` take an optional actor; without one the trail says "The team".
8. **create-app projects** replace their own `src/components/FeedbackSettings.tsx` with `FeedbackSettingsPanel` (create-app 0.27 does).

## Upgrading from 0.9

0.9 had one board for the whole install. In 0.10 every board belongs to a company.

1. **The tables: run `sql/upgrade-0.9-to-0.10.sql`.** 0.9 had ONE board, your own, so the upgrade puts everything 0.9 had on `"*"`, your own site's board: its columns and categories, exactly as they were, and **every website key and every ticket** — whatever company id 0.9's issue-key script filed them under. Your site's feedback button keeps working with the key it has and keeps feeding your own board, and no company's board shows reports that were never sent to it. Column and category keys, and ticket numbers, become unique per company, and the screenshots table is created. That move runs only on a 0.9 database, so running the file again later moves nothing of the companies'. **With drizzle-kit**, run `drizzle-kit generate`, then replace the feedback statements in the migration it wrote with this file's contents: drizzle-kit can't know that the existing rows are your own board's, and its plain "add a column" can't add the company column without a default.
2. **After the upgrade, company columns have no default.** An insert into `feedback_statuses` or `feedback_categories` that forgets the company fails instead of landing on your own board.
3. **Every server function takes the company.** `listBoardData(db)` is now `listBoardData(db, tenantId)`, `moveTicket(db, { … })` is `moveTicket(db, tenantId, { … })` (and answers `{ moved, reason }`), `revokeClientKey(db, keyId)` is `revokeClientKey(db, tenantId, keyId)`, and so on. Pass `"*"` for the board you had. A tRPC router over the 0.9 functions can be replaced by `createFeedbackAdminHandlers({ tenantId: "*", … })` and `FeedbackWorkspace`.
4. **Events.** Every event now carries `tenantId`; `reporter.replied` carries the reply's `messageId`; `staff.replied` and `ticket.moved` are new (staff routes only). `FeedbackRateLimitInfo.keyId` is null for a request with no key.
5. **Errors.** The intake answers `{ error: "<a plain sentence>", code }`; the old field is still a string, so a 0.3 widget keeps working.

## Not included

- **Sprints** (a time box tickets are planned into). Epics say what a piece of work is for; when it's done is its "done by" date.
- **Swimlanes by epic** (a row of columns per epic). Filter the board by an epic instead, or open the epic's page.
- **An epic's health** (on track, at risk, stalled) and a summary to copy. The list says how many days an epic has left or is late.
- **Saved views per person.** Filters (the Epic filter too) are kept in the address and remembered per browser; there is no list of named views that follows a person between devices.
- **Custom fields** on a ticket. A ticket has the fields above; anything else goes in its report or conversation.
- **Swimlanes by person** (a row per person) and sorting the board by anything but newest first.
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

The board's server functions — `listBoardData`, `getTicket`, `createTicket`, `moveTicket`, `moveTickets`, `archiveTicket`, `createStatus`, `reorderStatuses`, `listCategories`, `addTicketMessage`, `assignTicket`, `listEpics`, `setEpicTickets`, and the rest — take your `db` and the company, and return plain data, so you can call them from route handlers, server actions or tRPC procedures. Gate them with your own check; the staff routes above already do.

The tests run on PGlite (a real Postgres, in-process), including a pass where one company calls every function and every route with another company's ids.
