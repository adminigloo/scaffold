**Ask Lou: epics, staff ticket creation and column admin, with package designs for each**

Ask Lou root is `C:\Users\dalli\askLou\SquireSolutions`. Paths below are relative to it unless they name scaffold, Riddler Go or the testbed. Everything was read in code (the in-repo docs are stale). Anything not confirmed in code is marked INFERRED.

## Headline
- **Epics:** Ask Lou has a full epic system: a list page, a detail page, a picker in the drawer and on the full ticket page, an epic filter on the board, and assign/remove. But a board card never shows its epic. `EpicBadge` is never rendered anywhere, even though `listTickets` already returns `epicName`/`epicColor` (`src/server/api/routers/adminSupport.ts:400-403`). The Kanban card has no epic code at all.
- **Staff ticket creation:** there is no create action on the board itself. "New Ticket" is a link to a separate full page (`src/app/admin/support/board/page.tsx:947-953`, `src/app/admin/support/page.tsx:418-424`). The only in-context create is the per-group "Add ticket" modal on the epic detail page.
- **Columns:** they are edited only under Settings → Statuses, never on the board. The board's only link there is inside a migration-warning banner (`board/page.tsx:100-105`). Reorder is not possible from the UI: the drag handle is decoration and nothing calls `reorderStatuses`. Delete-with-tickets is guarded against a column that is never written. Renaming the slug strands every ticket in that column.
- **AdminIgloo is already ahead on column admin.** In `@adminigloo/feedback` the key can't be changed (`scaffold/packages/feedback/src/index.ts:955-973`). Delete counts the tickets actually in the column, by key (`index.ts:1040-1062`). New tickets land in the first non-terminal column (`index.ts:556-568`). What's missing is the UI, and an adapter so a foreign ticket table like Riddler Go's can use it.
- **No AdminIgloo package has epics or staff ticket creation.** The insert path and `nextTicketNumber` sit inside the `createFeedbackHandlers` closure (`index.ts:457-553`), so there is no exported `createTicket`.

## 1. Ask Lou epics

### Data model
- **Table `epic`** (`src/server/db/schema.ts:7138-7173`):
  - Fields: id, name (≤120), description, status (varchar: open | in_progress | completed | archived), ownerId (admin FK, nullable), targetDate (date), color (a fixed 10-name palette, default blue).
  - Stamps: completedAt, archivedAt, createdAt, createdBy, updatedAt.
  - The schema comment states the design: epic = "what goal", sprint = "when", tags = "what it touches"; a ticket has 0 or 1 epic (`schema.ts:7132-7137`).
- **Tickets** carry `support_ticket.epic_id`, nullable and indexed (`schema.ts:6172`, `:6190`).

### Lifecycle
- Allowed transitions (`src/server/api/routers/epic.ts:46-51`): open → in_progress/completed/archived; in_progress → open/completed/archived; completed → open/in_progress/archived; archived → open only.
- Stamps on change (`epic.ts:734-743`): completed sets completedAt and clears archivedAt; archived sets archivedAt; reopening clears the matching stamp.
- **Auto-bump** (`src/server/services/support/epicAutoBump.ts:12-49`): open → in_progress once any non-archived ticket's status is not "open" or "submitted". It's called from ticket create (`adminSupport.ts:1140-1142`), ticket update on a status or epic change (`adminSupport.ts:1726-1728`) and assignTickets (`epic.ts:782`).
- Nothing completes an epic automatically. The detail page shows a dismissible "All tickets are done. Mark Completed?" banner instead (`src/app/admin/support/epics/[id]/page.tsx:209-211`, `:368-396`).

### Progress
- The server buckets tickets by status name (`epic.ts:185-218`):
  - **Done:** terminal statuses from `feedback_status.isTerminal`, plus legacy resolved/closed/completed (`epic.ts:53-64`).
  - **Waiting:** waiting_customer, needs_info.
  - **Open:** open, submitted, new, triage.
  - **In progress:** everything else. This catch-all is deliberate; the comment at `epic.ts:209-215` records that it used to drop tickets.
