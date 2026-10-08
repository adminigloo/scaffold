# Where the AdminIgloo feedback and triage pieces live, and how to package them (as of 2026-10-08)

**The gap:** a buyer who installs only from npm gets the intake, the widget, the board, bulk move, the ticket panel and the server functions behind columns and categories. They do not get any admin screen. The queue page, the column editor, the category editor, the archive buttons and the support console exist only as create-app overlay pages or as testbed code. Filters, search, staff-created tickets and epics are not built anywhere. The marketing site describes the product as "one install" of `@adminigloo/feedback-widget`.

State checked: `@adminigloo/feedback` 0.8.0 (the 0.9.0 board rework is uncommitted in the scaffold repo and has no changeset yet) and `@adminigloo/feedback-widget` 0.3.0. The testbed uses `^0.8.0` / `^0.3.0`. Riddler Go pins exactly `0.8.0` (riddler `package.json:39`, ADR-0014:22) and imports only `./board` (`board-view.ts:1`, `TicketBoard.tsx:5`).

Abbreviations: **PKG** = `scaffold/packages/feedback/src`, **WID** = `scaffold/packages/feedback-widget/src`, **OV** = `create-app/overlays/feedback`, **OVA** = `create-app/overlays/feedback-admin/app/admin/feedback`, **TB** = `adminIgloo`.

## 1. The matrix

| Capability | npm package | create-app overlay | Testbed-only code | What an npm-only buyer writes |
|---|---|---|---|---|
| **Intake widget** | widget `.`: FeedbackProvider/Button/Modal (WID/index.ts:1-3). feedback `.`: `createFeedbackHandlers` (PKG/index.ts:359, routes 726-736). Tables in `./schema` (PKG/schema.ts:12,126,214) | OV route.ts:23-43; `components/FeedbackWidget.tsx`; `scripts/issue-feedback-key.ts` | TB route.ts adds rateLimit (:44-53) and onEvent (:57-73) | Route handler, migration, `storeFile`, a way to issue a key (no script ships in npm), provider mount, `.npmrc` registry auth |
| **Screenshot + annotation, click trail, errors** | widget (AnnotationStage, recorder); upload handler PKG/index.ts:425-454 | OV route wires Vercel Blob | — | `storeFile`. It must be Vercel Blob: screenshot URLs are pinned to `*.public.blob.vercel-storage.com` (PKG/index.ts:134-144). An S3 `storeFile` makes the whole submit fail with 400 "invalid payload" (index.ts:482-485). The README (:185) says S3 works. |
| **Reporter replies / My reports** | widget My reports (FeedbackModal.tsx:56); `/v1/thread` and `/v1/reply` (index.ts:734-735); `addTicketMessage` (:1396) | OV router `addMessage` (:135) | — | One staff endpoint calling `addTicketMessage`, wired to the panel's `onSend` |
| **Staff queue list** | **None.** No list function is exported; `listBoardData` is shaped for the board and capped at 300 rows (index.ts:868) | OVA/page.tsx (208 lines) plus a raw Drizzle `list` in OV router (:50-82) | TB adds thumbnails and an error_log cross-reference (TB routers/feedback.ts:78-134) | The whole page and its query |
| **Kanban board** | `./board` FeedbackBoard (board.tsx:800), `listBoardData` (index.ts:817), `moveTicket` (:1093) | OVA/board/page.tsx (163 lines) | Demo board (`components/feedback-demo/demo-board-core.tsx`) | The page, two endpoints, the auth gate, refetching |
| **Bulk move** | `onMoveMany` prop (board.tsx:129-137); `moveTickets`, capped at 200 (index.ts:1118) | Wired in OVA board page | — | One endpoint |
| **Ticket panel** | `TicketPanel` (board.tsx:446, props 401-434); messages, assign and mark-read functions | Wired, but **without `detail`** (OVA/board/page.tsx:120): create-app panels show no report text, context or errors | TB has a `ticketDetail` query (routers/feedback.ts:149) and passes `detail` (board/page.tsx:50-64,140) | Five endpoints plus the detail query. No exported function fetches `TicketDetailView`. |
| **Columns editor UI** | Server functions only: `createStatus`, `updateStatus`, `deleteStatus`, `reorderStatuses` (index.ts:975-1078) | OVA/statuses/page.tsx (295 lines) | TB copy is identical | The whole editor. A buyer with its own tables, like Riddler, can't use the functions at all: they write `feedback_statuses`. |
| **Categories editor UI** | Server functions only (index.ts:1226-1356) | OVA/categories/page.tsx (247 lines) | TB copy is identical | The whole editor |
| **WIP limits / aging** | Drawn by the board from status fields (board.tsx:23-33; schema.ts:72-79) | Set in the statuses editor | — | The editor, or SQL |
| **Archive** | Archive, unarchive and archive-terminal functions (index.ts:1149-1205); `archivableCount`; panel `onArchive` (board.tsx:423,605) | "Show archived" and "Archive done (N)" buttons are **page code** (OVA/board/page.tsx:63-86) | — | The toolbar buttons |
| **Filters / search** | **Not built.** No props for them (board.tsx:109-145). `listBoardData` takes only `includeArchived`, capped at 300. | Not built | Not built | Everything. Riddler has list-page chip filters as its own app code (riddler `app/admin/tickets/page.tsx:43-139`). |
| **New ticket by staff** | **Not built.** Ticket insertion is private to `handleSubmit` (index.ts:470), along with `nextTicketNumber` (:457) and `resolveInitialStatus` (:562) | — | — | Everything. The only way a ticket gets created today is through the widget. |
| **Epics** | **Not built.** No table among the 5 in schema.ts, no functions. The roadmap slotted epics for 0.8.0; 0.8.0 shipped the license gate and reporter fixes instead (CHANGELOG.md:3-30). | — | — | Everything |
| **Assignment** | `assignTicket` (index.ts:1421); free-text assignee input (board.tsx:589-598); card chip (:1156). No user picker. | Wired | — | Endpoint, plus any staff directory |
| **Notifications** | `onEvent` hook with `ticket.created` and `reporter.replied` (index.ts:262-277,297); `@adminigloo/notifications` is a separate package | **Not wired**, even with `--notifications`. cli.ts:443-449 just tells you to wire it. | TB route.ts:57-73 calls `notifyStaff` | The listener |
| **License gate** | `license` option (index.ts:314-318,378-381). It gates the **intake only**; the board and server functions are ungated. | Not wired | Not wired | Passing the license config. Revoking keys: `revokeClientKey` (index.ts:100) has **no caller anywhere** (the estimator, by contrast, has an issue/revoke UI at TB app/admin/estimator/page.tsx:133-134). |
| **Support console** (marketed) | None | Placeholder only (admin-full/app/admin/support/page.tsx, 29 lines) | TB app/admin/support/page.tsx (200 lines) | Everything |

