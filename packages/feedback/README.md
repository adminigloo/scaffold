# @adminigloo/feedback

The feedback platform: the intake your users' bug reports land in, and the Kanban board your team triages them on.

It ships three entry points:

| Entry | What it is | Runs |
| --- | --- | --- |
| `@adminigloo/feedback` | Client keys, the HTTP handlers the [feedback widget](../feedback-widget) talks to, and the board's server functions (list, move, archive, statuses, categories, messages) | Server |
| `@adminigloo/feedback/schema` | The Drizzle tables to add to your schema and migrate | Server |
| `@adminigloo/feedback/board` | `FeedbackBoard` and `TicketPanel` — React components, `"use client"` | Browser |

You can use the board on its own, over tickets you already store somewhere else. The board never reads a database. It renders the tickets and columns you pass it and tells you when someone moves one.

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

## The server half

Add the tables to your Drizzle schema and generate a migration:

```ts
// db/schema.ts
export * from "@adminigloo/feedback/schema";
```

Then mount the intake the widget talks to (`GET /v1/config`, `POST /v1/upload`, `POST /v1/submit`, `POST /v1/thread`, `POST /v1/reply`, with CORS built in) in any route handler that receives a `Request`:

```ts
import { createFeedbackHandlers } from "@adminigloo/feedback";

const feedback = createFeedbackHandlers({ db, storeFile /* optional: uploads screenshots — Vercel Blob */ });
export const GET = feedback.handle;
export const POST = feedback.handle;
export const OPTIONS = feedback.handle;
```

Issue a client key for the widget with `issueClientKey(db, { tenantId, label })`. Only its SHA-256 hash is stored, and the plaintext is returned once. Revoke a key with `revokeClientKey(db, keyId)`.

**Screenshots must be stored on Vercel Blob.** The intake accepts screenshot and attachment URLs only on `*.public.blob.vercel-storage.com`. This stops one tenant from planting arbitrary images that whoever triages the ticket would then open. A `storeFile` that uploads anywhere else (S3, R2) makes every submit with a screenshot fail validation. Without a `storeFile`, reports are submitted without images.

The board's server functions — `listBoardData`, `moveTicket`, `moveTickets`, `archiveTicket`, `createStatus`, `reorderStatuses`, `listCategories`, `addTicketMessage`, `assignTicket`, and the rest — take your `db` and return plain data, so you can call them from tRPC procedures, server actions or route handlers. Gate them with your own admin check.