- `EpicProgressBar` (`epics/components/EpicProgressBar.tsx`) is a stacked bar: done / in progress / waiting / open, labelled `resolved/total (pct%)`.

### Health
`computeEpicHealth` in `epics/components/EpicHealthDot.tsx:44-70`, computed in the browser:

| Health | Rule |
| --- | --- |
| idle | 0 tickets |
| on_track | epic is completed or archived |
| at_risk | target date less than 7 days away (overdue included) and under 50% done |
| stalled | no ticket updated in 14 days |
| on_track | otherwise |

The "health" sort is a stand-in (updatedAt) on the server and re-sorted in the browser (`epic.ts:115`, `epics/page.tsx:158-173`).

### UI
- **List page** (`src/app/admin/support/epics/page.tsx`):
  - Inline create form: name, owner, target, colour, description (`:199-306`).
  - Filters: status chips, "My epics" (stored in localStorage, `:73`, `:104-120`), include archived, sort (`:308-359`).
  - Table: health dot, name, status, owner, progress, "Nd left/over" (`:374-519`).
  - Row actions: complete, archive, restore, delete (disabled while the epic has tickets) (`:457-513`).
- **Detail page** (`epics/[id]/page.tsx`):
  - Click-to-edit name and description (`:236-330`), status select (`:270-287`), "copy summary" (`:288`), big % plus target countdown (`:332-365`).
  - "Assign existing tickets" opens `AssignTicketsModal` (`:398-409`).
  - Tickets grouped Open / In Progress / Waiting / Done, each group with "+ Add ticket" and a per-ticket "remove from epic" X (`:411-486`).
  - Sidebar: owner, target date, colour, metadata, archive/restore/delete (`:489-651`).
- **Board integration:**
  - **Card shows its epic? No.** `KanbanCard.tsx`, `KanbanColumn.tsx`, `SwimlaneBoard.tsx` and `board/types.ts` contain no epic references.
  - **Filter the board by epic? Yes.** A multi-select with a "Unassigned (no epic)" option (`board/components/BoardFilters.tsx:266-280`). It is stored in the URL as `?epic=` (`board/hooks/useBoardFilters.ts:112`, `:282-285`), split into `epicIds` plus `epicIdIsNull` (`board/page.tsx:307-317`) and OR-ed on the server (`adminSupport.ts:313-325`). Only open and in-progress epics are offered (`board/page.tsx:166-174`).
  - **Assign from the drawer or ticket page? Yes.** `EpicSelect` (search, a "Recent" group, "Create new epic" inline) sits in `TicketDrawer.tsx:640-663` and `[ticketId]/page.tsx:1319-1322`. The list view has an inline native `<select>` (`src/app/admin/support/page.tsx:822-859`).
  - **From the card itself? No.**
- **`AssignTicketsModal`** (784 lines):
  - Tabs: unassigned (default), recent (30 days), all.
  - Status, priority, category, assignee, company, submitter and page filters; typed search ignores every filter (`epic.ts:393-399`, `:433-435`).
  - Paste a list of ticket ids or numbers; capped at 500 with a "showing X of Y" warning (`AssignTicketsModal.tsx:141-167`).
  - Tickets already in this epic are pre-checked (`:169-180`).

### Lessons and bugs in code
1. **Bucketing by status name keeps breaking.** Both the server comment (`epic.ts:209-215`) and the detail page comment (`[id]/page.tsx:47-54`) record tickets vanishing or counts disagreeing. It still disagrees for a custom terminal status: the counts check the terminal set first (`[id]/page.tsx:161-164`), but the grouped lists use names only (`:143-149`, `:72-79`). A ticket in such a status is counted "done" but listed under "In Progress".
2. **Auto-bump hardcodes the default column names** "open" and "submitted" (`epicAutoBump.ts:35-36`). The default status is configurable (`src/server/services/defaultTicketStatus.ts:10-29`). INFERRED consequence: with a renamed default column, every new ticket in an epic bumps it to in_progress straight away.
3. **An epic holding only archived tickets can't be deleted.**
   - The list count and the delete button's disabled state exclude archived tickets (`epic.ts:156`, `epics/page.tsx:502`).
   - The server's delete check includes them (`epic.ts:676-687`).
   - The detail page hides archived tickets (`epic.ts:303`), so you can't remove them either.
   - The detail page's Delete also navigates away before the request returns (`[id]/page.tsx:635-639`), so the refusal is never seen.