## 2. Where marketing promises more than an npm-only buyer gets

1. **"One install" is not one install.** The registry entry says `pkg` is `@adminigloo/feedback` (src/features/registry.tsx:102) but the install line is `npm install @adminigloo/feedback-widget` (:120), shown under the label "One install" (FeatureView.tsx:135,144-147).
   - The same line appears on the homepage (pillars.tsx:53) and in the closing section (closing.tsx:36). Its three steps end with "Tickets appear in your admin."
   - The widget alone posts to an intake the buyer does not have. The real minimum is 2 installs, which pull 3 more packages transitively (db, env, license; ADR-0014:18), plus a route, a migration, key issuance and admin pages the buyer writes.
2. **Editable columns.** "columns you define" (registry.tsx:109), "admin-editable columns" (:115) and "statuses you define" (pillars.tsx:49). npm ships the CRUD functions; the editor exists only in the overlay.
3. **Archive Done.** "Archive Done sweeps every finished column in one click" (registry.tsx:117). The button is overlay page code; npm ships only the function and the count.
4. **Key revocation.** "revoke the key and the widget goes dark" (registry.tsx:118). Nothing anywhere revokes a feedback key, so the buyer would have to build it or use SQL.
5. **Support console.** "Support console — one shift-start screen over tickets and errors" (pillars.tsx:51) and "support consoles" (hero.tsx:66). It exists only in the testbed; create-app ships a placeholder.
6. **Marked-up screenshots.** Promised at registry.tsx:114 and pillars.tsx:47, but they work only on Vercel Blob. The README's "Blob/S3" (:185) is wrong.
7. **"License key from your order"** (closing.tsx:41). INFERRED mismatch: the widget's `aik_` key is minted from the buyer's own database. The AdminIgloo license is a separate token and nothing wires it.

Nothing on the site promises filters, search, epics or staff-created tickets. Those are gaps, not misstatements.

## 3. Drift found along the way

