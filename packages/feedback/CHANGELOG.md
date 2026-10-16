# @adminigloo/feedback

## 0.12.0

### Minor Changes

- d06cde5: Epics (0.12.0), included in the package: a company's bigger pieces of work, each with its tickets and its progress, on the board's own routes and keys.
  
  - **The data:** `feedback_epics` (the company on every row: name, what it's for, status, who leads it — one of `listPeople` — a "done by" date, one of ten colours, completed/archived stamps) and `epic_id` on tickets; columns gain `is_waiting` ("Waiting on someone else", in the column editor). Ship `sql/feedback-0.12.0.sql` and `sql/upgrade-0.11-to-0.12.sql` (additions only, safe twice).
  - **The server:** `listEpics` (with progress), `getEpic` (with its tickets, archived ones included), `createEpic`, `updateEpic`, `setEpicStatus` (Ask Lou's moves; an archived epic only back to not started; the stamps follow), `setEpicTickets` (add and take out in one change — every id must be the company's or nothing changes; never into a completed or archived epic; says how many moved from another epic), `deleteEpic` (never refused: the tickets, archived ones too, stay and leave the epic). Every one takes the company; another company's epic is "not found".
  - **One progress rule, by the columns' flags** (`epicProgress`, in `epic-core`, shared by server and screens): done = a finished column, waiting = a waiting column, not started = the column new tickets land in, anything else in progress. The percent rounds down. `allDone` asks "mark it completed?" — nothing completes an epic by itself.
  - **It starts by itself** (not started → in progress) the moment one of its un-archived tickets leaves the landing column, whatever it's called: from a drag, a bulk move, a column delete, New ticket or the editor.
  - **The trail** gets "epic" lines: put in, moved from another, taken out, the epic deleted.
  - **Routes** (in `FEEDBACK_ADMIN_ROUTES`, on `feedback.view` / `feedback.manage`, so the plan check closes changes and keeps reading): `GET/POST v1/admin/epics`, `GET/POST v1/admin/epics/{id}`, `POST …/status`, `POST …/tickets`, `POST …/delete`; `epicId` on New ticket and the ticket edit, and `?epic=` on the board — each refusing another company's epic, ticket or person before writing.
  - **`./board`:** each card shows its epic's badge (Ask Lou's never did), the toolbar has an **Epic** filter with "No epic" and counts, the ticket panel and New ticket pick an epic from those still being worked on (the panel always shows the ticket's own, finished or not, and links to it), and `FeedbackWorkspace` takes `epicsHref` for its "Epics" link.
  - **`./epics` (new entry):** `FeedbackEpics` (the list: progress bar, status, owner, due words, views, New epic) and `FeedbackEpic` (an epic's page: its tickets grouped as its progress counts them, add tickets — labelled when they'd move from another epic — take out, a status picker offering only allowed moves, edit, delete that waits for the answer, the "every ticket is done" question), over `baseUrl` or any `FeedbackEpicsTransport`; and the pieces `EpicList`, `EpicDetail`, `EpicDialog`, `AddTicketsDialog`, `EpicProgressBar`, `EpicBadge`. Laid out for 390px.
  
  - After an independent review: an epic led by someone who has left the team can still be edited (the leader it has is no change, and shows as "(no longer on the team)"); a NUL character in any staff route's id is "not found", not a 500; one epic per name per company even when two are made at once (a unique index); a ticket's epic is a foreign key (ON DELETE SET NULL) and an add checks the epic in the same statement, so a delete at the same moment never leaves a ticket pointing at nothing; an archived ticket counts as done; reopening an epic whose tickets are under way lands on In progress; a refused change re-reads the epic; the list says what a Delete did.
  
  Not included: sprints, swimlanes by epic, an epic's health, per-person saved views.

## 0.11.0

### Minor Changes

- fd0b0fc: The complete board (0.11.0): filters and search, New ticket, editing with an activity trail, and the settings screens as package UI.
  
  - **Filters and search on the server**, in the same query as the company: status, priority, category ("No category" too), assigned to (a person, "Unassigned", and "Me" — whoever is asking), from (the feedback button, the feedback page, the team), and a date range. OR within a field, AND across fields, and the search (ticket number typed any way, title, report, reporter's name and email; case-insensitive, with `%`, `_` and `\` escaped) ANDs with them. `listBoardData(db, tenantId, { filters, viewerId })` answers `totalCount`, `matchCount`, `truncated` and per-option `facets` (counted with the other filters on), and reads finished columns separately (100) from unfinished ones (300) so a busy Done never pushes open work off. `boardFilterSchema`, `filtersFromSearchParams` / `filtersToSearchParams`, `FILTER_NONE`, `FILTER_ME`. The board route reads the filters from its query.
  - **`./board`: `BoardToolbar`** on Ask Lou's support-board model — a search box (debounced, Enter at once, never stale), a multi-select dropdown per field with counts (Escape, arrow keys, a bottom sheet on a phone), quick filters Mine / Unassigned / Critical, the active filters as removable chips, Clear (archived included), "Showing X of Y" and a note when matches are past the caps. **`useBoardFilters`** keeps them in the page's address (other parameters untouched) and remembers them per browser; `isReady` holds the first load until they're back. `FeedbackWorkspace` wires all of it.
  - **New ticket, by the team:** `createStaffTicket` and `POST v1/admin/tickets` (source "staff", `created_by`), numbered in the company with the intake — race-safe, now retried up to 25 times (a burst of 20 at once gets 20 numbers). `NewTicketDialog`, a **New ticket** button and a **+** on each column that lands it there.
  - **Editing and the trail:** `updateTicket` and `POST v1/admin/tickets/{id}` change title, priority, category and assignee, checked before anything is written; every change, move, archive and arrival is a line of the ticket's activity trail (`feedback_ticket_events`, with the company on every row; `listTicketEvents`, `GET v1/admin/tickets/{id}/events`), shown in the panel in words. `listPeople` on the staff handlers (and `GET v1/admin/people`) gives the assignee picker the company's people; an assignee id of anyone else is refused.
  - **`./admin` (new entry):** `ColumnEditor` (add, rename, colour, reorder, finished, limits and aging; deleting a column with tickets asks which column they go to — `deleteStatus(…, { moveTo })`), `CategoryEditor`, `KeysPanel` (feedback page address, website keys: make, see once, switch off) and `FeedbackSettingsPanel`, over the routes by `baseUrl` or any `FeedbackSettingsTransport`.
  - **Column and category reorders run in one statement.** Tickets gain `assignee_id`, `source` and `created_by`; ship `sql/feedback-0.11.0.sql` and `sql/upgrade-0.10-to-0.11.sql` (additions only, safe twice).
  - After an independent review: the Assigned-to counts always equal their result (one rule for both), and names typed as assignees in 0.10 are linked to the matching person (`linkTypedAssignees`) or kept as their own "(not linked)" choice; a ticket the team files for a customer is emailed only on "tell them", in words for a request the team opened (`feedback_team_ticket_reply` / `_status`), and the reply box says who reads a reply; a taken short name gets a number ("open_2") so only a duplicate name is refused; defaults come once per company (`feedback_boards`) and the last column can't be deleted; deleting a column emits `ticket.moved` per moved ticket; NUL characters and dates outside 1970–2999 are a plain 400; New ticket checks the email address; settings forms lay out at desktop and phone widths; a disabled primary button is readable; a new ticket hidden by the filters says so; "Came in through" replaces "From".
  - The route table (`FEEDBACK_ADMIN_ROUTES`) carries the new routes and the board's filters with another company's values, so an isolation proof driven from it covers them.
  
  Not included: epics (the next release, in this package), per-person saved views, custom fields.

## 0.10.0

### Minor Changes

- 727041d: A feedback board for each company (Tenancy 2b-2a).
  
  - **Every staff function takes the company and only touches its rows.**
    `listBoardData(db, tenantId, …)`, `moveTicket(db, tenantId, …)`,
    `createStatus(db, tenantId, …)`, `listCategories(db, tenantId)`,
    `addTicketMessage(db, tenantId, …)` and the rest: another company's ticket,
    column, category or website key, asked for by id, is "not found". The
    signatures changed on purpose — a 0.9 call that compiled and read every
    company's board would be worse than a type error. Messages are reached
    through their ticket's company.
  - **Columns and categories per company.** `feedback_statuses` and
    `feedback_categories` have a company column (existing rows become `'*'`,
    the platform's own board — `FEEDBACK_PLATFORM_BOARD`), unique on (company,
    key). A company's board gets the default columns AND categories the first
    time it's used (`ensureFeedbackBoard`): idempotent, race-safe, and a column
    the owner deleted never comes back.
  - **Ticket numbers count per company**: each company starts at FB-00001,
    race-safe through the (company, number) unique index. Numbers now count past
    FB-99999 (0.9 compared them as text).
  - **The intake takes the company from the request** (`resolveTenant`), so a
    company's public feedback page needs no website key; a key sent under
    another company's address is "not found". `admit(tenantId, req)` closes a
    suspended or plan-ended company to NEW tickets (409 `feedback_closed` with
    the company's sentence, and `closed` in config) while its reporters can
    still read and reply. Plain-sentence errors (`{ error, code }`), and a
    screenshot's stored name no longer carries the company id.
  - **`createFeedbackAdminHandlers({ db, resolveTenant | tenantId, authorize, staffName, onEvent })`**:
    the board, the ticket panel (report, messages, reply, assign, move,
    archive, read), columns, categories and website keys over fetch, with
    `FEEDBACK_ADMIN_ROUTES` / `FEEDBACK_PUBLIC_ROUTES` (the routes as data, 2a's
    shape) for an isolation proof. Staff names come from the server, never the
    browser. New `createTicket`, `getTicket`, `listClientKeys`,
    `listColumnsWithCounts`; `revokeClientKey(db, tenantId, id)`.
  - **`feedbackPermissions`**: `feedback.view` (owner, admin, member, viewer),
    `feedback.manage` (owner, admin, member), `feedback.settings.manage` (owner,
    admin); crew none.
  - **Alerts**: `feedbackAlertKinds` (a customer sends feedback; a customer
    answers) to everyone who can see the board, and `feedbackAlertsFor`.
  - **Reporter emails**: `FEEDBACK_EMAIL_TEMPLATES` and
    `feedbackReporterEmailFor` for the team's reply and a ticket moving, from the
    new `staff.replied` and `ticket.moved` events. Events now all carry the
    company; `reporter.replied` carries the reply's id.
  - **`./board`**: `FeedbackWorkspace` (the board, toolbar and ticket panel
    connected to the staff routes by a base URL) and `FeedbackAdminClient`, so a
    company's page and the platform's page use the same component.
  - **Shipped SQL**: `sql/feedback-0.10.0.sql` and
    `sql/upgrade-0.9-to-0.10.sql` (exported as `@adminigloo/feedback/sql/*`).
    See "Upgrading from 0.9" in the README.
  - Tests run on PGlite (a real Postgres) instead of a fake database.
  
  Not included yet (2b-2b): server-side filters and search, a "new ticket"
  button for staff, column and category editors as package screens, epics.
  
  After review:
  
  - **Upgrading from 0.9 keeps your own board whole.** 0.9 had one board, so
    `sql/upgrade-0.9-to-0.10.sql` puts every 0.9 website key and ticket on `'*'`,
    your own site's board — whatever company id 0.9's issue-key script filed them
    under — so your feedback button keeps working and no company's board shows
    reports never sent to it. It moves them only on a 0.9 database; run again
    later, it moves nothing. The company column on columns and categories has no
    default after the upgrade (an insert that forgets the company fails).
  - **The open door on a company's feedback page, held to a size.** A hidden
    field (`website`) a person never fills refuses a scripted report;
    `createFeedbackRateLimit` (with `FEEDBACK_INTAKE_LIMITS`) counts per form and
    visitor, per visitor across every company, and a feedback page's whole day,
    and counts a request with no address as one shared visitor. A refusal says
    why in its own words (`FeedbackRateLimitDecision.message`).
  - **Screenshots.** A company's keyless feedback page takes none. The bytes
    must really be a PNG, JPEG or WebP image. A report keeps only screenshots
    THIS board's upload route stored (new `feedback_uploads` table), so no other
    store's address and no other company's picture; `sweepFeedbackUploads`
    deletes the ones no report used within a day. New `screenshots` seam (put,
    attach, remove; per board if a function), with `feedbackScreenshotPurpose`
    and `feedbackFileRecords` for keeping them privately on their ticket with
    @adminigloo/storage.
  - **A reply never shows a sign-in address as its sender**: an address-like or
    missing name is the business's name (`teamName`).
  - A report keeps only a category the board offers its customers.

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