4. **"Me (default)" in the create form makes an unowned epic.** The option sends `ownerId: null` (`epics/page.tsx:224`, `:229`, `:292`). The server only defaults to the creator when the field is `undefined` (`epic.ts:582-583`). "My epics" then hides those epics. Quick-create sends no owner at all, so it does get the creator (`EpicQuickCreateModal.tsx:231`). The two paths disagree.
5. **The picker can't show a completed epic.** `EpicSelect` only loads open and in-progress epics (`EpicSelect.tsx:24-29`), so a ticket on a completed epic shows "No epic" (`:63`, `:103-105`) unless that epic happens to be in Recent. The list page fixed this by re-adding the current value (`support/page.tsx:844-852`); `EpicSelect` never got that fix.
6. **Creating an epic from the drawer saves the ticket twice.** `EpicSelect` calls `onChange(id)` and then `onCreated(id)` (`EpicSelect.tsx:195-199`), and the drawer's handlers for both fire `updateTicket` (`TicketDrawer.tsx:647-661`).
7. **The epic status select allows moves the server refuses**, for example archived → in_progress. The mutation has no error handler (`[id]/page.tsx:120-125`, `:270-287`), so it fails silently.
8. **`assignTickets` has blind spots.**
   - It doesn't check the target epic's status, so you can assign to a completed or archived epic (`epic.ts:767-780`).
   - It only adds: unchecking a pre-checked ticket in the modal does not remove it (`AssignTicketsModal.tsx:766-769`).
   - A ticket already in another epic is moved silently; the modal only labels "in epic" for the current epic (`:707-711`).
9. **"Recent epics" is built from the admin audit log** (`epic.ts:334-384`), which is Ask-Lou-specific.

## 2. Staff ticket creation in Ask Lou

### Entry points
- **"New Ticket" button** on the list and the board. It's a Link to the full page `/admin/support/new` (`page.tsx:418-424`, `board/page.tsx:947-953`). It isn't hidden by permission in the UI; only the server checks.
- **Epic detail, per-group "+ Add ticket"** opens `AddChildTicketModal` (`[id]/page.tsx:427-434`, `:666-678`).
- **Error detail, "Create Ticket"** links to `/admin/support?createFrom=error&errorId=` (`src/app/admin/errors/[id]/page.tsx:130-136`). Nothing reads `createFrom`, so the link is dead. `createTicketFromError` exists (`adminSupport.ts:1185`) but has no UI caller.
- **On the board:** no in-board modal, no per-column "+", no quick-add.

### Form fields (`src/app/admin/support/new/page.tsx`)

| Field | Notes |
| --- | --- |
| title* | required |
| description | |
| priority | low / medium / high / critical, default medium |
| category | 5 hardcoded values, default general (`:193-203`) |
| related company | |
| assignee | |
| epic | `EpicSelect` |

- On success it shows the ticket number with a copy button, plus "View" and "Create Another" (`:88-137`).
- `AddChildTicketModal` asks for title, priority, category (hardcoded), assignee (defaults to the epic owner) and description, and sets `epicId` (`AddChildTicketModal.tsx:8-15`, `:43-45`, `:159-166`).

### Server (`createTicket`, `adminSupport.ts:1046-1180`, permission `admin.support.create`)
- Ticket number is the last number + 1 (`:104-120`), with no retry. INFERRED: two simultaneous creates hit the unique index and one fails.
- Status comes from `getDefaultTicketStatus`: the active `isDefault` status, else the first active by sort order, else "open".
- `sprintId` is set to the active sprint (`:1067`, `:1089`); `createdBy` is the admin; source is "admin" (the schema default, `schema.ts:6148`).
- Done in one transaction: insert, status history, error link, audit log (`:1075-1135`).
- After commit: epic auto-bump, then the assignment-rules engine if there is no assignee (`:1137-1159`).
- There is no status input, so a ticket can't be created into a chosen column.

