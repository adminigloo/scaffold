# @adminigloo/feedback

## 0.9.1

### Patch Changes

- On a phone, 0.9.0 widened the whole PAGE to the board's width (a 390px page
  became 1267px): the screen-reader-only column counts and aging words are
  absolutely positioned and had no positioned ancestor inside the board's
  horizontal scroller, so they escaped it. The fixed bulk bar then centred on
  that wider page, off screen. `.aib-root`, `.aib-col` and `.aib-card` are now
  `position: relative`; a browser test pins "the board scrolls sideways, the
  page never does" at 390px.

## 0.9.0

### Minor Changes

- The board, fixed from the outside in. Installed into an app it was not built
  with (Riddler Go), 0.8.0 needed a stylesheet of workarounds to be usable; 0.9.0
  needs none of them.

  **Fixes**
  - Moved cards no longer ignore the server. 0.8.0 kept every optimistic move
    forever, so a status changed elsewhere stayed hidden until the board
    remounted. Moves now show only until the `tickets` prop catches up — the
    server always wins — and a card moved twice before a refresh lands doesn't
    snap back a column.
  - The bulk bar is styled (its tokens resolved to nothing beside `.aib-board`)
    and `position: fixed` (0.8.0's sticky bar sat below the fold in common admin
    shells). Position it with `--aib-bar-bottom`, `--aib-bar-left`, `--aib-z-bar`.
  - WCAG AA throughout: `ink-faint` lifted to 4.5:1 in both themes; input edges
    at 3:1; no opacity on archived or busy cards; 44px checkboxes and bar
    controls; forced-colours (Windows High Contrast) support. A unit test now
    measures every text/background pair the stylesheet uses.
  - Keyboard: each card's title is a button (with `onOpen`) or a link (with
    `ticketHref`); Alt+←/→ moves a card a column and keeps focus on it; moves are
    announced in a live region; Alt+Arrow never reaches the browser's Back.
  - `TicketPanel` is a real modal dialog: focus in, Tab trapped, Escape closes
    (without stealing a stacked dialog's keys), focus returns to the card. Its
    callbacks' errors go to `onError` instead of becoming unhandled rejections.
    The Status select no longer sends a move per arrow key.
  - A ticket whose status matches no column shows in an "Unrecognised status"
    column instead of vanishing.
  - SSR: on React 19 the stylesheet renders with the component, so the first
    paint is styled.

  **Added (all optional)**
  - `FeedbackBoard`: `theme` (`auto` | `light` | `dark`), `onMoveError`,
    `ticketHref`; `onMoveMany` may resolve `{ failed: [ids] }` to roll back only
    those.
  - `TicketPanel`: `onError`, `formatTime`, `theme`.
  - Theming: every `--aib-*` token has zero specificity on `.aib-root` /
    `.aib-panel-layer`, so a plain host rule wins in either theme.
  - A README.

  **Changed defaults**
  - Columns share the width (`flex: 1 0 240px`, max 360px) instead of a fixed
    270px.
  - The bulk bar floats at the bottom of the window.
  - `drizzle-orm` and `zod` peers are optional (the board entry needs neither).

## 0.8.0

### Minor Changes

- 834bd84: Three reporter-flow fixes ported back from the source, plus a rate-limit seam:
  
  - A reply to a CLOSED (terminal) ticket now answers 409 instead of landing
    silently in a column no one watches — the reporter is told the ticket is
    finished and to file a new report, rather than believing they re-raised it.
  - A new ticket seeds the reporter's own submission as the first thread message,
    so opening "My reports → thread" shows their words instead of an empty
    conversation that reads as "never received".
  - A new ticket lands in the board's first non-terminal column (resolved from the
    configured statuses), not a hardcoded `"open"` a buyer may have renamed or
    removed — which would leave the ticket in no column at all.
  
  And an optional injected `rateLimit` on the write endpoints (submit/upload/reply).
  A no-op when omitted, so existing installs are unchanged; wired to a per-key/IP
  counter it answers 429. The client key authenticates a whole tenant's anonymous
  visitors, so without a limit one loop or one hostile visitor can flood tickets
  and blob uploads on the buyer's bill.
