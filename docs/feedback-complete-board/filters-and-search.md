# Ask Lou support board: filters and search, and a plan to port them into `@adminigloo/feedback`

Ask Lou's board has 8 multi-select filter dropdowns plus a sprint picker, an archived toggle and clickable stats cards. All filtering runs on the server. Filters are kept in the URL and copied to localStorage so they come back on the next visit. There are no saved views. Riddler Go's list filters are simpler and weaker. The package should take Ask Lou's approach and fix about ten of its rough edges, listed at the end.

All claims below come from reading code; nothing was run. Anything marked INFERRED I worked out from the code but did not see happen.

**File prefixes used below.** All Ask Lou paths are under `C:\Users\dalli\askLou\SquireSolutions\src\`.
- **BP** = `app\admin\support\board\page.tsx`
- **BF** = `board\components\BoardFilters.tsx`
- **UBF** = `board\hooks\useBoardFilters.ts`
- **FD** = `app\admin\support\components\FilterDropdown.tsx`
- **SC** = `board\components\StatsCards.tsx`
- **AS** = `server\api\routers\adminSupport.ts`
- **LP** = `app\admin\support\page.tsx` (the list page)
- **ULF** = `app\admin\support\hooks\useListFilters.ts`
- **RG** = `C:\Users\dalli\riddler-go-kanban\app\admin\tickets\page.tsx`

## 1. Everything the board's filters do

### The filters

Every dropdown uses the same `FilterDropdown` component (FD). It is multi-select, opens as a checkbox menu, shows a "x of y selected" header with All / Clear links, and can show a count next to each option.

| Filter | Control | Where the options come from | URL param | What the server receives |
|---|---|---|---|---|
| Status | FD, multi | Active statuses from the status config table (BP:1008) | `status` | `statuses`, split between the open-work query and the done query (BP:352-363) |
| Priority | FD, multi | Hardcoded low / medium / high / critical (BF:192) | `priority` | `priorities` |
| Category | FD, multi | Category config table (BF:204) | `category` | `categories` |
| Assigned To | FD, multi, with an "Unassigned" option | Active admins (AS:3273) | `assignees` | Admin ids, plus a flag to include or only show unassigned (BP:255-278) |
| Page | FD, multi | Distinct page paths, with numbers in the path replaced by `*` so `/x/123` groups as `/x/*`, plus counts (AS:3309-3334) | `page_filter` | Pattern match on the stored path (AS:284-287) |
| Company | FD, multi | Distinct companies that have tickets (AS:3354) | `company` | `companyIds` |
| Submitted By | FD, multi; values look like `admin:5` / `customer:9` | Admin submitters and customer submitters combined (AS:3367-3418) | `submitter` | Admin match OR customer match (AS:262-281) |
| Epic | FD, multi, with an "Unassigned (no epic)" option | Open and in-progress epics (BP:169-178) | `epic` | Specific epics OR no epic (AS:313-326) |
| Sprint | Its own single-select menu in the header: All / Backlog / active / planning / last 3 closed (BP:788-874) | Sprint list | **Not in the URL** (local state, BP:119) | Sprint id, or "no sprint" |
| Archived | Toggle button (BP:877-889) | n/a | **Not in the URL** (BP:118) | `excludeArchived` |
| Unassigned only | Hidden flag; only the stats card sets it | n/a | `unassigned=true` | `onlyUnassigned` |

### How filters combine
- **Within one field it's OR, across fields it's AND** (AS:206-357).
- Three fields allow "these OR none" in a single control: assignee + unassigned (AS:234-238), epic + no epic (AS:315-321), and admin + customer submitters (AS:277-279).
- **A non-empty search makes the server ignore every other filter** except "exclude archived" (AS:198-208, 342-355; ticket TKT-00291). It was added after a search for ticket 219 returned nothing because an assignee filter was still on.
  - The board greys out the dropdown row and shows "Filters ignored while searching" (BF:103-106, 164-176).
  - During a search it also turns off the done-columns query, to avoid showing duplicate cards (BP:337-346, 400).

### Search
- **Fields searched:** title, ticket number and description, as a case-insensitive "contains" match on the server (AS:342-350). `%` and `_` typed by the user are not escaped. Company, submitter, page and messages are **not** searched.
- **When it runs:** only on Enter or the Search button. There is no debounce and no search-as-you-type (BF:108-131).
- **Bug (INFERRED):** the search box's text is copied from the URL only once, on first render (BF:87). Restoring filters from localStorage happens *after* that render (UBF:131-169), and so does back/forward navigation. In both cases the board can be filtered by a search while the box looks empty. The list page avoids this with a "draft or committed value" pattern (LP:67-69).

### Sorting
- **The board has no sort control.** Both queries are fixed to newest first (BP:321-322).
- Dragging only changes a card's status. You can't reorder cards within a column (`KanbanBoard.tsx`:177-214).
- The list page lets you sort by clicking 6 column headers (LP:71-82). Priority is stored as plain text (`server\db\schema.ts`:6110), so sorting by priority is alphabetical (critical, high, low, medium), not by severity (AS:373, 410).

### What gets remembered
- The URL is the source of truth (UBF:100-129).
- Every change updates the URL and, after a 500ms pause, saves to localStorage under `supportBoardFilters` (UBF:171-214).
- On load, if the URL has no filter params, the saved filters are put back into the URL (UBF:131-169). A URL with filters always wins, so shared links work.
- **No per-user or server-side saved views exist.** A grep for saved views across `src` finds only a budget feature.
- Things that are **lost on reload:** Kanban/Swimlane mode, sprint and archived (all local state, BP:116-119).
- **The board and the list use different hooks, storage keys and URL param names** (`assignees` vs `assignee`, `page_filter` vs `pagePath`; UBF:6 vs ULF:6, 106-107). Switching between List and Board drops your filters.
- The list keeps company and submitter in local state, not the URL (LP:140-143).
- The board fires its ticket queries before saved filters are restored. That means an extra fetch and probably a brief flash of the unfiltered board on load (INFERRED). The list page waits for the restore (ULF:160, LP:221).

### Quick filters ("My tickets", etc.)
- These exist only as clickable stats cards (BP:736-756):
  - **Critical** toggles `priority=critical`.
  - **Unassigned** toggles the unassigned-only flag.
  - **Assigned to You** sets the assignee filter to the viewer's id, or clears it.
- The active one gets a ring highlight (BP:759-766).
- On the board, the two status cards look clickable but do nothing (BP:738-740, SC:100-103).
- "Assigned to me" stores the viewer's actual id, so a shared link means "assigned to admin 5", not "assigned to whoever opens it".

### Clear all
- The "Clear" button appears when any filter or a search is active (BF:149-160). It resets the URL and wipes localStorage (UBF:302-305).
- It does **not** clear sprint or archived.
- **Bug:** the unassigned-only flag isn't counted (BF:90-101). If the Unassigned card is the only active filter, there's no badge and no Clear button.

### Active-filter count and badges
- The Filters button shows how many fields have a selection (BF:90-99, 143-147). Search isn't counted in the badge, but it does make Clear appear.
- Each dropdown button shows the placeholder, the single selected label, or "N selected", with a blue border when active (FD:65-81).
- Option counts for status, priority, category and assignee come from one stats query that ignores the current filters (AS:799-947). So they are site-wide totals, not "how many you'd get". Page has counts; company, submitter and epic don't.
- The filter panel starts collapsed (BF:88).
- **The board has no removable filter chips.** The list page does, and greys them out during a search (LP:301-348, 640-673).

### Board vs swimlanes vs list
- One filtered ticket set feeds both the Kanban view (BP:585-607) and the swimlane view (BP:627-646), so filters behave the same in both.
- Empty columns shrink to a 40px vertical strip (`KanbanColumn.tsx`:119-174), so a status filter effectively collapses the other columns.
- The list is a separate page with separate filter state.

### Mobile (INFERRED from the CSS classes, not run)
- The 8 dropdowns sit in one row that doesn't wrap (BF:172-176). The header has about 9 controls in a row that doesn't wrap (BP:780-955). Both will be cramped or overflow at phone width.
- The dropdown menu is positioned once when it opens and isn't repositioned on scroll or resize (FD:39-44).
- The dropdown has no keyboard support: no arrow keys, no Escape, no ARIA roles (FD:47-57).
- Card quick actions only appear on mouse hover (`KanbanCard.tsx`:221-226).
- The stats card grid does adapt to screen size (SC:92), and so does the list page's filter grid (LP:491).

## 2. What is generic vs Ask Lou-specific

**Generic, worth porting:**
- Search.
- Status, priority and category multi-selects.
- Assignee, with Unassigned and a "me" option.
- Submitter as a kind-plus-id value. This maps directly to Riddler Go's host / participant / anonymous.
- Page path with dynamic segments grouped.
- Archived toggle.
- Epic with "no epic", once an epics package exists.
- Quick filters.
- URL plus localStorage persistence.
- Active count and Clear.
- The optional "search ignores filters" mode.
- Splitting open-work and done tickets into separate queries.

**Ask Lou-specific:**
- **Company.** These are Ask Lou's client companies. The package rows have a `tenantId` (`scaffold\packages\feedback\src\index.ts`:850), so company should be a filter the consumer defines, not a built-in one.
- **Sprint.** Only worth having if there's ever a sprints package.
- How admin vs customer submitters are stored.
- Legacy status name mapping and the migration warning banner (AS:69-99, BP:33-111).
- **Hardcoded done-status names** (AS:337). This is a bug: it should read the "is terminal" flag from the status table.
- Kickback/testing workflow gates, @mentions, and the Tailwind colour map.

## 3. Server-side or client-side filtering, and why

**Everything is filtered on the server.** The comments at BP:251-254 and BP:575-578 say why: filtering in the browser lost tickets that fell outside the top-100 result window.

How the board reads tickets:
- **Open work:** up to 100 tickets that aren't in a done status (the server allows at most 100; AS:140, BP:366-372).
- **Done columns:** up to 75 tickets (BP:375-380).
- The two results are merged and de-duplicated (BP:416-427).
- Both refresh every 15 seconds, and other browser tabs trigger a refresh when a ticket changes (BP:388-404, 566-573).

**Gap:** the server returns the total count (AS:496-501), but the board ignores it. With more than 100 matching open tickets, the extras are silently missing (INFERRED: nothing on the board page reads the total).

The same risk exists on our side:
- **The package:** `listBoardData` returns the newest 300 and takes no filter input (`scaffold\packages\feedback\src\index.ts`:817-868).
- **Riddler Go's board:** capped at 500 open/in-progress and 100 finished (`riddler-go-kanban\lib\feedback\board.ts`:28-30, 84-108).
- **Riddler Go's list:** loads the newest 200, then filters in the page code (RG:69, 98-118). Ticket #201 and older can't be found, and "X of Y" (RG:159) is out of 200, not the true total.

## 4. Stats cards and swimlanes

**Stats cards** (SC): the first two open statuses, Critical, Unassigned (open only), Assigned to You (open only) and New Today. Average resolution time is fetched but never shown.

**Not in the first port as cards.** They need a separate count query, the counts ignore the active filters, and the status cards do nothing on a board. Port the *quick filter* idea instead, as toggle chips in the toolbar (My tickets / Unassigned / Critical), with an optional count the consumer supplies.

**Swimlanes** (`SwimlaneBoard.tsx`, `SwimlaneRow.tsx`): one row per assignee by one column per status.
- Rows collapse (`SwimlaneBoard.tsx`:156-164).
- Every active admin gets a row, even with no tickets (191-202).
- Dragging only changes status; moving a card to another person's row does **not** reassign it (103-149).
- No bulk selection.

**Defer.** Add it later as a `groupBy="assignee"` option on `FeedbackBoard`. It matters for teams; in Riddler Go every ticket goes to one person.

## 5. Proposed package API

```ts
// @adminigloo/feedback/board (client)
export const NONE = "__none";   // "Unassigned" / "No epic"
export const ME = "__me";       // means the viewer, so shared links work for anyone
export interface BoardFilterOption { value: string; label: string; count?: number }
export interface BoardFilterDef<T = BoardTicketView> {
  key: string;                         // also the URL param name
  label: string;
  options: BoardFilterOption[];        // supplied by the app (enum, config table, distinct query)
  control?: "chips" | "menu" | "auto"; // auto: chips for 5 or fewer options, else a menu
  multiple?: boolean;                  // default true; OR within a field, AND across fields
  searchable?: boolean;                // search box inside long menus (pages, submitters)
  match?: (t: T, selected: readonly string[], ctx: { me?: string }) => boolean; // client mode only
}
export interface BoardFilterState { q: string; values: Record<string, string[]> }
export interface BoardQuickFilter { id: string; label: string; set: Record<string, string[]>; count?: number }

<BoardToolbar filters={defs} value={state} onChange={setState}
  quickFilters={[{ id: "mine", label: "My tickets", set: { assignee: [ME] } }]}
  searchPlaceholder="Search ticket #, title, page, submitter"
  searchDebounceMs={250}           // Enter applies immediately
  searchBypassesFilters={false}    // true = Ask Lou mode: chips greyed out + a notice
  resultCount={n} totalCount={total} truncated={bool}   // "Showing 500 of 812"
  onCreate={() => openNewTicket()} // "New ticket" button
  actions={<ArchivedToggle/>} theme="auto" />

useBoardFilters(defs, { persistKey?, url?: { read(): URLSearchParams; write(p: URLSearchParams): void } })
  // → { state, setState, toggle, set, setQuery, clear, activeCount, isReady }
filtersToSearchParams(state, defs) / filtersFromSearchParams(params, defs)   // pure; drops unknown keys and values
applyBoardFilters(tickets, state, defs, { me, searchFields })               // for client-side mode
```

**Design rules:**
- **No Next.js imports in the package.** The app connects the URL in about 3 lines: `read` = `useSearchParams`, `write` = `router.replace("?" + p, { scroll: false })`.
- **Gate queries on `isReady`.** This avoids the double fetch Ask Lou's board has.
- **One shared filter state for the list and the board.** Same param names, same storage key, so switching views keeps your filters.
- **Count everything in the badge**, and have Clear clear everything, including archived.
- **Show active-filter chips with a remove button.**
- **The toolbar wraps on narrow screens.** Chips scroll sideways; menus are bottom sheets or are positioned so they follow scroll. Menus support the keyboard and Escape.

**Changes to `FeedbackBoard`:**
- **New prop: `filter={{ state, defs, me }}`** (or `visibleIds`). When filtering in the browser, the board applies it *at render time*, after it has worked out each card's optimistic status.
- **Why that matters:** the 0.9.0 board drops pending moves and ticked cards for any id that disappears from `tickets` (`scaffold\packages\feedback\src\board.tsx`:828-836). If the app slices `tickets` itself, changing a filter mid-move loses the optimistic move.
- **Keep pruning ticked cards that leave the view.** This is better than Ask Lou, whose selection survives filter changes, so "Move to…" can move tickets you can no longer see (INFERRED from `KanbanBoard.tsx`:85, 358-361).
- **Add:** collapse empty columns while a filter is active, and a "N hidden by filters" note.

**Server half (`@adminigloo/feedback`):**
- Export `boardFilterSchema`: a zod schema with `q` capped at 200 characters and each field's values capped at 50.
- Extend `listBoardData(db, { filters, me, activeLimit, terminalLimit })` to build the query:
  - OR within a field, AND across fields.
  - `NONE` means "is empty"; `ME` becomes the viewer's id, passed in by the app.
  - Search is a case-insensitive "contains" with `%` and `_` escaped, over ticket number, title, page path, reporter name and email.
  - Done statuses come from the "is terminal" flag on the status table, not a hardcoded list.
  - Return `{ tickets, activeTotal, activeTruncated, terminalTotal }` so the toolbar can say "Showing X of Y".
- Apps with their own tables (Riddler Go) turn `BoardFilterState` into their own query, using `filtersFromSearchParams` in a server component.

**Rule for where filtering runs:** filter on the server whenever the read is capped. That always includes search, which must reach old tickets. Client-side `applyBoardFilters` is fine only for instant feedback over a set the server says is complete.

### How Riddler Go maps onto this
- **status:** options from `BOARD_STATUSES` (`board-view.ts`:29).
- **priority:** 4 options, shown as chips.
- **category:** 6 options (RG:26-34).
- **source ("From"):** host / participant / anonymous, as chips.
- **assignee:** `NONE`, `ME`, then staff from `listAssignableStaff`, as a menu.
- **search:** ticket number, title, page path, submitter name and email.
- **Gap:** Riddler Go's board rows don't carry `submittedByKind` or `assignedToUserId` (`lib\feedback\board.ts`:33-47 only has the assignee's name and email). The board read needs both before source and assignee filters can work.

## What Ask Lou does better than Riddler Go's list, concretely

1. **Multi-select within a field** (FD with an OR match). Riddler Go allows one value per group (RG:100-112).
2. **Filters on the server across all tickets.** Riddler Go filters the newest 200 in page code (RG:69, 98).
3. **Options come from data, with counts.** Riddler Go's statuses and categories are hardcoded arrays (RG:10-41) that will drift once columns become editable.
4. **Filters are remembered** after leaving the page (UBF:131-169). In Riddler Go, the sidebar link to `/admin/tickets` resets them.
5. **A collapsible panel with a count badge**, which saves room on a board. Riddler Go always shows 5 rows of chips.
6. **One-click quick filters:** Critical, Unassigned, Assigned to you.
7. **Page grouping** (`/x/123` → `/x/*`, AS:3315). Riddler Go's ids are uuids, so its pattern must cover those too (INFERRED).
8. **"These OR none" in one control** (assignee, epic), and submitter across two kinds of identity.
9. **Search can ignore filters,** and the UI says so.
10. **The same filtered set feeds the Kanban and swimlane views.**
11. **Done columns are a separate query,** so they don't use up the open-work cap.

## What Riddler Go does better (keep these)
- **A `me` token,** so shared links work for whoever opens them (RG:89, 105).
- **A truncation banner** (`riddler-go-kanban\app\admin\tickets\board\page.tsx`:46-50). Ask Lou's board truncates silently.
- **Filters are plain links and a GET form.** They work without JavaScript and with the back button.
- **Search covers page path and submitter.**
- **Visible chips for small option sets:** one click, no menu to open.
- **An "X of Y" count.**

## Don't copy from Ask Lou
- Separate filter state and URL param names for the board and the list.
- Sprint, archived and view mode kept only in local state.
- A separate unassigned-only flag next to the "Unassigned" assignee option.
- The search box that goes stale.
- Loading before saved filters are restored.
- Status stats cards that do nothing on the board.
- Option counts that ignore the active filters.
- Hardcoded done-status names.
- Ticked cards that stay selected after they're filtered out of view.
- Long menus with no search box.
- The dropdown with no keyboard support and a menu that doesn't follow scroll.
- Priority sorted alphabetically.