### Bugs
- **Hardcoded categories.** The server only accepts bug / feature_request / billing / general / data_issue (`adminSupport.ts:59`, `:1052`). The configured category list is bug, ui_fix, feature_request, performance, data_issue, question, billing, other (`src/server/db/seeds/feedbackDefaults.ts:186-250`). So staff can't file ui_fix, performance, question or other. And "general", the default, has no category row, so the drawer shows the raw key (`TicketDrawer.tsx:417`).
- **"+ Add ticket" ignores its column.** `presetStatus` is declared in the modal's props but never destructured (`AddChildTicketModal.tsx:22` vs `:26-32`). The server has no status field anyway. "+ Add ticket" on the Done group creates a ticket that shows up under Open.

## 3. Column (status) admin in Ask Lou

### Where it lives
Columns are edited at Settings → "Statuses" tab (`src/app/admin/settings/page.tsx:14-17`, `:67`), which renders `src/app/admin/settings/feedback-statuses/page.tsx`. Mutations require `admin.settings.edit`; reads require `admin.support.view` (`src/server/api/routers/feedbackConfig.ts:26`, `:102`, `:185`, `:281`, `:331`).

### Table `feedback_status` (`schema.ts:6285-6314`)
- name (slug, unique), label, description, color (named palette), sortOrder.
- isDefault, isTerminal, allowAiTransition, isActive.
- wipLimit, wipWarningThreshold.
- agingFresh/Warning/StaleHours.

Tickets point at a status by the varchar `status` = name. A `statusId` column also exists (`schema.ts:6156`) but is not the live reference.

### What can be changed

| Change | Status in Ask Lou |
| --- | --- |
| Add | Works. Slug is generated from the typed name (`page.tsx:123-135`); placed at max sort + 10 (`feedbackConfig.ts:125-132`). |
| Relabel / recolour / description | Works. |
| Default / terminal / AI flags | Works. Setting a default first clears the others, without a transaction (`:135-140`, `:225-230`). |
| WIP limit + warning threshold | Works, but only shown on the board, never enforced. No server code reads `wipLimit` outside `feedbackConfig`; `KanbanColumn.tsx:59-263` only renders a warning. |
| Aging thresholds | In the schema and the API, but not in the form (`page.tsx:56-66`, `:433-443`). |
| Active toggle | Works (`page.tsx:159-164`). |

### Broken guards
- **Renaming the slug strands tickets.**
  - The slug is editable and always sent on save (`page.tsx:141`, `:466-475`), and the server updates it with no follow-up on tickets (`feedbackConfig.ts:234`).
  - Tickets keep the old name. The board drops unknown-status tickets into the first column (`board/page.tsx:597-602`) and shows a "mismatch" banner (`:620-624`, `:966-971`).
  - That banner's fix button only knows three old mappings (`board/page.tsx:89`, `adminSupport.ts:71-75`).
- **Delete checks the wrong column.**
  - It counts tickets by `statusId` (`feedbackConfig.ts:287-298`).
  - `statusId` is only written by a one-off migration (`src/server/db/migrations/migrateFeedbackData.ts:94`); `createTicket` doesn't set it (`adminSupport.ts:1076-1091`).
  - So the guard misses every newer ticket. "Delete" is really a soft deactivate (`:300-304`), the same thing the Active toggle does.
- **Reorder doesn't exist in the UI.** The procedure exists (`feedbackConfig.ts:331-372`), but nothing calls it. The grip icon is decoration (`page.tsx:296`).
- **Nothing protects statuses the code depends on.** The workflow references kickback, testing, ready_to_deploy, completed, closed and in_progress by name (`src/lib/supportWorkflow.ts:15-32`), and any of them can be deactivated.
- **A duplicate slug** hits the unique index (`schema.ts:6310`). INFERRED: the user sees a raw database error.