- **Panel shows no report in create-app projects.** The overlay board page never got the testbed's `ticketDetail` query or the `detail` prop.
- **Archived tickets still appear in the queue.** The overlay `list` doesn't exclude them, although schema.ts:181-183 says archived tickets leave the queue.
- **README signature is wrong.** README:191 shows `issueClientKey(db, tenantId)`; the real signature takes `{tenantId, label}` (index.ts:85-88).
- **No changeset for the 0.9.0 work.** CI's changeset-coverage step (ci.yml:81-86) will fail when it is pushed.
- **API-change check covers 18 of 32 packages.** `break-check.config.json` is missing assistant, booking, analytics, license and others. This is evidence that each extra package already costs maintenance that isn't keeping up.

## 4. Packaging options

| | **A: one staff package with more entry points** | **B: separate packages** (`feedback-board`, `feedback-epics`, …) | **C: one meta-package** |
|---|---|---|---|
| npm-only buyer | Installs `feedback` + `feedback-widget` and gets everything; entry points keep each import small | 3-5 installs, and it is easy to end up with a partial board — the outcome you called "weird" | One install line, but it fixes none of the missing UI |
| create-app buyer | Overlay pages shrink to thin wrappers; still the single `--feedback` answer | New version pins per package (versions.ts drift test); answers.ts:259 grows; probably new flags | One more pin |
| Release overhead | One changeset and one CHANGELOG | Per package: changeset, CHANGELOG, version pin, API-check entry (already lagging), registry access | A third package bumped on every feedback or widget change. tsup strips `"use client"`, so client re-exports need banner configs. |
| Registry auth (401 risk) | Nothing new | Same scope and token, so no new 401 setup. INFERRED: each new GitHub Packages package must be readable by the buyer's token, or that one package fails with 403/404. | Same as B, for one package |
| Epics fit | Natural: `epic_id` on `feedback_tickets` in the same schema | Poor: a package can't add a column to another package's table, so it would need a join table | — |
| Existing users (testbed, Riddler) | Nothing forced. Everything new is opt-in props or new entries; `./board` is unchanged. | Riddler and the testbed (board page, two demo-board files) rewrite imports and add dependencies, unless shims are kept | Nothing forced |

**Recommendation: A.** Keep exactly two packages, split by where the code runs. That is the existing deliberate rule (answers.ts:253-258):

- **`@adminigloo/feedback-widget`** stays as-is: the reporter side.
- **`@adminigloo/feedback`** holds everything staff-side:
  - **`.` (server):** add `createTicket` (pulling ticket numbering and first-column logic out of `handleSubmit`), a ticket-detail fetch, a filtered list, and epics functions.
  - **`./schema`:** add an epics table and `feedback_tickets.epic_id`.
  - **`./board`:** add an opt-in toolbar with search, filter chips, a new-ticket button, show-archived and archive-done. Filters need a server-side path because the board loads at most 300 tickets.
  - **New `./admin`:** the columns and categories editors, built on an adapter object the way `@adminigloo/booking-widget/admin` already is (admin.ts:1-13; the testbed mounts it in 72 lines at app/admin/calls/page.tsx). That lets apps with their own tables use them.
  - **`./epics`:** the epics UI.

If epics should be a paid upgrade, gate it with a license feature (`feedback.epics`) rather than a separate package. The license token already carries a `features[]` list (license.ts:147-148).

To give buyers the clear map you asked for, keep one "what's in the box" table (proposed: generated from a manifest in the package). It would feed the README, a new `includes` field in the registry (with the install line fixed to both packages), and finer create-app capability keys (`feedback.board`, `.columns`, `.categories`, `.filters`, `.epics`, `.staff-create`). Each row says either "npm entry X" or "create-app page only".

Proposed install recipes:

| Who | npm installs | Entries used | Still yours to wire |
|---|---|---|---|
| Board over your own tickets (Riddler) | `feedback` | `./board` (+ `./admin` with an adapter) | Mapping your rows to the board, callbacks, and somewhere to store statuses |
| Full platform, npm only | `feedback` + `feedback-widget` | `.`, `./schema`, `./board`, `./admin`, `./epics` | Route, migration, `storeFile`, key, one thin page per screen |
| create-app | `--feedback` with an admin shell | all | Nothing |

What each existing project would change under A:

- **Riddler Go:** nothing until it chooses to upgrade. Bumping the exact pin turns on the toolbar. Column editing additionally needs a statuses table in Riddler, because statuses are hardcoded today (domain/feedback/types.ts:19, board-view.ts:29-34). That is app work under any of the three options.
- **Testbed:** bump explicitly (`^0.8.0` won't pick up 0.9), then optionally replace its 295- and 247-line editor pages with `./admin` wrappers.
- **create-app:** bump versions.ts:125, turn the overlay pages into wrappers, and port the `ticketDetail` fix.