- 88a9fe0: Add an optional AdminIgloo license gate to the feedback intake and the assistant
  chat handler. Both take a new optional `license` option ({ key, publicKey, mode })
  and, only when it is passed with `mode: "enforce"`, answer 402 for a deployment
  that does not hold a valid license for the feature — before the feedback intake
  runs or the assistant stream opens. Omitted, or `mode: "off"` (the default a
  consuming app reads from `ADMINIGLOO_LICENSE_MODE`), behaviour is unchanged, so
  every existing install keeps working. Depends on the new `@adminigloo/license`.

## 0.7.0

### Minor Changes

- The serious board. Categories become rows the way statuses did in 0.5.0
  — the widget's dropdown is now an admin decision (`show_to_customer`),
  not a deploy, with the same occupied-delete refusal and the same
  immutable keys. Columns learn what kanban columns know: `isTerminal`
  marks where work is finished, `wipLimit` puts a count/limit on the
  header that turns amber at the line and loud past it, and two aging
  thresholds put a quiet dot on cards that have sat too long — aged from
  `statusChangedAt`, which every move now stamps, so a fresh column
  resets the clock. Tickets grow a soft archive (`archivedAt`/`archivedBy`)
  with `archiveTerminalTickets` sweeping every finished column in one
  statement, and the board component grows selection: provide
  `onMoveMany` and cards get checkboxes, columns a tri-state select-all,
  a floating bar appears, and dragging a selected card carries the whole
  selection. Without it, the board is exactly the board it was.

## 0.6.0

### Minor Changes

- The in-app inbox, and the first events that ring it. `@adminigloo/
  notifications` first release: durable per-recipient rows in the app's own
  database — `notify` fans out at write time (read-time fan-out re-answers an
  authorization question on every poll), reads are recipient-scoped in the
  where clause so a guessed id settles nothing, and `unreadCount` is its own
  query because the badge renders on every shell. Feedback 0.6.0 grows the
  producer side: an optional `onEvent` hook on `createFeedbackHandlers`,
  fired on `ticket.created` and `reporter.replied` — awaited so serverless
  cannot truncate the listener's write, caught so a broken listener can never
  fail the submit it announces. create-app rides along for the pin.

## 0.5.0

### Minor Changes

- The support console half-step: the board's columns become editable and the
  reporter's replies become visible without opening every ticket. Platform:
  `createStatus`/`updateStatus`/`deleteStatus`/`reorderStatuses` (a key is
  permanent — tickets reference it as text; deletion refuses while a column
  holds tickets and says how many), `markTicketRead`, and `listBoardData` now
  computes `hasUnreadReporterReply` per ticket in one grouped query — the
  board card wears a "reply" pill until the workspace is opened. One
  migration: `feedback_tickets.last_staff_read_at`. create-app: the feedback
  overlay's router grows the five procedures, the board page clears the pill
  by looking, the feedback-admin overlay gains `/admin/feedback/statuses`
  (the column editor) and the sidebar's Feedback group gains its entry.

## 0.4.1

### Patch Changes

- The glacier re-skin. Both embedded surfaces — the widget's `aif-` styles and
  the board's `aib-` styles — now carry their own complete token set as custom
  properties, including a dark theme decided by `prefers-color-scheme`: they
  render inside apps whose themes they cannot know, and a hardcoded white
  dialog in a dark host reads as a foreign object. Visuals move to the glacial
  teal brand accent (the FAB now wears it), softer radii, a real shadow scale,
  and status chips as pills. Class names are unchanged, so nothing consuming
  either surface needs to change.

## 0.4.0

### Minor Changes

- Reporter-side replies — the support loop closes. The platform mints a
  per-ticket reporter token at submit (`aft_…`, returned once, hash stored),
  and two new key-authenticated endpoints serve the follow-up: `POST
  /v1/thread` returns the ticket with its reporter-visible conversation
  (system messages withheld) and the board's configured status label; `POST
  /v1/reply` appends a reporter message attributed to the ticket's own
  reporter — the request body cannot claim a name. All failures on the pair
  answer one indistinguishable 404, so a client key is not an enumeration
  oracle. The widget grows a "My reports" view: reports this browser sent
  (localStorage, capability-model — no reporter accounts), each opening its
  thread with staff replies and a reply box. Against a pre-0.4 platform the
  widget degrades to exactly its old behaviour. Consumers need only the
  migration for `feedback_tickets.reporter_token_hash`; the staff board
  renders reporter replies with no changes.