The workflow gates (Testing → only Completed or Kickback; Closed can't be reopened) are Ask-Lou-specific (`supportWorkflow.ts:42-130`, `components/useStatusTransitionGuard.tsx:111-165`).

## 4. Package designs

### A. Column admin
Goes into `@adminigloo/feedback`, which already has the server half.

**UI (controlled components):**
- A `ColumnEditor` panel, plus optional in-board controls: a menu on each column header (relabel, colour, WIP, aging, terminal, move left/right, delete) and a trailing "+ Add column".
- Enabled only when the consumer passes `columnAdmin={{ onCreate, onUpdate, onDelete, onReorder }}`. Omit it and the board keeps fixed columns, which is also how you sell or hide the feature.
- On create, the key is generated from the label and never editable afterwards. Only the label is shown.
- Reorder with ↑/↓ buttons, as the overlay already does (`scaffold/packages/create-app/overlays/feedback-admin/app/admin/feedback/statuses/page.tsx:243`).

The overlay and testbed pages can't be shipped as-is: they import the app's own tRPC client and `@/components/ui` (`overlays/.../statuses/page.tsx:5-6`).

**Server / schema:**
- Keep the existing `createStatus` / `updateStatus` / `deleteStatus` / `reorderStatuses`.
- Add:
  - Run the reorder in one transaction (both Ask Lou `feedbackConfig.ts:342-350` and AdminIgloo `index.ts:1069-1074` do one update per column without one).
  - `deleteStatus(db, id, { moveTo })`: move the column's tickets, then delete.
  - An `isLocked` flag for keys the host's code writes. Locked columns can be relabelled but not deleted.
  - Optionally a `phase` field (todo / doing / waiting / done) so epic progress never needs names.

**Foreign-app adapter (Riddler Go):**
- The package's `deleteStatus` occupancy check reads the package's own `feedbackTickets` table (`index.ts:1052-1055`). Riddler needs to inject something like `tickets: { countByStatus(key), reassignStatus(from, to) }`. That means a factory such as `createStatusAdmin({ db, tickets })`, with the default bound to `feedbackTickets`.
- Riddler must:
  - Create the status table and seed its 4 keys (open, in_progress, resolved, closed; resolved and closed terminal).
  - Replace its hardcoded statuses: `statusEnum` (`riddler-go-kanban/domain/feedback/types.ts:19`), the `$type` union (`db/schema/feedback.ts:27`) and `BOARD_STATUSES` (`app/admin/tickets/board/board-view.ts:29-34`).
  - Make "is it done" read `isTerminal` instead of names (`lib/feedback/admin.ts:222`, `app/admin/tickets/board/page.tsx:30`).
  - Lock "resolved", because the sitemap audit writes it (`lib/audit/sitemap-audit.ts:415`).
- The status column is plain text with no CHECK constraint (`db/migrations/0000_dashing_jean_grey.sql` has none), so no column migration is needed.

**Leave out:** `allowAiTransition` semantics, the Testing/Kickback gates, the legacy-status migration banner, named Tailwind colour maps (AdminIgloo already takes any CSS colour).

### B. Staff ticket creation
Also `@adminigloo/feedback`.

**UI:**
- A controlled `NewTicketDialog`. Props: `statuses`, `categories`, optional `assignees` / `epics`, `defaultStatus`, and `onCreate(input) => Promise<{ ticketNumber }>`. Throwing keeps the dialog open with the draft, the same contract as the panel.
- Opened two ways on the board, both through `onCreate`:
  - A header "New ticket" button.
  - A per-column "+" that pre-selects that column. This is the thing Ask Lou meant to do and never wired.
- Title-only quick-add on Enter. After creating, show the number with a copy button and "create another".

**Server:**
- Pull a top-level `createTicket(db, input)` out of the handler closure, reusing `nextTicketNumber` and the retry on unique-index conflict (`index.ts:457-468`, `:499-552`).
- Input: title (required), description, priority, category (checked against `feedback_categories`, falling back to `DEFAULT_CATEGORIES` when the table is empty; never a hardcoded enum), optional status (must be an existing key; default = first non-terminal), assignee, epicId, optional reporter name/email for "filed on behalf of".
- Emits `ticket.created`.
- Schema: add `source` (widget | staff | api) and `createdBy` text.

**Foreign adapter (Riddler Go):**
- Its `onCreate` server action inserts into its own `feedback_tickets` and reuses `allocateNextTicketNumber` (`lib/feedback/submit.ts:52`).
- It must fill required columns a staff ticket doesn't naturally have: `submittedByKind` (host | participant | anonymous; it needs a "staff" value or a convention) and `pagePathname` (`db/schema/feedback.ts`, roughly lines 44 and 55).
- Gate it with Riddler's own admin check.

**Leave out:** company, auto-sprint, the assignment-rules engine, the error-log link, Ask Lou's audit log. Offer an `onAudit` hook instead.

### C. Epics
A new `./epics` entry plus board props; package boundary is decided in section 5.

**UI (controlled components):**
- `EpicBadge` on cards: the board takes `ticket.epic = { id, name, color }`.
- `EpicPicker`: search, recent (from a prop or localStorage), create inline. It must always be able to display the current value, even a completed or archived epic.
- `EpicProgressBar`, `EpicHealthDot`, `EpicList`, `EpicDetail`.
- `AssignToEpicDialog`: add and remove; label tickets that are in another epic and confirm before moving them.
- An "Epic" filter on the board with a "No epic" option.
- The ticket panel needs an epic slot with `onSetEpic`.

**Server + schema:**
- `feedback_epics` table: id, name, description, status, color (any CSS colour), owner (text, like `assignee`), targetDate, completedAt, archivedAt, createdAt, updatedAt, createdBy.
- Nullable `epicId` on `feedbackTickets`.
- Functions: `listEpics` (with progress), `getEpic`, create, update, `setEpicStatus` (Ask Lou's transitions and stamps), `setEpicMembership({ add, remove })` (refuses archived epics), `deleteEpic` (returns occupied with counts that include archived tickets; offers "detach all").
- One pure `epicProgress(tickets, statuses)` used by the list, the detail page and health, so they can't disagree. Done = `isTerminal`; not started = the landing column; everything else = in progress.
- Auto-bump to in_progress when a ticket leaves the landing column, called from move, create and membership changes.
- Health uses `lastActivityAt`. The package tickets table has no `updatedAt` (`scaffold/packages/feedback/src/schema.ts:126-206`); use the latest of statusChangedAt, the last message, and createdAt.

**Foreign adapter (Riddler Go):**
- It adopts the `feedback_epics` table and adds an `epic_id` text column to its own `feedback_tickets`.
- It provides `{ ticketsForEpics(ids) → { epicId, status, archived, lastActivityAt }[], setTicketsEpic(ids, epicId | null) }`.
- Riddler has `updatedAt` (`db/schema/feedback.ts`, about line 53) but no `archivedAt` or `statusChangedAt`. Its columns already carry `isTerminal`.

**Leave out:**
- Owner as an admin-user foreign key.
- "Recent epics" built from the audit log.
- The company / page / submitter filters in `getAssignableTickets`, which use MySQL-specific queries (`epic.ts:475-511`).
- Sprints.
- The status emoji map in `CopyEpicSummaryButton`, which is tied to Ask Lou's status names. A generic summary built from the progress buckets is fine.

## 5. Package map: options and decisions for you
- **Epics:** one option is to ship them as the `./epics` entry inside `@adminigloo/feedback` (same install, same key), turned on by props. The other is a separate `@adminigloo/feedback-epics` that depends on feedback. A separate package avoids nothing, because the board itself has to render the epic badge and filter. INFERRED: the "Kanban board is only partial" problem you raised mostly goes away if the board package ships every Kanban affordance (filters, create, columns, epics) and the README states clearly which props or entry points turn each one on.
- **Permissions:** Ask Lou shows buttons to everyone and relies on the server to refuse. The package UI should take `can: { createTicket, manageColumns, manageEpics }` so it can hide those controls.