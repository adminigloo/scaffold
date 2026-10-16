# Tenancy 2b-1 (alerts and files): the contract

Tenancy 2a moved scheduling, the estimator, invoicing and messages into each
company. Two shared rails were left behind as Tenancy 0 primitives: an in-app
inbox nothing writes to (`@adminigloo/notifications` 0.1, staff-only, no
tenant) and a file table whose bytes are public forever (`@adminigloo/storage`
0.1, firm-wide, staff-only). Tenancy 2b-1 makes both a company's own: a bell
with THAT company's alerts for each person in it, each person's choice of how
they hear, one place where the owner says who hears about new work, alert
emails under the company's name, and private files a company keeps against
its visits, estimates and invoices, its logo uploaded rather than pasted, and
a Files screen that says how much room is left. Both rails install in an app
that is not ours (Ridgeline) from the README alone.

Five builders work from this document, mostly in parallel. None of them can
see another's code until the end:

| Builder | Owns | Sections |
| --- | --- | --- |
| **Alerts builder** | `packages/notifications` 0.2.0, `packages/notifications-widget` 0.1.0 (new) | 2, 3, 4, 5, 15.1 |
| **Files builder** | `packages/storage` 0.2.0, `packages/storage-widget` 0.1.0 (new) | 2, 3, 6, 7, 15.2 |
| **Field builder** | `packages/scheduling` 0.6.0, `packages/scheduling-widget` 0.3.0, `packages/estimator` 0.5.0, `packages/estimator-widget` 0.4.0 | 2, 3, 9, 10, 15.3 |
| **Platform builder** | `packages/tenancy` 0.6.0, `packages/tenancy-widget` 0.2.1, `packages/invoicing` 0.4.0, `packages/invoicing-widget` 0.1.1, `packages/comms` 0.4.0, `packages/comms-widget` 0.1.1 | 2, 3, 8, 11, 12, 15.4 |
| **create-app builder** | `packages/create-app` 0.24.0, the template and overlays, the e2e fixture and spec | 2, 3, 13, 14, 15.5, 16 |

Every builder reads sections 0–3 and 17–21. The create-app builder starts once
the other four have built their packages into `dist/` (section 18). Section 21
records the contract review (every critic's gap, accepted or rejected); the
accepted changes are already written into the sections they touch, so the
sections themselves are the spec.

Section 3 (the shared shapes) and the **wire regions** (sections 4.8, 6.10, 9.7 and 10.6)
belong to two builders at once: the package that serves a route and
the widget or the create-app wiring that calls it. If you change a name or a
shape there, the other half breaks and neither of you will notice, so don't.
Section 2 (decisions) binds everyone. Where something here is ambiguous, pick
the reading that best serves the acceptance bar in section 0, leave a
`// CONTRACT:` comment where you made the call, and list it in your hand-off.

The Tenancy 1 and 2a contracts (`docs/tenancy-1-contract.md`,
`docs/tenancy-2a-contract.md`) still bind. In particular 2a's D1 (the company
area is `/app/…`), D2 (the id in the path decides), D4 (features never import
tenancy; they take structural seams), D8 (a company's emails go out as the
company), D10 (crons iterate active companies), D11 (per-company setup,
insert-if-absent), D12 (no fixed tenant in a companies project), D16 (the
isolation proof drives the fetch handlers from route tables), and every
amendment in 2a section 18.

---

## 0. The acceptance bar

The founder's bar, in his words: *"Business owners aren't devs. If a business
owner is told by their dev that it works, they deploy it and sell it to a
customer; they need to trust that it's actually doing what is needed."*

The goal: the founder generates **"Igloo Back Office"**, a multi-tenant SaaS
for small service businesses (lawn care, ramps, cleaning), one company per
business:

```
pnpm dlx @adminigloo/create-app igloo-back-office --tenant-noun Company --admin full \
  --estimator --scheduling --invoicing --comms --email --storage --notifications --ai
```

and installs each package the way a client would. Tenancy 2b-1 is done when
this scenario runs end to end with no developer filling gaps. Section 15 holds
it as package tests, section 14 as the emitted proofs, section 16 as a browser
test.

1. **Alerts.** Green Acres' owner and staff each see a bell in the company
   area with THEIR company's alerts only, in plain words, each linking to the
   thing:
   - someone asks for an estimate (a new lead);
   - a customer accepts or declines a quote, or a quote lapses unanswered;
   - a customer asks for a visit (or books one);
   - a customer moves or cancels a visit;
   - a visit request is about to lapse unanswered, and one that lapsed;
   - a customer opens an invoice, an invoice is paid in full, an invoice goes
     overdue (what 2a records: `viewed_at`, a payment that settles it, the due
     date);
   - an email to a customer didn't go;
   - a teammate joined or left (or was removed).

   A crew member gets only alerts about their own crew's visits. Nobody gets
   the same alert twice: not from a retried request, not from an event handed
   to the listener twice, not from a cron that runs again, not from two tabs.
2. **Choices.** Each person chooses, per kind of alert, "In the app" or "In the
   app and by email". The owner sets who in the company hears about new
   estimate requests, visit requests and invoices: ONE place, replacing the
   per-feature "send new-request alerts to" lists of 2a, and the 2a office
   emails are routed through it, so a lead is never emailed twice. A new
   company gets lead and request alerts to its owner with zero setup. Alert
   emails go out under the company's name.
3. **Housekeeping.** A removed member stops getting alerts on their next
   request; a suspended company's alerts stop; old read alerts are cleaned up
   on a schedule; the bell's count is right on a phone (390 px) and on a
   desktop.
4. **Files.** The owner uploads the company logo (a file, never a pasted URL)
   in company settings. Staff attach photos and files to a visit (a crew
   member from their phone at the job), an estimate and an invoice. A
   customer's estimate photo is kept privately with the estimate. A company
   Files screen lists what is stored and says "Using X of Y" against a
   per-company allowance whose default the platform owner sets (plan limits
   arrive with the billing chunk, through the same seam).
5. **Files are private.** Served only through the company's signed-in screens
   or short-lived signed links, never at a guessable public path. Only the
   logo (and anything a purpose declares public) is public, under an
   unguessable key. An upload is checked for type (from its bytes) and size;
   deleting removes the stored object; a company can never read, list or
   delete another company's file by id or by key; a removed member loses
   access on their next request, through a signed link they made too, and a
   suspended company's links stop working.
6. **Single-business mode** (`--tenant-noun none`) keeps working, with the same
   features for the one business, its staff as the people.
7. **Foreign host.** Both packages install from their README alone into an app
   with its own sign-in and its own tables, including its own table literally
   named `notifications`: host seams for the company, the person and the
   permission; configurable table names (a prefix, the analytics 0.2 pattern)
   or a Postgres schema of their own, so nothing collides; shipped SQL for a
   host that doesn't use drizzle-kit; storage adapters for Vercel Blob, any
   S3-compatible store (R2, MinIO) and local disk for development.
8. **Proven.** The emitted isolation proof covers the alert and file routes:
   company B gets nothing for company A's alert ids, file ids, record ids or
   signed links, and no response ever carries a PRIVATE object's key (a
   public file's key is part of its public address, by design). A browser
   scenario with two companies walks steps 1–5 with in-memory email and blob
   capture.

### The founder's rules (non-negotiable)

- Screens and forms use plain words. Never "tenant", "slug", "blob",
  "recipient id", "dedupe", an id or a key. Say "company" (the project's
  noun), "web address", "alerts", "photos and files", "storage".
- Ask people only what they know. The owner picks PEOPLE from a list; nobody
  types a user id or a permission key.
- No AI in this chunk.
- Never raise legal, privacy or consent topics, in code, comments, copy or
  docs.
- Every package README states exactly which installs give what, and what is
  NOT included (section 17.2, verbatim).

### Hard rules (all builders)

- No commits, pushes or publishes, and no `changeset version` or release.
  Write changeset FILES (section 17.3). Don't edit any `version` field, except
  the two new widget packages, which are created at `0.0.0` and stay there.
- No dev server on port 3000. No real databases: PGlite only.
- Match the repo's style: thorough why-comments, decision-record comments
  where a choice was made, zod at every boundary, `tenantId` on every query,
  instants as `timestamptz`, errors with an own `readonly name`.
- create-app generator rules (`packages/create-app/README.md`):
  - **No runtime conditionals in emitted code.** No emitted `if` asks whether
    a feature or a mode is installed. Two variants of one file, chosen by the
    generator, are fine; so is a generated constant or array. A runtime filter
    on a generated list (a permission) is fine and says so in a comment.
  - Overlays are strictly additive.
  - `--tenant-noun none` keeps a single-business mode that works.
- UI a buyer needs ships as package components with a transport, so fixes
  flow by npm. Emitted pages are thin wrappers.
- Work only in `C:\Users\dalli\scaffold-t2b` (branch `feat/tenancy-2b`, from
  `feat/tenancy-2a` fd21975). Don't touch `C:\Users\dalli\scaffold`, any other
  `scaffold-*` worktree, or any `adminIgloo` folder.

### The workspace (state when this contract was written)

- `pnpm -r build`: **all 38 packages build** (exit 0), 2026-10-15.
- `node_modules` installed. **Don't install anything** beyond step 0 of
  section 18 (the two new widget packages, linked with `pnpm install
  --offline`; every dependency they need is already in the store). If
  something is truly missing, stop and say so.
- `e2e/` has its own `node_modules`; Playwright and Chromium are cached (2a).
- **Baselines** (this worktree, before any 2b-1 code; `npx vitest run` in each
  package):

  | Package | Tests |
  | --- | --- |
  | notifications | 6/6 |
  | storage | 11/11 |
  | tenancy | 351/351 |
  | tenancy-widget | 243/244 — `release.test.ts` fails: it reads the 2a changesets, which `changeset version` consumed (2a's baseline had the same failure for T1's). The platform builder rewrites it for 2b-1 (8.6). |
  | scheduling | 335/335 |
  | scheduling-widget | 252/252 |
  | estimator | 347/347 |
  | estimator-widget | 269/269 |
  | invoicing | 117/117 |
  | invoicing-widget | 112/112 |
  | comms | 153/153 |
  | comms-widget | 77/77 |
  | email | 188/188 (not changed by 2b-1) |
  | permissions | 74/74 (not changed) |
  | testing | 153/153 (not changed) |
  | create-app | 1755/1755 |

- If you change a package another imports from `dist`, rebuild it:
  `pnpm --filter @adminigloo/<name> build`. Build order:
  `comms → tenancy → invoicing → scheduling → estimator → notifications →
  storage → the widgets → create-app`. (On Windows a tsup DTS build sometimes
  fails right after an install; run that package's build again.)

### Prior art (lift the best)

- **This repo.**
  - `packages/notifications/src/index.ts` (0.1): fan-out at write time; reads
    scoped to the recipient in the WHERE clause; "notifying must never break
    the thing it announces". All three rules carry into 0.2.
  - `packages/storage/src/index.ts` (0.1): bytes first, receipt second, bytes
    taken back on a failed receipt; tenant in the WHERE of every read and
    delete; `sanitizeFilename` by character code. All carry into 0.2.
  - `packages/analytics/src/schema.ts` (0.2): `defineAnalyticsTables({ prefix })`,
    the default reproducing the old names exactly, the 63-character identifier
    rule, and the README's "under a prefix, export the prefixed tables by name".
  - `packages/audience/src/schema.ts`: its own uuidv7 so a schema import never
    loads `@adminigloo/db` (and the Neon driver with it, IF-19).
  - `packages/comms/src/index.ts`: the claim-by-update with an attempt guard,
    the stale-claim reclaim, "a skipped send is not a failure", the
    idempotency key handed to the provider. The alert email retry copies these.
  - `packages/estimator/src/photos.ts` and `image.ts`: the photo store seam
    (`put`/`delete`/`urlFor`), the magic-number checks, image dimensions from
    the header.
  - `packages/tenancy/src/server/profile.ts` `setLogo`: check the caller before
    storing anything; put outside the transaction; delete the old one after
    commit.
  - `packages/comms-widget`, `packages/invoicing-widget`: the transport that
    never throws, theme tokens, style injection, AA tests, the wire-parity test.
  - `packages/create-app/src/feature-proofs-emit.ts`: `suitesFor`,
    `company-rows.ts`, "nothing of A", the snapshot before and after, the
    negative control.
- **Ask Lou** (`C:\Users\dalli\askLou\SquireSolutions`):
  `src/server/utils/blob/privateBlob.ts` (a private Vercel Blob store, callers
  hold a pathname, never a URL; reads streamed through authorised code);
  `NotificationBubble.tsx` (a polling bell, 60 s); `cronFailureNotifier.ts`
  (email plus in-app, deduplicated).
- **trailcards** (`C:\Users\dalli\trailcards`): `ImageUploader.tsx` (client-side
  image work before upload), server-enforced type and size.
- **Riddler Go** (`C:\Users\dalli\riddler-go`): the per-organisation pages and
  the dedupe-key unique index on its email table.

### What this chunk answers

From `C:\Users\dalli\adminigloo-audit-2026-10\audit-verified.json` and
`minihorse-and-gate-spec.json` (S2 "Shared rails"):

| Finding / promise | Where |
| --- | --- |
| Blocker 8 "the notification inbox has no producer"; IF-01 | D3, D7, sections 8–12 (every 2a package produces), 13.6 (the glue wires every producer) |
| IF-04, SR-23 (staff-only, no tenant, one merged inbox) | D2, 4.1 (`tenant_id`), the bell reads the active company |
| IF-05 (no bell, no badge, no polling) | section 5 (`<AlertsBell>`, 60 s poll, cross-tab) |
| IF-06 (no preferences, email channel, catalog, retention) | D3–D6, D9, 4.2–4.6 |
| IF-07 (public-only files, no signed downloads) | D10, 6.7–6.8 |
| IF-08 (4 MB through serverless, no uploader) | D11 (4 MB kept, phones shrink first), section 7. Direct-to-store uploads: not included |
| IF-09 (no tenant UI, quotas, MIME policy, measured size) | D11–D12, 6.4–6.6, section 7 |
| IF-10, IF-V1, FB-16 (feedback screenshots bypass storage) | Not in 2b-1: 2b-2 puts them on these private files (17.2). Storage's purposes and records are the hook (6.4–6.5) |
| IF-18 (no READMEs) | 17.1 |
| IF-19 (fixed table names; `@adminigloo/db` loads Neon) | D14, 4.1, 6.2 |
| IF-21 (security claims asserted against fakes) | 15.1–15.2: PGlite for every read, write and cross-company case |
| CC-01 (no event contract, outbox) | D8 (decided: no outbox in 2b-1, why, and the keys that make one safe later) |
| ES-12 (the photo isn't kept with the estimate) | 6.9 (the estimator's photo store on private files) |
| S2 "a private upload gets a signed URL that works and expires; tenant B and anonymous callers get 404" | 6.8, 14.1 |
| S2 "the host's notifications, email_events and audit_log tables are untouched" | D14 (prefix or Postgres schema), 4.1, 6.2 |
| S2 "storage limit refused with a clear message" | D11, 6.6 (the allowance seam the billing chunk fills) |

---

## 1. What changes, in one page

| Package | Before | After |
| --- | --- | --- |
| `@adminigloo/notifications` 0.2.0 | Per-recipient rows, no tenant, free-text kinds, no preferences, no email, no handlers, no UI, `@adminigloo/db` | Rows per company per person with a dedupe key; an alert-kind registry composed from package fragments; per-person channel choices; company routing for new work; email copies through a host seam with retries (the recipient re-checked before each retry); claims for a producer's own office email, released back to the cron when it fails; reads filtered by what the reader may get NOW; cleanup; `forget` on removal, `prune` on a role change; `renderAlertEmail` for a host without comms; handlers, route table, permissions, wire; prefix or Postgres schema (required: never a host's own table by default); guarded shipped SQL; `./testing` (`checkHostSeams`); no `@adminigloo/db` |
| `@adminigloo/notifications-widget` 0.1.0 (new) | none | `./admin`: `<AlertsBell>`, `<AlertsInbox>`, `<AlertSettings>` and the transport |
| `@adminigloo/storage` 0.2.0 | Public files only, firm-wide, a two-method adapter, no handlers | Per-company files, private by default; a `BlobStore` with `get` and a private-store check; two stores (private, public); purposes (type and size rules, a share of the allowance); record types contributed by packages (attach to a visit, an estimate, an invoice); allowance and usage, with almost-full and full alerts; signed links re-checked against the person and the company on every open; keys that never carry a company id; delete removes the object from the store it is in (with a purge for a store that failed); moving 0.1/2a public photos to the private store; the logo store and a purpose store for the estimator's photos; handlers, route tables, permissions, wire; adapters `./vercel-blob`, `./s3`, `./local`, `./testing` (with `checkHostSeams`); prefix or schema (required); guarded shipped SQL; no `@adminigloo/db` |
| `@adminigloo/storage-widget` 0.1.0 (new) | none | `./admin`: `<RecordFiles>` (with the phone camera), `<FilesManager>`, `<UsageMeter>` and the transport |
| `@adminigloo/tenancy` 0.6.0 | Events without ids; logo store without the company; `listMemberPeople` lists everyone | Every event has `id` and `occurredAt`, member events name the person; `LogoStore` is told the company; `listMemberPeople(id, { holding })`; `tenancyAlertKinds` + `tenancyAlertsFor` |
| `@adminigloo/tenancy-widget` 0.2.1 | peer `^0.5.0` | peer `^0.6.0`; the release test rewritten |
| `@adminigloo/scheduling` 0.6.0 | Office notices to saved addresses or the inbox | `officeRecipients` seam (the one alert setting) and `officeSent` (a failed office email goes back to the alerts cron); office emails through `deliverNow`; `alertsHref` (the settings screen hands the list to Alerts); alert kinds + mappers; `listExpiringRequests`; file records (a visit); comms peer `^0.4.0` |
| `@adminigloo/scheduling-widget` 0.3.0 | | The alert list managed elsewhere; `initialVisitId` on the calendar; "Photos and files" links on a visit and on today's route |
| `@adminigloo/estimator` 0.5.0 | Lead alerts to saved addresses or the inbox | `officeRecipients`, `officeSent`; `alertsHref`; alert kinds + mapper; file records (an estimate); the photo purpose (counted, never refused for a full company, capped at its own share); a storage refusal answered as the estimator's own photo sentences; photos attached to their estimate in storage; comms peer `^0.4.0` |
| `@adminigloo/estimator-widget` 0.4.0 | | The lead-alert list managed elsewhere |
| `@adminigloo/invoicing` 0.4.0 | No events | `onEvent` (`invoice.viewed`, `invoice.paid`); `listOverdueInvoices` (newly overdue only); alert kinds + mappers; file records (an invoice); comms peer `^0.4.0` |
| `@adminigloo/invoicing-widget` 0.1.1 | peer `^0.3.0` | peer `^0.4.0` |
| `@adminigloo/comms` 0.4.0 | A failed send is only a log row | `onFailed` (a final failure); `deliverNow` (the row and whether a retry could help); `templateLabel`; alert kind + mapper |
| `@adminigloo/comms-widget` 0.1.1 | peer `^0.3.0` | peer `^0.4.0` |
| `@adminigloo/create-app` 0.24.0 | 0.1 inbox and file library: tRPC routers, staff-only pages, a producer nobody calls, public blobs | Both modes: alerts and files on the package handlers and widgets; the bell in the header; every 2a producer wired; office emails through the one setting (the owner's copies to the business email); team emails in their own sending allowance; logo, estimator photos and attachments on private files; local-disk files in development; Files screen; the alerts and files crons; isolation proof extended (role pass over the file routes); tRPC `notifications` and `files` routers retired |

Not changed: `email`, `permissions`, `trpc`, `auth`, `testing`,
`observability`, `db`, `feedback`, `feedback-widget`. (If a builder finds it
truly needs one, stop and say so.)

---

## 2. Decisions (binding on every builder)

Each is a decision record. Copy the reasoning into the code comment at the
place it is enforced.

**D1. Two pairs of packages: a server package and a widget each. The screens say
"alerts" and "photos and files"; the code keeps `notifications` and `storage`.**
- `notifications` / `notifications-widget` and `storage` / `storage-widget`,
  on Tenancy 1 D1's reasons: the server package is imported by server code
  with no React; the widget has React as its only peer, a transport and a
  host-following theme; UI fixes ship on their own version line.
- The package names stay (they are published 0.1 names, and permanent). The
  words a business owner reads are "Alerts" (a bell, "Alert settings") and
  "Photos and files" / "Files". "Notification", "blob" and "storage key" never
  appear on a screen.
- Permission keys are the words, not the package: `alerts.view`,
  `alerts.manage`, `files.view`, `files.manage` (2a's convention: `schedule.*`
  for scheduling, `invoices.*` for invoicing).

**D2. Fan-out at write time, per company, per person. A row is
(company, person, kind, dedupe key).**
- 0.1's first rule stands: "who should see this" is answered when the alert is
  written, from who holds what NOW, and the fan-out is never re-run on a poll.
  0.2 adds the company: `tenant_id` is on every row and in the WHERE of every
  read, mark and delete, beside `recipient_id`.
- **Reads narrow, never widen (review G4).** Each row records how it reached
  the person (`reached_via`: `audience`, `assigned` or `address`). Every read
  (`list`, the count, a mark) shows only rows whose kind the reader may get
  NOW: a row reached through the audience needs the kind's
  `audience.permission`, one reached through assignment needs
  `assigned.permission`. A runtime permission filter over a generated list,
  commented as such. So someone demoted from admin to Crew stops seeing the
  old lead alerts (with customers' phone numbers) on their next poll, whatever
  the host's role model, and a role change also prunes the rows outright
  (`prune`, D9).
- The bell shows the person's alerts in the ACTIVE company (the page's company,
  2a D2): someone in Green Acres and in Summit sees Green Acres' alerts while
  working in Green Acres. Alerts from their other company are not counted.
- An email-only address the owner added (an office mailbox that isn't a login,
  D4) gets a row too, recipient `email:{address}`, born read, so the same
  dedupe and retry rules cover it and no bell ever shows it.

**D3. Alert kinds are a registry composed from package fragments; each package
owns its words.**
- `defineAlertKinds({ kinds, routings })` fragments, composed per project by
  `defineAlertRegistry([...])` exactly like the permission and settings
  fragments, and refused at definition time on a duplicate or malformed key.
- Every 2a package exports, from its root and STRUCTURALLY (no notifications
  import, 2a D4), its fragment (`schedulingAlertKinds`, …) and a mapper from
  its own event to alert drafts (`schedulingAlertsFor(…)`, …). The title, the
  body and the dedupe key are written by the package that knows the fact, so a
  wording fix reaches every project by npm (create-app rule 3). The emitted
  glue only connects an event stream to `alerts.notify`.
- A kind key is permanent (stored on rows and on choices):
  `{package}.{thing}.{what}`.

**D4. Who gets an alert: a permission, optionally a routing group, optionally
the people assigned to the record.**
- Every kind names `audience.permission`: only active members holding it may
  receive it. The host answers "who holds it" (`people(tenantId, permission)`),
  so a foreign host's own roles decide.
- `audience.routing` names a ROUTING GROUP: the company's chosen people for it.
  Three groups exist, one per package that brings work in: **estimates** ("New
  estimate requests and quote answers"), **visits** ("Visit requests and
  customer changes") and **invoices** ("Invoices opened, paid or overdue").
  They are the bar's "who hears about new work", all on ONE screen (Alert
  settings). The default, with nothing saved, is **the owner** (the current
  owner: it follows a transfer). A saved list with no PERSON left on it
  (everyone on it left) is the owner again, in the app and by email per the
  owner's choice, while its extra addresses still get their copies: an empty
  list is never "nobody", and a lead is never only in a mailbox no bell shows
  (2a review T2A-BO-14; review BO-20). The owner may add up to five
  email-only addresses per group.
- **Where the owner's copies go (review BO-01).** While a group is on "The
  owner" (no row, mode `owner`, or the empty-list fallback), the owner's email
  copies of that group's kinds go to the host's `ownerEmail(tenantId)` when it
  answers an address, else to the owner's own. create-app answers with the
  company's business email from company settings (2a D8's `inbox`, kept), so
  a company whose office reads `office@greenacres.com` keeps getting leads
  there with zero setup, and Alert settings says so on the group's card.
- **Never nobody, for any host (review G13).** If the owner fallback finds no
  owner among the people holding the permission (a foreign host with no
  "owner" concept, a single-business project where no staff member holds the
  admin template), everyone holding the group's permission gets it, and
  `onError` is told once per draft (step `no-owner`).
- `audience.assigned` (scheduling's visit changes): the people ASSIGNED to the
  record (the person linked to the visit's crew) also get it, if they hold
  `assigned.permission` (`schedule.route`). A crew member holds
  `schedule.route` and no `schedule.view`, so this is the ONLY way an alert
  about a visit reaches them: their own crew's visits, nothing else.
- Whoever caused it (`actorUserId`) is never alerted about their own action.

**D5. Two channels per person per kind: "In the app" or "In the app and by
email". Each kind has a default.**
- A choice is stored only when someone makes one; otherwise the kind's
  `defaultChannel` applies, so a new company works with zero setup and a new
  kind gets its default everywhere.
- There is no "off" (the bar names two choices). Noise is kept down by the
  audiences of D4 instead: the routed groups default to the owner alone.
- Email is offered only when the host can send it (the `email` seam is given
  and `emailDelivery` says it is on), the kind allows it (`email !== false`:
  "an email didn't go" is never emailed), the kind's email isn't switched off
  where the host keeps its message wording (`emailDelivery`'s `offKinds`,
  D6), and the person has an address.
- Alert emails go out AS THE COMPANY (2a D8): through comms, From "{Company}"
  on the platform's address, the company's Reply-To (or the customer's, on a
  lead: 2a review T2A-BO-12), logged in the company's Messages, and held to a
  TEAM sending allowance of its own (60 an hour, 300 a day per company; review
  BO-10), never the allowance its customers' quotes and invoices use: the
  customer allowance exists to stop mail to strangers, and a morning of
  alerts to the company's own people must not hold a customer's invoice.

**D6. One email per alert per person. A producer's own office email IS the
email copy of its kind.**
- 2a's office notices (`estimate_lead_staff`, `quote_staff_notice`,
  `visit_staff_notice`) are rich (the lines, the range, the customer's
  details), editable in Messages, and reply to the customer. They stay. Their
  kinds are marked `emailBy: "producer"`: for the OFFICE (the people the
  routing group chose, the owner fallback, and the extra addresses)
  notifications writes the in-app rows and never sends its own email.
- **Crew are not the office (review BO-03).** Someone reached ONLY through
  `assigned` (a crew member on a moved or cancelled visit) gets the kind's
  copy from notifications, as a `team_alert` linking to their crew page
  (`assignedHref`): the office notice's wording and its link
  (`/app/schedule`, which needs `schedule.view`) are written for the office
  and would refuse them.
- WHO gets the office email moves to the one setting. Each listener takes a
  new seam, `officeRecipients(notice)` (3.4); when given, it decides (the
  saved `staffNotifyEmails` / `leadNotifyEmails` are not read, and
  `staffEmails` is read only when `officeRecipients` throws: the office still
  hears, at the business email). The glue answers with
  `alerts.claimEmails(…)`: the addresses of the office people (and extra
  addresses) for whom this alert's email is still OWED, marked claimed in the
  same statement. The same event handed to the listener twice claims nothing
  the second time: never two emails for one lead.
- **A failed office email is not lost (review BO-02).** The listeners send
  office notices with comms' `deliverNow` (12.2) and tell the host each
  address's outcome (`officeSent`, 3.4). The glue turns a `failed` and
  retryable outcome back into an owed-and-due row (`alerts.releaseClaim`), so
  the alerts cron sends it as a `team_alert` copy (the alert's title, body and
  link), once, with the same retries as every other alert email. A send that
  timed out is not released (it may have gone; two emails are worse than a
  late one), and is reported.
- **One place, really (review BO-11).** A host that keeps message wording with
  an on/off switch (comms' `is_active`) tells notifications which kinds'
  emails are switched off (`emailDelivery(tenantId).offKinds`). Those kinds
  get no email copy, and Alert settings says where to turn them back on
  instead of offering an email that would never go.
- Every other kind's email is sent by notifications through the host's `email`
  seam with one comms template, `team_alert` (4.9).
- With the seam given, the feature's settings screen shows "Who gets these
  alerts is chosen in Alert settings." with a link (`alertsHref`), and a save
  drops the old list (2a D6's rule: never a 422).

**D7. A dedupe key is built from the durable fact, never from a delivery.**
- `estimator.lead:{estimateId}`, `scheduling.visit.moved:{visitId}:{sequence}`,
  `invoicing.invoice.overdue:{invoiceId}:{dueDate}`, … (the tables in sections
  8–12). The unique index `(tenant_id, recipient_id, dedupe_key)` with
  `on conflict do nothing` makes a second write of the same fact for the same
  person a no-op: a retried request, an event handed over twice, a cron that
  runs again, or the request and a sweep both writing it.
- Only rows that were INSERTED get an email, and each carries the idempotency
  key `alert:{alertId}` to the provider (Resend drops a repeat within 24 h).
  A host whose provider has no idempotency key (SMTP, nodemailer) says so
  (`emailIdempotent: false`, the default), and then a send that was cut off
  mid-way is never tried again: "at least once" becomes "at most once" for
  that one email, and the alert says so (4.5; review G12).
- Keys come from facts (ids, sequences, dates), not event ids, wherever the
  fact has them, so a later sweep or an outbox (D8) can write the same key.
  Tenancy's member events have no such fact, so they use the event's new `id`.

**D8. No transactional outbox in 2b-1.**
- **What 2a already guarantees.** Every producer emits AFTER COMMIT, awaited
  and contained (scheduling's and the estimator's `events.ts`, tenancy's
  `onEvent`; invoicing's new events follow the same rules). A rolled-back
  write alerts nobody. The one window left is a crash between the commit and
  the alert insert: the alert is lost, the fact is not (the lead is in the
  queue, the visit is on the calendar).
- **Why not now.** An outbox means every producer writes the event row inside
  its own transaction: a change to the write paths of tenancy, scheduling, the
  estimator and invoicing, a dispatcher, and a host-transaction adapter for a
  Prisma host (S2's `@adminigloo/events`, CC-01). That is a chunk of its own
  with its own proofs; half of it here would be the worst of both.
- **What 2b-1 does instead.**
  - The alert row is the durable record that an email is owed. An email that
    fails or times out in the request is retried by the alerts cron (claim,
    attempts, backoff; it gives up after 26 hours), at least once, never twice
    (D7; with a non-idempotent provider, a cut-off send is not retried). That
    covers the producers' office emails too: a failed one is released back to
    the cron (D6, review BO-02). Before every retry the recipient is checked
    again (D9).
  - The time-based kinds (a request about to lapse, an invoice overdue) are
    PRODUCED by the cron from the records themselves, so they are at least
    once by construction.
  - Every key is fact-based (D7), so when the events package lands its
    dispatcher can deliver the same alerts again and nobody sees two.
- A missed in-app alert is a convenience lost, never a record lost; a missed
  CUSTOMER email is a different matter and stays comms' queue's job.

**D9. Removal, suspension and cleanup.**
- **Removed or left.** The membership gate refuses them on their next request
  (Tenancy 1 D15), and the glue's tenancy listener calls `alerts.forget({
  tenantId, userId })`: their alerts and choices in that company are deleted
  and their id is taken out of every routing list. `people()` never returns
  them again.
- **Checked again before every retry (review G3).** An email copy waiting for
  the cron is sent only if its recipient still qualifies NOW: a person must
  still be returned by `people()` for the kind's permission (or the assigned
  permission, for a row reached through assignment), and gets it at the
  address 4.4 would give them now; an extra address must still be on its
  group. Otherwise the row ends `skipped` ("no longer gets these"). So a
  member removed while their copy waits (the `forget` listener cut off, a
  removal racing the write) never gets an email with a customer's details, and
  nor does a demoted member or a dropped office address.
- **Role changed (review G4).** On `member.role.changed` the glue calls
  `alerts.prune({ tenantId, userId, permissions })` with the person's new
  permission set: their rows of kinds they can no longer get, and their place
  on routing lists whose permission they lost, are deleted. Reads are already
  filtered (D2), so prune is housekeeping, not the guard.
- **Suspended company.** `people()` answers `[]` for a suspended company, so
  nothing is written or emailed; the email retry runs only for the companies
  the cron names (`tenantIds` is REQUIRED: a single-business host passes its
  one id), which are the active ones (2a D10); the bell's routes are refused
  by the gate.
- **Cleanup** (alerts cron). Read alerts older than 30 days, and any alert
  older than 180 days, are deleted, in batches, within a time budget. Every
  statement that deletes or updates rows names a column only the package's
  table has (D14), so an instance pointed at a host's own `notifications`
  table errors instead of deleting the host's rows.

**D10. Files are private by default. Two stores; private keys never on the wire.**
- A purpose (D11) says `private` or `public`. Private bytes go to the PRIVATE
  store, which never hands out a URL. Public bytes (the logo) go to the PUBLIC
  store, under a key with 192 random bits (`p/{32 base64url characters}.{ext}`):
  unguessable, with no company id and no file name in it.
- **No company id in any key (review G7).** A private key is
  `t/{first 16 hex of sha256(tenantId)}/{YYYY}/{MM}/{32 hex random}.{ext}`:
  the "filing cabinet" grouping stays, but a host's company id (whatever its
  `resolveTenant` returns, `/` and `..` included) never reaches a store path,
  and every adapter refuses, before any I/O, a key that isn't one the package
  makes (6.2). Isolation never rests on the key: every lookup is by
  (`tenant_id`, id) in the row.
- A private file is served only, and always streamed by the package (never a
  redirect to the store; review BO-24):
  1. through the company's signed-in route
     (`…/v1/admin/files/{id}/content`), after `authorize` and the file's own
     access rule (D12); or
  2. through a SIGNED LINK (`/api/files/v1/f/{token}`): an HMAC over the
     company, the file, the person who made it, when it was made and an
     expiry (default 1 hour, at most 1 hour: "short-lived"), minted only for
     someone who may open the file. **Every open re-checks the maker (review
     G2):** the host's `stillValid` must say the company is active and the
     maker is still an active member, so a removed member's copied link, and
     every link of a suspended company, stops working on the next open. No
     secret configured means no links (the button isn't offered); everything
     else still works.
- A PRIVATE object's key never leaves the server: no wire type has a field for
  it, no route takes one, no header carries one, and the isolation proof
  asserts that no answer contains one. A PUBLIC file's key is part of its
  public address by construction (`…/v1/p/{random}.{ext}`, or the store's
  URL); that address is the logo's to give out, and the proof checks only
  that B never receives A's (review G8).
- A missing store switches that access off with a plain sentence ("File
  storage isn't switched on yet."). A private file is never stored publicly
  instead: `createStorage` refuses a `stores.private` whose `access` isn't
  `"private"`, and a store that can be checked is checked (`checkPrivate`:
  /setup and the files cron report a "private" store that anyone can read;
  review G9). Only the logo uses the public store in 2b-1.

**D11. Uploads go through the server, up to 4 MB; phones shrink photos first.
The type comes from the bytes. The allowance is checked under a lock.**
- `maxUploadBytes` defaults to 4 MiB: one serverless request body, 0.1's cap,
  a number we chose rather than a 413 nobody can act on. The widget shrinks a
  photo over 1.5 MB, or over 2048 px on its long side, to a 2048 px JPEG
  before upload, so a phone photo at the job always fits. Direct-to-store
  uploads are not included. The limit is enforced on the BYTES READ, not on a
  header: the upload routes count the body as it streams and stop at the cap,
  so a chunked request with no `Content-Length` can't make a self-hosted
  server (no platform body cap) hold more than the cap in memory (review G10).
- The type is SNIFFED from the bytes (`FILE_TYPES`: jpeg, png, webp, gif,
  heic, pdf). The browser's type is a hint only. SVG and HTML are never
  accepted (they can carry script). Each purpose lists the types it takes and
  its own size limit. The stored and served file name takes the sniffed
  type's extension (`report.html` holding a PDF is kept as `report.pdf`), so a
  saved file never opens as something else (review G18).
- The allowance is `allowanceBytes(tenantId)`, a host seam (create-app:
  `FILES_ALLOWANCE_MB`, default **5120**, 5 GB: a two-crew lawn company taking
  40 shrunk photos a day at about 0.7 MB fills 1 GB in about five weeks and 5
  GB in about six months; review BO-07; the billing chunk passes the plan's
  answer here). An upload is checked before the bytes are stored, and again
  inside a transaction holding
  `pg_advisory_xact_lock(hashtext('storage-usage:' || tenant_id))` before its
  row is written, so two uploads can't both take the last of the room; the
  loser's bytes are deleted. A purpose may be `exemptFromAllowance` (counted,
  never refused for the company's total: the logo, so a full company can still
  fix it; a customer's estimate photo, because it is a lead).
- **A share for what strangers send (reviews G6, BO-06).** A purpose may cap
  its own live bytes at `maxShareOfAllowance` × the allowance, checked under
  the same lock. The estimator's customer photos are exempt AND capped at 20 %:
  a full company still takes a customer's photo with a lead, and anonymous
  visitors (a competitor included) can never fill the room the crew's job
  photos need. A refused customer photo answers the estimator's own "as many
  photos as we can take today" sentence and the lead still goes in.
- **Somebody hears when it fills up (review BO-07).** Storage tells the host
  about usage after each store and each refusal (`onUsage`); the glue turns
  it into the "Files" alerts (almost full at 90 %, once a month; full, on the
  first refusal of a day) for the people who manage files, and a refusal is
  reported to `/admin/errors` at most once a day per company, so the platform
  owner sees which company is out of room. A member who can't remove files is
  told to ask the owner, not to delete files.

**D12. A file can belong to a record. The record's own permissions decide.**
- Each 2a package exports RECORD TYPES (`scheduling.visit`,
  `estimator.estimate`, `invoicing.invoice`): a label, the permissions that
  view and manage its files, optionally an `assigned` permission, and a
  `find(ids)` that says, for this company, each record's label, where it opens
  and who is assigned to it (3.5). Structural, no storage import (2a D4).
  2b-2's feedback board adds `feedback.ticket` the same way.
- Access to a file on a record, in order (review G5: the record decides, and
  `files.view` alone opens NO record's files):
  1. `files.manage` may view and remove any file of the company, including one
     whose record type isn't installed any more or whose record `find` no
     longer returns (listed as "Attached to something that was removed"), so
     an orphan can always be removed and stops counting;
  2. one of the record's `manage` permissions may view, add and remove;
  3. one of the record's `view` permissions may view;
  4. `assigned.permission` AND being assigned to the record may view and add
     (a crew member on their own visit), and may remove a file THEY added
     there within 24 hours of adding it (a blurry photo, the wrong house;
     review BO-21);
  5. anyone else gets **404**, never 403, so an id from another company,
     another crew, or a record the reader can't see reveals nothing.
- A file on no record: `files.view` (and, when the purpose names its own
  `view` list, one of those too) opens it; `files.manage` removes it.
- The Files screen's list drops the files a reader can't open under these
  rules (a runtime permission filter, commented as such); the usage stays the
  company's whole usage.
- A record page's "Photos and files" (the `attachments` route) lists the
  record's files of purpose `attachment` only. A feature that keeps its own
  photos on the record (the estimator's "Photos" panel, `estimator.photo`)
  shows them itself; the Files screen lists both (review BO-13).

**D13. Deleting a file removes the stored object.**
- `remove` marks the row deleted (it leaves every list and the usage at once),
  deletes the object, then deletes the row. If the store refuses, the row stays
  marked with `purge_attempts + 1`, and the files cron tries again (up to 10
  times; then it is reported to `/admin/errors` with the key). "Deleted" means
  the bytes go, not only the receipt.
- **The object is deleted from the store it is IN (review G11).** `open`,
  `remove` and the purge always use `stores[row.access]`, never the purpose's
  current store: 0.1's library files and 2a's estimator photos live in the
  PUBLIC store (their rows are upgraded to `access: 'public'`), and choosing
  by purpose would delete nothing from the private store and leave the bytes
  public forever. A row whose access has no store configured stays marked for
  the purge. 0.1 and 2a public rows stay at their old addresses until
  `moveToPrivate` moves them (the files cron runs it for `estimator.photo`).

**D14. Foreign hosts: every company, person and permission comes from the host;
every table name is the host's to choose.**
- Neither package imports tenancy, auth, permissions, comms or `@adminigloo/db`.
  The company is `resolveTenant(req)` / `tenantId`; the person and the
  permission are `authorize(req, permission, tenantId) → { userId } | false |
  Response` (2a's seam, unchanged); who holds a permission is `people()`.
- Tables: `defineNotificationTables({ prefix, schema })` and
  `defineStorageTables({ prefix, schema })`. A `prefix` (the analytics 0.2
  pattern), a Postgres `schema` (Ridgeline keeps package tables in its own
  `adminigloo` schema so its `prisma migrate` drift check stays clean), or
  both. The default set reproduces the 0.1 names exactly (`notifications`,
  `stored_files`), so a 0.1 install upgrades with ALTERs.
- **Never a host's table by default (review G1).** `createNotifications` and
  `createStorage` REQUIRE `tables` (0.2-only APIs, so this breaks nobody); a
  host that forgets it gets a compile error, not every statement pointed at
  ITS OWN `public.notifications`. create-app passes `notificationTables` /
  `storageTables` explicitly. Only 0.1's deprecated functions keep the default.
  Belt and braces: every statement that deletes or updates rows names a column
  only the package's table has (`dedupe_key`, `email_status`, `reached_via`;
  `deleted_at`, `purge_attempts`), so a mis-pointed instance errors and loses
  nothing.
- Shipped SQL for a host that doesn't run drizzle-kit: `notificationsSql(options)`
  and `storageSql(options)` return the DDL for any prefix and schema, and
  `sql/*.sql` carry the default-name create and the 0.1 → 0.2 upgrade. Each
  opens with a guard (a `DO` block) that RAISES "A table named {name} already
  exists and isn't AdminIgloo's. Pass a prefix or a schema." when its target
  exists and isn't the package's (4.1, 6.1), so `create table if not exists`
  never quietly skips over, and the upgrade never ALTERs, a host's own table.
  A test builds the tables from that SQL in PGlite and runs the package's own
  suite against them.
- **Proving the seams (review G19).** On a foreign install, isolation rests on
  the host's `resolveTenant`, `authorize` and `people`, which the package
  tests fake. `@adminigloo/notifications/testing` and
  `@adminigloo/storage/testing` export `checkHostSeams(…)` (4.12, 6.14): the
  host's developer runs it against the host's real seams and shows the
  business owner a passing list. The READMEs' Ridgeline section ends with it.
- Drivers: node-postgres (`drizzle(pool)`) and `neon-serverless` are
  supported; drizzle `neon-http` is NOT (it has no interactive transactions,
  and storage's allowance lock needs one). The READMEs say so.
- No `@adminigloo/db`: each package mints its own uuidv7 (the `uuidv7`
  dependency, comms' and the estimator's precedent), so importing a schema
  never loads the Neon driver (IF-19). A node-postgres host passes
  `drizzle(pool)`.

**D15. Single-business mode: the same features for the one business, its staff
as the people.**
- `--tenant-noun none` runs alerts and files for the fixed business
  (`ALERTS_TENANT` and `FILES_TENANT`, both `"primary"`, in single-only files;
  2a D12's grep adds both names). The people are the site's staff; each
  package permission maps to a staff key (2a's `INVOICING_STAFF_KEYS`
  pattern); the "owner" of a routing default is every staff admin.
- Pages live under `/admin` (`/admin/alerts`, `/admin/alerts/settings`,
  `/admin/files`), routes under `/api/admin/alerts` and `/api/admin/files`;
  signed links and public files are at `/api/files` in both modes. 0.1's
  `/admin/inbox` becomes a redirect to `/admin/alerts`.

**D16. Screens are package components; pages compose them; optional pieces are
slots the generator writes in two variants.**
- The bell is `<AlertsBell>` in the header: the template's `AuthHeader` renders
  an emitted `AlertsBellSlot`, which is the bell with --notifications and
  `null` without. Record pages render the feature's editor and then an emitted
  `RecordFilesSlot` (the storage widget's `<RecordFiles>` with --storage,
  `null` without). A visit has no page of its own in 2a, so the calendar's
  visit panel and today's route link to `/app/schedule/visits/{id}/files`
  through a generated pattern constant (`undefined` without storage). No
  emitted `if` (create-app rule 1).
- A widget never imports another widget package (2a: copy, never import).

**D17. The isolation proof covers the alert and file routes, from their route
tables, exactly as 2a D16.** The new entities are `alert`, `person`, `file`,
`file-token`, `public-key`, `record-type` and `record` (3.1). B gets 403 with
A's company in the path; 404 for A's alert, file and record ids under B's
company; 404 for A's signed link altered to name B, AND for a token correctly
signed (the proof's secret) that names B's company with A's file id, so the
(company, file) lookup is proven, not only the MAC; 404 for a link whose maker
was removed or whose company is suspended; the role pass covers the file
routes whose permission is "the row decides" (3.1, review G14); no answer
anywhere, body or header, carries one of A's PRIVATE object keys, and B never
receives A's public logo address (section 14).

**D18. What a customer typed is never a link.** Alert titles and bodies carry
what a customer typed (a name, an address, a note). The widget renders them as
text, never as HTML or a link; the email copy passes through `breakLinks()`
(link-shaped text broken, scheduling's `forEmail` rule) before the host sees
it, so the only link in an alert email is the one the host builds to the
alert's own page. A title is one line: CR, LF, U+2028 and U+2029 are refused
in it (it becomes a Subject header). A host without comms renders the email
with `renderAlertEmail` (4.9), which escapes every value for HTML, so the
obvious host code can't put customer-typed text into a staff email as markup
(review G12, BO-17). An `href` is a same-site path by a strict pattern
(`/^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/`: no `//`, no `/\`, no
backslash or whitespace anywhere), and the widgets and the email link follow
it only when it resolves to the page's own origin (review G15).

---

## 3. Shared shapes (every builder)

Declared in EACH package that uses them, structurally identical, never imported
across packages (2a D4). Type names are package-prefixed
(`SchedulingAlertDraft`, `EstimatorAlertDraft`, …) so a generated file
importing two packages never has two `AlertDraft`s.

### 3.1 Route tables

2a's `<Pkg>Route` shape (2a 3.1), with one widening of the `permission` doc:
**null on a PRIVATE route means "the row it reads decides"** (storage's file
and record routes, D12), and one optional field those rows MUST carry, so the
emitted proof's role pass can work out the expected answer instead of
skipping them (review G14, BO-18):

```ts
  /** Required when `permission` is null on a private route: what the row it reads must grant (D12). */
  readonly access?: {
    /** "file": the `{file}` placeholder's file decides; "record": the `record`/`id` query's record decides. */
    readonly scope: "file" | "record";
    /** "view" (open, list, link), "manage" (remove), "add" (attach). */
    readonly needs: "view" | "manage" | "add";
  };
```

Storage's rows: `file-get`, `file-content`, `file-link` → `{ scope: "file",
needs: "view" }`; `file-remove` → `{ scope: "file", needs: "manage" }`;
`attachments` → `{ scope: "record", needs: "view" }`; `attach` → `{ scope:
"record", needs: "add" }`. A route test asserts every null-permission private
row has `access`.

New placeholders:

| Package | Entities |
| --- | --- |
| notifications | `alert` (an alert of A's owner), `person` (a member of A, a body reference) |
| storage | `file` (one of A's files), `file-token` (a signed link to it), `public-key` (the random part of A's logo key), `record-type` and `record` (one of A's records of the first installed record type; query references) |

Exported names: `NOTIFICATIONS_ADMIN_ROUTES`, `STORAGE_ADMIN_ROUTES`,
`STORAGE_PUBLIC_ROUTES`; each frozen, `readonly <Pkg>Route<…RouteKind>[]`.

### 3.2 Alert kinds (each 2a package's fragment; notifications' own types are the same shape)

```ts
export type <Pkg>AlertChannel = "in_app" | "email";

export interface <Pkg>AlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase: "Someone asks for an estimate". */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under: "Estimates", "Visits", "Invoices", "Messages", "Team". */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: <Pkg>AlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

export interface <Pkg>AlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  /** "New estimate requests and quote answers" */
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

export interface <Pkg>AlertKinds {
  readonly kinds: readonly <Pkg>AlertKind[];
  readonly routings: readonly <Pkg>AlertRouting[];
}
```

### 3.3 Alert drafts (what a mapper returns and `alerts.notify` takes)

```ts
export interface <Pkg>AlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text, may have line breaks; null = none. */
  readonly body: string | null;
  /**
   * Where it opens: a path on this site ("/app/estimates/…") matching
   * /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/ (D18: no "//", no "/\", no
   * backslash, whitespace or control character anywhere); null = nothing to open.
   */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned` (crew). Default `href`. The same pattern as `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about, e.g. { type: "scheduling.visit", id }. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record (as text). */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes (the customer, on a lead). */
  readonly replyTo?: string | null;
}
```

Every mapper is given its hrefs as PATTERNS (2a 7.10's `{id}` rule), so the
same package serves `/app/…` and `/admin/…`. Each `{name}` is replaced with the
URL-encoded value.

### 3.4 The office notice seam (scheduling's and the estimator's comms listeners)

```ts
export interface <Pkg>OfficeNotice {
  readonly tenantId: string;
  /** The alert kind this email is the copy of (3.2). */
  readonly kind: string;
  /** The same key the package's alert mapper writes for this fact (D6, D7). */
  readonly dedupeKey: string;
  readonly eventId: string;
  /**
   * scheduling: the people linked to the visit's crew; estimator: always [].
   * NOT addressed by the office email (crew get their own copy from
   * notifications, D6 / review BO-03): the claim uses it only so its
   * no-rows fallback (4.5 claimEmails step 4) can leave assigned-only people out.
   */
  readonly assignedUserIds: readonly string[];
}
/**
 * Listener option. When given it decides: the saved lists are not read, and
 * [] sends no office email. A throw is reported (step "office-recipients")
 * and the listener falls back to `staffEmails` (the host's business address,
 * 2a's inbox) so the office still hears (review BO-02).
 */
officeRecipients?: (notice: <Pkg>OfficeNotice) => readonly string[] | Promise<readonly string[]>;
/**
 * Listener option. Told, per address, how each office email ended, after
 * `deliverNow` (12.2) answered. Not told about a send that timed out (it may
 * have gone). Awaited inside the listener's own step: a throw is reported
 * (step "office-sent") and changes nothing.
 */
officeSent?: (
  notice: <Pkg>OfficeNotice,
  result: { readonly to: string; readonly status: "sent" | "skipped" | "failed"; readonly retryable: boolean },
) => void | Promise<void>;
```

The package computes `kind` and `dedupeKey` with the SAME internal function its
alert mapper uses, so the claim (4.5) finds the rows the mapper wrote. With
`officeRecipients` given, the listener sends each office email with
`deliverNow` (not `sendNow`), keeping 2a's template, variables, reply-to and
idempotency key, and calls `officeSent` with its outcome.

### 3.5 File record types (scheduling, estimator, invoicing; storage's own type is the same shape)

```ts
export interface <Pkg>FileRecordType {
  /** "scheduling.visit": /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/. Permanent (stored on file rows). */
  readonly type: string;
  /** "Visit" */
  readonly label: string;
  /** "Visits": the Files screen's filter (review BO-22). */
  readonly pluralLabel: string;
  /** Any one of these lets someone see this record's files. */
  readonly view: readonly string[];
  /** Any one of these lets someone add and remove them. */
  readonly manage: readonly string[];
  /** Someone holding this may see and ADD files on records they are assigned to (crew), and remove their own within 24 h (D12). */
  readonly assigned?: { readonly permission: string };
  /**
   * The records of THIS company among `ids`: a label (the Files screen's
   * "Attached to" and the record's heading, e.g. "Visit · Pat Rivera ·
   * Tue, Nov 3, 9:00 AM"), where it opens, and who is assigned. An id that
   * isn't this company's is simply absent. One query, never one per id.
   */
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}
```

Each package's factory closes over its db and takes its href pattern:
`schedulingFileRecords(db, { visitHref })`, `estimatorFileRecords(db, {
estimateHref })`, `invoicingFileRecords(db, { invoiceHref })`.

### 3.6 The private seams' copy

2a 3.5, unchanged: the private handlers return `authorize`'s `Response` as it
is; `false` is the handler's own 403 `forbidden` with its plain sentence. The
alerts handlers need a PERSON: an `authorize` answer with no `userId` is
refused 403 `forbidden` "Sign in again to see your alerts." and reported
(`onError`, step "authorize").

---

## 4. `@adminigloo/notifications` 0.2.0 (alerts builder)

Everything 0.1 exported keeps working (4.10). Every new read, mark and delete
has the company AND the person in its WHERE clause.

### 4.1 Schema (`./schema`)

```ts
export interface DefineNotificationTablesOptions {
  /** "" (default: the 0.1 names) or /^[a-z][a-z0-9_]{0,30}_$/ (e.g. "aig_"). */
  readonly prefix?: string;
  /** A Postgres schema of the host's ("adminigloo"); default none (the connection's search path). /^[a-z_][a-z0-9_]{0,62}$/. */
  readonly schema?: string;
}
export interface NotificationTables {
  readonly prefix: string;
  readonly schema: string | null;
  readonly alerts: PgTable;        // "{prefix}notifications"
  readonly choices: PgTable;       // "{prefix}notification_choices"
  readonly routing: PgTable;       // "{prefix}notification_routing"
}
export function defineNotificationTables(options?: DefineNotificationTablesOptions): NotificationTables;
/** The default set: 0.1's names. */
export const notificationTables: NotificationTables;
/** 0.1's export name: the same table as notificationTables.alerts. */
export const notifications: NotificationTables["alerts"];
export const notificationChoices: NotificationTables["choices"];
export const notificationRouting: NotificationTables["routing"];
/** The DDL for these tables under `options` (create schema / table / index IF NOT EXISTS), for a host without drizzle-kit. */
export function notificationsSql(options?: DefineNotificationTablesOptions): string;
export class InvalidTableNameError extends Error { readonly name = "InvalidTableNameError" }
```

The tables are built with `pgSchema(schema).table` when a schema is given and
`pgTable` otherwise, every index and constraint name from the prefix, and the
analytics rule for names past 63 characters (a shorter `{prefix}{table}_{what}`
form, never for the default). A snapshot test pins every default name.

**`{prefix}notifications`** (one row per alert per person):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` primary key | uuidv7 (the package's own, D14) |
| `tenant_id` | `text not null default '*'` | the company; `'*'` only for 0.1 rows and 0.1 calls (the firm-wide staff inbox) |
| `recipient_id` | `text not null` | a person's id as text, or `email:{address}` for an email-only address (D2) |
| `reached_via` | `text not null default 'audience'` | `audience` (the kind's permission, routed or not) · `assigned` (only through the record's assigned people) · `address` (an email-only address). What reads (D2), `prune` and the retry check (D9) test against |
| `kind` | `text not null` | a registered kind key |
| `title` | `text not null` | |
| `body` | `text` | |
| `href` | `text` | a path on this site |
| `dedupe_key` | `text` | null only for 0.1 rows |
| `subject_type`, `subject_id` | `text` | what it is about |
| `actor_id` | `text` | who caused it |
| `read_at` | `timestamptz` | null = unread (0.1) |
| `created_at` | `timestamptz not null default now()` | |
| `email_status` | `text not null default 'none'` | `none` · `pending` · `sending` · `sent` · `skipped` · `failed` · `expired` · `owed` (the producer sends it, D6) · `claimed` (the producer took it) |
| `email_to` | `text` | the address it goes to, set when the alert is written; the cron re-derives it before a retry (D9) and updates it |
| `email_attempts` | `integer not null default 0` | |
| `email_next_at` | `timestamptz` | when the cron may try again |
| `email_claimed_at` | `timestamptz` | |
| `emailed_at` | `timestamptz` | |
| `email_error` | `text` | the log's words, cut to 500 |

Indexes: 0.1's `notifications_recipient_created_idx` and
`notifications_recipient_read_idx` (names kept exactly); unique
`notifications_dedupe_uidx (tenant_id, recipient_id, dedupe_key)` (NULLs are
distinct in Postgres, so 0.1 rows never collide, and `on conflict` needs no
predicate); `notifications_inbox_idx (tenant_id, recipient_id, created_at, id)`;
`notifications_unread_idx (tenant_id, recipient_id) where read_at is null`;
`notifications_email_due_idx (email_next_at) where email_status in
('pending','sending')`; `notifications_dedupe_lookup_idx (tenant_id,
dedupe_key)` (the claim); `notifications_created_idx (created_at)` (cleanup).

**`{prefix}notification_choices`**: `tenant_id text not null`, `user_id text
not null`, `kind text not null`, `channel text not null` (`in_app` | `email`),
`updated_at timestamptz not null default now()`; primary key
`notification_choices_pk (tenant_id, user_id, kind)`. Only explicit choices
are stored (D5).

**`{prefix}notification_routing`**: `tenant_id text not null`, `routing text
not null`, `mode text not null default 'owner'` (`owner` | `chosen`),
`user_ids text[] not null default '{}'`, `extra_emails text[] not null default
'{}'`, `updated_at timestamptz not null default now()`, `updated_by text`;
primary key `notification_routing_pk (tenant_id, routing)`. No row = the
owner.

**Shipped SQL** (package `files` gains `sql`): `sql/notifications-0.2.0.sql`
(the default names, from `notificationsSql()`; a test asserts the file equals
the function's output) and `sql/upgrade-0.1-to-0.2.sql`.

Both OPEN with a guard (review G1), so neither can quietly pass over, or
alter, a host's own table of the same name:

```sql
-- notificationsSql(options), first statement (names from the options):
do $$ begin
  if to_regclass('{qualified alerts table}') is not null and not exists (
    select 1 from information_schema.columns
     where table_schema = {schema or current_schema()} and table_name = '{prefix}notifications' and column_name = 'email_status'
  ) then
    raise exception 'A table named {qualified alerts table} already exists and isn''t AdminIgloo''s 0.2 table. If it is AdminIgloo''s 0.1 table, run sql/upgrade-0.1-to-0.2.sql; otherwise pass a prefix or a schema.';
  end if;
end $$;
-- (the same check for {prefix}notification_choices and {prefix}notification_routing, on their own columns)

-- upgrade-0.1-to-0.2.sql, first statement: the table must be 0.1's, exactly
-- (columns id, recipient_id, kind, title, body, href, read_at, created_at, and
-- the index notifications_recipient_created_idx), else:
--   raise exception 'The table named notifications isn''t AdminIgloo''s 0.1 table. Pass a prefix or a schema and run notificationsSql() instead.';
```

Then the upgrade:

```sql
alter table notifications
  add column if not exists tenant_id text not null default '*',
  add column if not exists reached_via text not null default 'audience',
  add column if not exists dedupe_key text,
  add column if not exists subject_type text,
  add column if not exists subject_id text,
  add column if not exists actor_id text,
  add column if not exists email_status text not null default 'none',
  add column if not exists email_to text,
  add column if not exists email_attempts integer not null default 0,
  add column if not exists email_next_at timestamptz,
  add column if not exists email_claimed_at timestamptz,
  add column if not exists emailed_at timestamptz,
  add column if not exists email_error text;
-- then every index above, and the two new tables, each "if not exists"
```

0.1's rows become the firm-wide staff inbox (`'*'`); no company's bell shows
them. The README's upgrade section says so.

### 4.2 The registry (root)

```ts
export type AlertChannel = "in_app" | "email";
export interface AlertKindSpec { /* exactly 3.2's <Pkg>AlertKind */ }
export interface AlertRoutingSpec { /* exactly 3.2's <Pkg>AlertRouting */ }
export interface AlertKindsFragment { readonly kinds: readonly AlertKindSpec[]; readonly routings?: readonly AlertRoutingSpec[] }

/** Checks one fragment now (InvalidAlertKindError), so a package's own test catches a bad key. */
export function defineAlertKinds<const F extends AlertKindsFragment>(fragment: F): F;

export interface AlertRegistry {
  /** Ordered: categories in first-seen order, then `order`, then key. */
  readonly kinds: readonly AlertKindSpec[];
  readonly routings: readonly AlertRoutingSpec[];
  readonly categories: readonly string[];
  /** Every distinct permission the kinds' audiences (and assigned) and the routings name, sorted: what a reader is asked for (4.7). */
  readonly permissions: readonly string[];
  kind(key: string): AlertKindSpec | undefined;
  routing(key: string): AlertRoutingSpec | undefined;
}
export function defineAlertRegistry(fragments: readonly AlertKindsFragment[]): AlertRegistry;
export class InvalidAlertKindError extends Error { readonly name = "InvalidAlertKindError" }
export class DuplicateAlertKindError extends Error { readonly name = "DuplicateAlertKindError" }
```

Refused at definition: a key failing 3.2's pattern; a label outside 1–80, a
category outside 1–40, a description over 200; an empty permission; a
`defaultChannel: "email"` on an `email: false` kind; `emailBy: "producer"` on
an `email: false` kind; a routing key failing its pattern. `defineAlertRegistry`
also refuses a duplicate kind or routing key across fragments, and a kind
naming a routing no fragment declares.

### 4.3 The instance (root)

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NotificationsDb = PgDatabase<any, any, any>;   // 0.1's name, kept

export interface AlertPerson {
  readonly userId: string;
  readonly name: string | null;
  /** Where their email copies go; null: in the app only. */
  readonly email: string | null;
  /**
   * Gets a routing group's alerts while the company chose nobody (the owner;
   * single mode: every staff admin). Mark at least one person per company;
   * otherwise routed alerts go to everyone who holds the group's permission
   * (D4, review G13).
   */
  readonly isOwner: boolean;
}

export interface AlertEmailMessage {
  readonly tenantId: string;
  readonly alertId: string;
  readonly kind: string;
  readonly to: string;
  readonly recipientName: string | null;
  /** true for an email-only address the owner added (it has no sign-in): no "change which alerts you get" line (4.9). */
  readonly addressOnly: boolean;
  /** Plain text, one line, `breakLinks` applied (D18). */
  readonly title: string;
  readonly body: string | null;
  /** The alert's path on this site; the host makes it absolute (companies: through the switch route). */
  readonly href: string | null;
  readonly replyTo: string | null;
  /** "alert:{alertId}", the same on every retry (D7). */
  readonly idempotencyKey: string;
}
export type AlertEmailOutcome =
  | { readonly status: "sent" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly error: string; readonly retryable: boolean };
export interface AlertEmailDelivery {
  readonly available: boolean;
  readonly offReason: string | null;
  /**
   * Kinds whose email the host has switched off where it keeps its message
   * wording (comms' Messages), each with the name of that message as the
   * owner sees it: { "estimator.lead": "New lead (to your office)" }.
   * Those kinds get no email copy, and Alert settings says where to turn them
   * back on (D6, review BO-11). Default {}.
   */
  readonly offKinds?: Readonly<Record<string, string>>;
}

export interface CreateNotificationsOptions {
  readonly db: NotificationsDb;
  /** REQUIRED (D14, review G1): `notificationTables` for the 0.1 names, or `defineNotificationTables({ prefix, schema })`. */
  readonly tables: NotificationTables;
  readonly registry: AlertRegistry;
  /**
   * The company's ACTIVE members holding `permission` right now, with their
   * sign-in address. A suspended, deleted or unknown company → []. Asked at
   * write time, per alert (D2, D9). A throw: that draft alerts nobody and is
   * reported (step "people").
   */
  readonly people: (tenantId: string, permission: string) => Promise<readonly AlertPerson[]>;
  /**
   * Where the owner's email copies of a ROUTED kind go while its group is on
   * "The owner" (no row, mode `owner`, or the empty-list fallback; D4, review
   * BO-01). null or absent: the owner's own address. A throw: the owner's own
   * address, reported (step "owner-email").
   */
  readonly ownerEmail?: (tenantId: string) => string | null | Promise<string | null>;
  /** Sends one email copy (D5). Absent: alerts are in the app only, and no email choice is offered. */
  readonly email?: (message: AlertEmailMessage) => Promise<AlertEmailOutcome>;
  /**
   * Does the `email` seam's provider drop a repeat of the same
   * `idempotencyKey` (Resend does; SMTP doesn't)? Default false. false: a copy
   * left `sending` by a send that was cut off is never sent again; it ends
   * `failed` with "It may not have gone, and it isn't sent again so nobody
   * gets two." true: it is reclaimed and retried (D7, review G12).
   */
  readonly emailIdempotent?: boolean;
  /** Is email really leaving for this company, and if not, why (shown in Alert settings). Default: available exactly when `email` is given. */
  readonly emailDelivery?: (tenantId: string) => AlertEmailDelivery | Promise<AlertEmailDelivery>;
  /** Longest one email may hold up the request that caused the alert. Default 8000; 0 waits. */
  readonly sendTimeoutMs?: number;
  readonly now?: () => Date;
  /** Told about every step that failed. The instance never throws from notify; claimEmails throws only AlertsUnavailableError (4.5). Default console.error. */
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly kind?: string; readonly step: string }) => void;
}
export function createNotifications(options: CreateNotificationsOptions): Notifications;

export interface AlertDraft { /* exactly 3.3's <Pkg>AlertDraft */ }
export interface AlertRow {
  readonly id: string; readonly tenantId: string; readonly recipientId: string;
  readonly kind: string; readonly title: string; readonly body: string | null; readonly href: string | null;
  readonly subject: { readonly type: string; readonly id: string } | null;
  readonly readAt: Date | null; readonly createdAt: Date;
}
export interface NotifyReport {
  /** Rows written for people (extra addresses not counted). */
  readonly alerted: number;
  /** Rows the dedupe key already had (D7). */
  readonly duplicates: number;
  readonly emailed: number;
  readonly emailsFailed: number;
  /** Left for the cron: timed out, or failed in a way a retry could fix. */
  readonly emailsLater: number;
  /** Each draft refused or skipped, in words ("unknown alert kind estimator.leed"). For tests and logs. */
  readonly problems: readonly string[];
}
export interface RoutingChoice {
  readonly mode: "owner" | "chosen";
  readonly userIds: readonly string[];
  readonly extraEmails: readonly string[];
  readonly updatedAt: Date | null;
}
/**
 * Who is reading, and what they may get NOW (D2, review G4): the entries of
 * `registry.permissions` they hold. The handlers fill it from `authorize`; a
 * host calling the instance directly passes the person's permissions.
 */
export interface AlertReader {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

export interface Notifications {
  readonly registry: AlertRegistry;
  readonly tables: NotificationTables;
  /** Write each draft's alerts and send their email copies (4.5). Never throws. */
  notify(drafts: AlertDraft | readonly AlertDraft[]): Promise<NotifyReport>;
  /**
   * A producer's office email (D6): the addresses still owed this alert's
   * email, claimed in the same statement. Throws `AlertsUnavailableError`
   * ONLY when its database statement fails (reported first), so the
   * listener falls back to `staffEmails` and the office still hears (3.4).
   * Every other problem is [] + onError.
   */
  claimEmails(input: {
    readonly tenantId: string; readonly kind: string; readonly dedupeKey: string;
    readonly assignedUserIds?: readonly string[]; readonly actorUserId?: string | null;
  }): Promise<readonly string[]>;
  /**
   * The office email to `to` failed and a retry could help (D6, review
   * BO-02): that claimed row goes back to `pending`, due in 5 minutes, so the
   * alerts cron sends it as a `team_alert` copy. Answers how many rows moved
   * (0 or 1). Never throws (0 + onError).
   */
  releaseClaim(input: { readonly tenantId: string; readonly kind: string; readonly dedupeKey: string; readonly to: string }): Promise<number>;
  list(input: AlertReader & { readonly unreadOnly?: boolean; readonly cursor?: string | null; readonly limit?: number }):
    Promise<{ readonly alerts: readonly AlertRow[]; readonly nextCursor: string | null }>;
  unreadCount(input: AlertReader): Promise<number>;
  /** "already" for an alert of theirs already read (two tabs); "not_found" for anyone else's id, or one of theirs they may no longer see (D2). */
  markRead(input: AlertReader & { readonly alertId: string }): Promise<"marked" | "already" | "not_found">;
  markAllRead(input: AlertReader): Promise<number>;
  /** The person's STORED choices only (D5). */
  choices(input: { readonly tenantId: string; readonly userId: string }): Promise<ReadonlyMap<string, AlertChannel>>;
  /** Throws AlertsInputError (unknown kind; email on a kind that is never emailed). */
  setChoice(input: { readonly tenantId: string; readonly userId: string; readonly kind: string; readonly channel: AlertChannel }): Promise<void>;
  routing(tenantId: string): Promise<ReadonlyMap<string, RoutingChoice>>;
  /** Throws AlertsInputError: unknown group; a person who isn't a member holding the group's permission ("Pick people from your company."); more than 20 people; more than 5 addresses or a bad one. */
  setRouting(input: {
    readonly tenantId: string; readonly routing: string; readonly mode: "owner" | "chosen";
    readonly userIds: readonly string[]; readonly extraEmails: readonly string[]; readonly by: string;
  }): Promise<RoutingChoice>;
  /** D9: a member removed or gone. */
  forget(input: { readonly tenantId: string; readonly userId: string }): Promise<{ readonly alerts: number; readonly choices: number; readonly routings: number }>;
  /**
   * D9, review G4: a member's role changed. `permissions` is the person's
   * set NOW (at least the entries of `registry.permissions` they hold).
   * Deletes their rows they may no longer see (the read filter's rule, by
   * `reached_via`) and takes them off routing lists whose permission they
   * lost. Never throws (zeros + onError).
   */
  prune(input: { readonly tenantId: string; readonly userId: string; readonly permissions: readonly string[] }):
    Promise<{ readonly alerts: number; readonly routings: number }>;
  /** The alerts cron (D8). */
  deliverPendingEmails(options: {
    /** REQUIRED (D9, review G3): the companies whose emails may go now (the active ones). [] claims nothing. */
    readonly tenantIds: readonly string[];
    readonly limit?: number; readonly timeBudgetMs?: number;
    readonly maxAttempts?: number; readonly maxAgeMs?: number;
  }): Promise<{ readonly sent: number; readonly skipped: number; readonly failed: number; readonly retrying: number; readonly expired: number; readonly reclaimed: number; readonly stoppedEarly: boolean }>;
  /** The alerts cron (D9). */
  cleanup(options?: { readonly readOlderThanDays?: number; readonly anyOlderThanDays?: number; readonly limit?: number; readonly timeBudgetMs?: number }):
    Promise<{ readonly deleted: number; readonly stoppedEarly: boolean }>;
}

export class AlertsInputError extends Error {
  readonly name = "AlertsInputError";
  readonly issues: readonly { readonly path: (string | number)[]; readonly message: string }[];
}
/** claimEmails' one throw: its database statement failed (the office falls back to the business address, 3.4). */
export class AlertsUnavailableError extends Error { readonly name = "AlertsUnavailableError" }
/** Breaks link-shaped text (scheme://…, www.…, a bare domain with a path) so a mail client won't make it a link. Pure. */
export function breakLinks(text: string): string;
```

### 4.4 Who gets it (internal, shared by `notify` and `claimEmails`)

For one draft:

1. `spec = registry.kind(draft.kind)`; unknown → problem, nothing written.
2. `permitted = people(tenantId, spec.audience.permission)`.
3. With `spec.audience.routing`: read the company's choice for that group.
   - `mode: "chosen"`: the people are `permitted` ∩ `userIds`; the group's
     `extraEmails` are always added (`reached_via: address`). If no PERSON
     remains (everyone on the list left), the people are the owner fallback
     below, so a bell shows it (D4, review BO-20).
   - No row, or `mode: "owner"`: the owner fallback.
   - **The owner fallback:** `permitted.filter(p => p.isOwner)`; if that is
     empty, everyone in `permitted`, and `onError` is told once for this draft
     (step `no-owner`; D4, review G13). Their email address for this kind is
     `ownerEmail(tenantId) ?? person.email` for an `isOwner` person (review
     BO-01), `person.email` otherwise.
   Without routing: everyone in `permitted`. All of these are `reached_via:
   audience`.
4. With `spec.audience.assigned` and `draft.assignedUserIds` non-empty: add
   `people(tenantId, assigned.permission)` ∩ `assignedUserIds` as
   `reached_via: assigned`, unless step 3 already chose them (then they stay
   `audience`).
5. Remove `draft.actorUserId`. One entry per person.
6. Each person's channel: their stored choice, else `spec.defaultChannel`. They
   get an email copy when the channel is `email`, `spec.email !== false`,
   `emailDelivery(tenantId).available`, the kind isn't in
   `emailDelivery(tenantId).offKinds` (review BO-11), and they have an address.
7. Extra addresses get an email copy under the same conditions on the kind
   and the company; an address equal (case-insensitively) to a chosen
   person's address (as step 3 worked it out, the business email included) is
   dropped (that person's own copy covers it).

`emailDelivery` and `ownerEmail` are asked at most once per company per call.

### 4.5 `notify`, `claimEmails` and the email copies

`notify(drafts)`:

1. Each draft through zod (3.3's limits: `title` 1–200 with no CR, LF,
   U+2028 or U+2029; `href` and `assignedHref` matching D18's pattern). A
   refused draft is a problem; the rest go on.
2. Recipients (4.4). Rows: one per person (`href` = `assignedHref ?? href` for
   someone reached only through `assigned`), plus one per extra address
   (`recipient_id: "email:{address}"`, `reached_via: address`, `read_at:
   now`). `email_status`: `none` without an email copy; for an `emailBy:
   "producer"` kind, `owed` for the people step 3 of 4.4 chose and for the
   extra addresses, and `pending` for someone reached ONLY through
   `assigned` (they get notifications' `team_alert`, linking to
   `assignedHref`; D6, review BO-03); `pending` for every other kind; each
   `pending` row with `email_next_at: now`.
3. ONE insert for the whole call:
   `insert … on conflict (tenant_id, recipient_id, dedupe_key) do nothing
   returning id, recipient_id, email_status, email_to`. Rows not returned are
   `duplicates`.
4. Every RETURNED `pending` row is claimed (`update … set email_status =
   'sending', email_claimed_at = now, email_attempts = email_attempts + 1 where
   id = any($ids) and email_status = 'pending' returning …`) and sent through
   `email`, at most four at once, each bounded by `sendTimeoutMs`:

   | Outcome | Row |
   | --- | --- |
   | `sent` | `sent`, `emailed_at` |
   | `skipped` | `skipped`, `email_error` = the reason |
   | `failed`, `retryable` | `pending`, `email_next_at = now + 2^attempts minutes`, `email_error` |
   | `failed`, not retryable | `failed`, `email_error` |
   | the seam throws | as a retryable failure |
   | timed out | left `sending`, counted in `emailsLater`. With `emailIdempotent`, the cron reclaims it after 10 minutes and the idempotency key stops a late finish from sending twice; without, the cron ends it `failed` (below) |

   Title and body go through `breakLinks` (D18) before the seam sees them.
5. Never throws: a database failure on the insert is a problem, reported
   (step "write"), and the report says nothing was alerted.

`claimEmails(input)`:

1. `spec.emailBy !== "producer"` → `[]` and reported (step "claim": a
   notifications-sent kind must not be claimed, or it would go twice).
2. `update … set email_status = 'claimed', email_claimed_at = now, emailed_at =
   now where tenant_id = $t and dedupe_key = $k and kind = $kind and
   email_status = 'owed' returning email_to` → those addresses, deduplicated
   case-insensitively.
3. Nothing claimed but a row with that key exists → `[]` (already claimed, or
   nobody chose email).
4. No row with that key at all (the alert write failed or never ran): the
   recipients are worked out live (4.4), people reached only through
   `assigned` left out (review BO-03), and their email addresses returned,
   reported (step "claim-without-alerts") so the missing in-app write is seen.
   The office still hears; this one email has no dedupe.
5. The statement in step 2 (or step 4's reads) failing → reported (step
   "claim"), then `AlertsUnavailableError` is thrown, so the listener's
   `staffEmails` fallback runs (3.4).

The emitted glue runs the alerts listener BEFORE the comms listener for every
event (13.6), so step 4 is the failure path, not the normal one.

`releaseClaim({ tenantId, kind, dedupeKey, to })` (review BO-02): `update …
set email_status = 'pending', email_next_at = now + 5 minutes, email_error =
'The office email didn''t go; sent again as an alert.' where tenant_id = $t
and kind = $kind and dedupe_key = $k and lower(email_to) = lower($to) and
email_status = 'claimed'`. A row of a kind that isn't `emailBy: "producer"`
is never touched (the `kind` is checked against the registry first). The cron
then sends it through the `email` seam like any other copy: once, because the
row is claimed by update before each send.

`deliverPendingEmails(options)` (defaults: `maxAttempts` 4, `maxAgeMs` 26 h,
`limit` 500; `tenantIds` required):

1. Stale `sending` rows (claimed more than 10 minutes ago), in `tenantIds`:
   with `emailIdempotent`, → `pending` (`reclaimed`); without, → `failed`
   with "It may not have gone, and it isn't sent again so nobody gets two."
   (review G12).
2. Expire: `pending` rows older than `maxAgeMs`, in `tenantIds` → `expired`
   ("too late to be useful").
3. Claim due rows (`pending`, `email_next_at <= now`, `tenant_id =
   any($tenantIds)`; an empty list claims nothing), **companies taking turns**
   (review BO-14, 2a §18's drain rule): ordered by `row_number() over
   (partition by tenant_id order by email_next_at, id)`, then `email_next_at`,
   then `id`, so each company's first due row goes before any company's
   second. Each claim guarded on `email_status = 'pending' and email_attempts
   = {seen}` (comms' rule).
4. **Re-check the recipient before sending** (D9, review G3), memoising
   `people(tenant, permission)` and the routing rows per run:
   - a person row (`reached_via` `audience` or `assigned`): they must still be
     returned by `people(row.tenant_id, permission)` with `permission` the
     kind's `audience.permission` (`audience`) or `assigned.permission`
     (`assigned`); the email goes to the address 4.4 step 3 would give them
     NOW (the business email for the owner of a group on "The owner", else
     their current sign-in address), and `email_to` is updated to it;
   - an address row: the address must still be in its kind's group's
     `extra_emails`;
   - an unregistered kind, a kind now in `offKinds`, or a failed check →
     `skipped` with "no longer gets these" (counted in `skipped`), nothing
     sent.
5. Send, the outcomes as in notify's step 4, `failed` once `email_attempts
   >= maxAttempts`. Stops starting new rows when `timeBudgetMs` is spent
   (`stoppedEarly`). One row's failure never stops the rest.

`cleanup(options)` (defaults 30 and 180 days, batches of 1000): deletes rows
with `read_at < now − readOlderThanDays`, and rows with `created_at < now −
anyOlderThanDays`, in batches (`id in (select id … where … and dedupe_key is
not null and email_status is not null limit …)`; the two package-only columns
are named on purpose, D14, review G1), within `timeBudgetMs`. 0.1's rows
(`dedupe_key` null) are left alone: they are the firm-wide inbox's, and
`legacy.ts` keeps its own rules.

**Guarded statements (D14, review G1).** Every statement that updates or
deletes alert rows names a package-only column in its WHERE or SET:
`claimEmails`, `releaseClaim`, `deliverPendingEmails` (`email_status`),
`forget`, `prune` and `cleanup` (`reached_via` / `dedupe_key`), `markRead` /
`markAllRead` (`and reached_via is not null`). A test points an instance at a
host's own `notifications(id, user_id, read_at, created_at)` table and
asserts each throws and the host's rows are unchanged (15.1).

`forget({ tenantId, userId })`: deletes that person's alerts and choices in
that company and runs `update … set user_ids = array_remove(user_ids, $user)
where tenant_id = $t and $user = any(user_ids)`. Every statement has the
company in it.

`prune({ tenantId, userId, permissions })` (review G4): deletes the person's
rows in that company where (`reached_via = 'audience'` and the kind's
`audience.permission` ∉ `permissions`) or (`reached_via = 'assigned'` and the
kind's `assigned.permission` ∉ `permissions`), computed as two `kind = any(…)`
lists from the registry; and takes them off every routing row of that company
whose routing's `permission` ∉ `permissions`. Every statement has the company
in it.

Reads: every read takes an `AlertReader` and shows only rows the reader may
see NOW (D2, review G4): `kind` registered, and (`reached_via = 'audience'`
and `kind = any($audienceKinds)`) or (`reached_via = 'assigned'` and `kind =
any($assignedKinds)`), where `$audienceKinds` are the kinds whose
`audience.permission` is in `permissions` and `$assignedKinds` those whose
`assigned.permission` is (a runtime permission filter over the registry,
commented as such). `list` orders by `created_at desc, id desc` with a cursor
of the last row (base64url JSON `{ c, i }`; a malformed cursor is
`AlertsInputError`), default 20, at most 50. `unreadCount` is its own query
(0.1's reason: it runs on every page) with the same filter, so the badge and
the list never disagree. `markRead` / `markAllRead` set `read_at = now` only
where `tenant_id`, `recipient_id`, `read_at is null` and the same filter
match.

### 4.6 Permissions (root)

```ts
export const notificationsPermissions = {
  "alerts.view": {
    label: "Get alerts",
    description: "See your own alerts in the bell, and choose which ones also come by email.",
    category: "Alerts",
    // Every role a project seeds, crew included: a crew member's bell holds
    // their own crew's visit changes (D4). A role a project never seeds grants
    // nothing (2a 6.1's comment).
    defaultFor: ["owner", "admin", "member", "viewer", "crew"],
  },
  "alerts.manage": {
    label: "Choose who hears about new work",
    description: "Pick who in the company gets alerts about new estimate requests, visit requests and invoices.",
    category: "Alerts",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, NotificationsPermissionDefinition>;   // structural, like comms'
export type NotificationsPermission = keyof typeof notificationsPermissions;
```

### 4.7 Handlers (root): `createNotificationHandlers`

```ts
export type NotificationsAuthorizeResult = boolean | { userId?: string | number | null } | Response;
export interface CreateNotificationHandlersOptions {
  readonly notifications: Notifications;
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /**
   * Asked first for the route's permission (it must name the person: 3.6),
   * then — by `count`, `list`, `read`, `read-all` and `preferences` — once for
   * each entry of `registry.permissions`, to build the `AlertReader` (D2,
   * review G4): only the alerts this person may get NOW are counted, listed,
   * marked or offered. Those extra asks count only `true` or an object; they
   * never become the answer. The host memoises per request (2a's seams do).
   */
  readonly authorize: (req: Request, permission: string, tenantId: string) => NotificationsAuthorizeResult | Promise<NotificationsAuthorizeResult>;
  /** Paths on this site the widget links to. `messages`: where switched-off alert emails are turned back on (review BO-11). */
  readonly links?: { readonly inbox?: string | null; readonly settings?: string | null; readonly messages?: string | null };
  /**
   * Rewrites each alert's `href` on the wire (review G16), e.g. through the
   * host's company-switch route so an alert of Green Acres opens IN Green
   * Acres even if another tab switched to Summit. Must answer a same-site path
   * (D18's pattern; anything else is dropped to null and reported). Called
   * once per alert on the wire; the host memoises its own lookups per request.
   * Default: unchanged.
   */
  readonly hrefFor?: (tenantId: string, href: string) => string | Promise<string>;
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly route: string }) => void;
  readonly now?: () => Date;
}
export function createNotificationHandlers(options: CreateNotificationHandlersOptions): { handle(req: Request): Promise<Response> };
export type NotificationsAdminRouteKind = "count" | "list" | "read" | "read-all" | "preferences" | "preference-set" | "routing" | "routing-set";
export const NOTIFICATIONS_ADMIN_ROUTES: readonly NotificationsRoute<NotificationsAdminRouteKind>[];
```

Mechanics as 2a comms 9.5: routing by the suffix after `/v1/admin/`, 405 with
`allow`, `404 not_found` on an unknown path, never CORS, the same-site check on
every POST (`403 cross_site`), JSON bodies capped at 16 KB, `cache-control:
no-store`, `{ error: { code, message, issues? } }`, an unexpected error a
`500 internal` with a fixed sentence and the error to `onError`.

| kind | method | path | permission | query / body → 200 |
| --- | --- | --- | --- | --- |
| `count` | GET | `v1/admin/count` | `alerts.view` | → `AlertCountWire` |
| `list` | GET | `v1/admin/alerts` | `alerts.view` | query `unread=1&cursor=&limit=` → `AlertListWire` |
| `read` | POST | `v1/admin/alerts/{alert}/read` | `alerts.view` | `{}` → `AlertCountWire`; another person's or company's id → `404 not_found` "That alert isn't here." |
| `read-all` | POST | `v1/admin/read-all` | `alerts.view` | `{}` → `AlertCountWire` |
| `preferences` | GET | `v1/admin/preferences` | `alerts.view` | → `PreferencesWire` |
| `preference-set` | POST | `v1/admin/preferences` | `alerts.view` | `PreferenceBody` → `PreferencesWire`; example `{ kind: "unknown.kind", channel: "in_app" }` (→ 400) |
| `routing` | GET | `v1/admin/routing` | `alerts.manage` | → `RoutingWire` |
| `routing-set` | POST | `v1/admin/routing` | `alerts.manage` | `RoutingBody` → `RoutingWire`; example `{ key: "estimates", mode: "chosen", userIds: ["{person}"], extraEmails: [] }` |

- `list`, `count`, `read` and `read-all` go through the reader filter (4.5
  Reads): alerts of kinds no longer registered (an uninstalled feature), and
  of kinds the reader may no longer get (a demotion), are neither listed nor
  counted nor marked, so the badge and the list never disagree.
- `preferences` lists the kinds whose `audience.permission` (or
  `assigned.permission`) the person holds, in registry order, with their
  channel; `emailOffered` false with `emailNote` ("This site doesn't send
  email yet, so alerts stay in the app." / "There's no email address on your
  account." / "This alert is only shown in the app." / for a kind in
  `offKinds`: "Emails for this are switched off in Messages
  ("{offKinds[kind]}"). Turn it back on there.", with `emailOffInMessages`
  true so the widget links to `links.messages`); `routed` for a routed kind
  ("You're on the list for these." / for someone reached through assignment
  (they hold the kind's `assigned.permission`), "You get these for visits on
  your crew." / otherwise "Only the people chosen in 'Who hears about new
  work' get these."; review BO-12); `canManageRouting` from an ask for
  `alerts.manage`.
- **Reachable (review BO-12).** `count` and `preferences` answer `reachable`:
  true when the person holds the permission of at least one kind with no
  routing, is on (or is the owner fallback of) at least one routing group, or
  holds an `assigned.permission`. False: the bell's empty state and Alert
  settings say "You're not on any alert lists yet. The owner chooses who
  hears about new work in Alert settings." Kinds the person can't get now (a
  routed kind they aren't on, and not reachable through assignment) show no
  radios: they are listed under "Not on your list" with that sentence.
- `routing` answers, per group, `ownerEmail`: where the owner's copies go
  while the group is on "The owner" (`ownerEmail(tenantId)`, else the owner's
  own address; review BO-01), with `ownerEmailIsBusiness` true when the seam
  answered an address other than the owner's own (case-insensitively); and
  `emailNote` when the group's kinds are in `offKinds`.
- `hrefFor` is applied to every `AlertWire.href`.
- `preference-set` validates with zod, then `setChoice`; an
  `AlertsInputError` is `400 invalid` with its issues on `kind` or `channel`.
- `routing-set`: issues never name an id ("Pick people from your company." on
  `userIds`), so an id of A's sent by B is not echoed.

### 4.8 Wire (both copies: `notifications/src/wire.ts` and `notifications-widget/src/types.ts`, inside `// WIRE:BEGIN` / `// WIRE:END`)

```ts
export type Instant = string;
export type AlertsErrorCode = "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: AlertsErrorCode; message: string; issues?: WireIssue[] } }

export interface AlertWire {
  id: string;
  kind: string;
  /** Its kind's category, for the icon and the group heading: "Estimates", "Visits", … */
  category: string;
  title: string;
  body: string | null;
  /** A path on this site; null = nothing to open. */
  href: string | null;
  at: Instant;
  read: boolean;
}
export interface AlertCountWire {
  unread: number;
  /** False: this person is on no alert list and gets no kind directly (review BO-12); the bell's empty state says so. */
  reachable: boolean;
}
export interface AlertListWire {
  alerts: AlertWire[];
  nextCursor: string | null;
  unread: number;
  reachable: boolean;
  links: { inbox: string | null; settings: string | null };
}

export type AlertChannelWire = "in_app" | "email";
export interface AlertChoiceWire {
  kind: string;
  label: string;
  description: string | null;
  category: string;
  channel: AlertChannelWire;
  /** False: only "In the app" can be picked, and `emailNote` says why. */
  emailOffered: boolean;
  emailNote: string | null;
  /** True when the email is switched off in Messages: the widget links `emailNote` to `links.messages` (review BO-11). */
  emailOffInMessages: boolean;
  /**
   * A routed kind: the group's label, whether this person is on its list, and
   * whether they get it through assignment (crew on their own visits; review
   * BO-12). null = not routed.
   */
  routed: { group: string; onList: boolean; viaAssigned: boolean } | null;
  /** False: they can't get this kind now; listed under "Not on your list", no radios (review BO-12). */
  receives: boolean;
}
export interface PreferencesWire {
  /** Where this person's alert emails go; null = no address. */
  emailAddress: string | null;
  emailAvailable: boolean;
  emailOffReason: string | null;
  categories: string[];
  choices: AlertChoiceWire[];
  canManageRouting: boolean;
  reachable: boolean;
  links: { messages: string | null };
}
export interface PreferenceBody { kind: string; channel: AlertChannelWire }

export interface RoutingPersonWire { userId: string; name: string | null; email: string | null; isOwner: boolean }
export interface RoutingGroupWire {
  key: string;
  label: string;
  description: string | null;
  /** The labels of the alerts it carries ("This covers: …"). */
  covers: string[];
  mode: "owner" | "chosen";
  userIds: string[];
  extraEmails: string[];
  /** Who may be picked: members holding the group's permission. */
  candidates: RoutingPersonWire[];
  /** Where the owner's email copies go while this group is on "The owner" (the business email, else the owner's own; review BO-01). null: no address. */
  ownerEmail: string | null;
  /** True when ownerEmail is the business email from company settings, not the owner's own sign-in address. */
  ownerEmailIsBusiness: boolean;
  /** The kinds' emails are switched off in Messages: the sentence to show (review BO-11). null = not. */
  emailNote: string | null;
}
export interface RoutingWire { groups: RoutingGroupWire[] }
export interface RoutingBody { key: string; mode: "owner" | "chosen"; userIds: string[]; extraEmails: string[] }
```

A user id is on the wire only to tick a box; no screen shows it.

### 4.9 The alert email (root)

```ts
/** The comms template the host sends alert email copies with (D5). Insert it per company if absent (never over an owner's edit). */
export const TEAM_ALERT_EMAIL_TEMPLATE: { readonly key: "team_alert"; readonly subject: string; readonly body: string };
```

```
Subject: {{title}}

{{body}}

{{linkLine}}

{{settingsLine}}
```

The host supplies `title`, `body` (empty for none), `linkLine` ("Open it:
{absolute link}" or empty), `settingsLine` ("Change which alerts you get by
email: {absolute link to Alert settings}"; for an `addressOnly` message,
"You get this because {businessName} added this address." with no link,
since that address has no sign-in; review BO-17) and `businessName`. Each
line that is only a variable folds away when empty (comms' HTML rule).

**A host without comms (Ridgeline on nodemailer; reviews G12, BO-17)** renders
the same email with one pure function:

```ts
/**
 * The team alert email, in TEAM_ALERT_EMAIL_TEMPLATE's exact words. Every
 * value is HTML-escaped in `html`; `breakLinks` is applied to the title and
 * body (again: harmless twice); CR, LF, U+2028 and U+2029 are stripped from
 * `subject`; empty lines fold away. `link` and `settingsLink` are absolute
 * URLs the host built (null: that line is left out). For an `addressOnly`
 * message `settingsLink` is ignored and the settings line reads "You get this
 * because {businessName} added this address."
 */
export function renderAlertEmail(
  message: AlertEmailMessage,
  options: { readonly businessName: string; readonly link: string | null; readonly settingsLink: string | null },
): { readonly subject: string; readonly text: string; readonly html: string };
```

The README's Ridgeline sample is exactly:

```ts
email: async (m) => {
  const mail = renderAlertEmail(m, { businessName: company.name, link: m.href ? new URL(m.href, APP_URL).href : null, settingsLink: new URL("/alerts/settings", APP_URL).href });
  await transporter.sendMail({ from: `${company.name} <alerts@ridgeline.example>`, to: m.to, replyTo: m.replyTo ?? undefined, subject: mail.subject, text: mail.text, html: mail.html });
  return { status: "sent" };
},
// nodemailer has no idempotency key: leave emailIdempotent unset (false).
```

create-app's comms seam (13.5) builds `settingsLine` by the same rule.

### 4.10 0.1's API, kept

`notify(db, input)`, `listNotifications`, `unreadCount(db, recipientId)`,
`markNotificationRead`, `markAllRead`, `notifySchema`, `NotifyInput`,
`NotificationRow` keep their signatures, on the default tables (the only
place the default is implicit, D14), with `tenant_id = '*'` (written and
filtered). Each has `@deprecated` naming the instance method that replaces
it. A test runs 0.1's suite against 0.2 on PGlite.

### 4.11 Package

- `dependencies`: `uuidv7 ^1.2.1` (drop `@adminigloo/db`, D14).
- `peerDependencies`: `drizzle-orm` (`catalog:peers`), `zod` (`catalog:peers`).
- `devDependencies`: add `@electric-sql/pglite ^0.5.8`; `vitest.config.ts`
  with PGlite timeouts (comms' file).
- `files`: `dist`, `sql`, `README.md`. Exports `.`, `./schema` (unchanged
  entries) and `./testing` (new, 4.12). Root exports: everything in 4.2–4.10
  (with `renderAlertEmail`, `AlertReader`, `AlertsUnavailableError`),
  `notificationsPermissions`, `NOTIFICATIONS_ADMIN_ROUTES`, the route types,
  and `export type * from "./wire.js"`.

### 4.12 `./testing`: `checkHostSeams` (review G19)

```ts
export interface HostSeamsCheckResult {
  readonly ok: boolean;
  /** One line per check, in plain words: "A member of Company A can't read Company B's alerts: passed". */
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}
export function checkHostSeams(input: {
  /** The host's mounted handlers (`createNotificationHandlers(…)`, as the host builds them). */
  readonly handlers: { handle(req: Request): Promise<Response> };
  /**
   * Builds a request to `path` (e.g. "v1/admin/count") IN company `tenantId`,
   * the way the host routes a company (a path segment, a header, a cookie),
   * signed in as `member`: an active member of A and NOT of B. `init` may add
   * a query string or a body.
   */
  readonly request: (tenantId: string, path: string, init?: { readonly method?: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown }) => Request;
  readonly companyA: string;
  readonly companyB: string;
  readonly member: { readonly userId: string };
  /** The host's `people` seam, checked directly. */
  readonly people?: (tenantId: string, permission: string) => Promise<readonly { readonly userId: string }[]>;
  /** A permission the member holds in A (default "alerts.view"). */
  readonly permission?: string;
}): Promise<HostSeamsCheckResult>;
```

Checks, each a line: (1) `count` in A answers 200; (2) `count` in B answers
401, 403 or 404, never 200; (3) `count` in B with `?tenantId={A}&tenant={A}`
is still refused (the company can't be steered by a query); (4) the same-site
check holds: a `read-all` POST in A with `origin: https://elsewhere.example`
answers 403 `cross_site`; (5) with `people`: `people(A, permission)` contains
the member, `people(B, permission)` doesn't. Never throws (a throw is a
failed line). It writes nothing. Entry `./testing` (tsup and `exports`).

---

## 5. `@adminigloo/notifications-widget` 0.1.0 (alerts builder)

New package, created at `0.0.0` by step 0 of section 18. React is its only
peer, plus `@adminigloo/notifications ^0.2.0` as an OPTIONAL peer (and a
workspace devDependency used ONLY by the wire-parity test). Entries `.` (wire
types, `NOTIFICATIONS_WIRE_VERSION = "v1"`, the transport) and `./admin` (the
three components). Copy the transport, theme, style-injection and dialog
pieces from comms-widget (never import). CSS prefix `ainw-`, root `.ainw-root`,
tokens `--ainw-*`, AA in light and dark (tested), 44 px targets under 640 px,
SSR-safe, never throws, `role="status"` for outcomes.

```ts
export interface AlertsTransport {
  count(): Promise<Result<AlertCountWire>>;
  list(q?: { unread?: boolean; cursor?: string; limit?: number }): Promise<Result<AlertListWire>>;
  markRead(id: string): Promise<Result<AlertCountWire>>;
  markAllRead(): Promise<Result<AlertCountWire>>;
  preferences(): Promise<Result<PreferencesWire>>;
  setPreference(body: PreferenceBody): Promise<Result<PreferencesWire>>;
  routing(): Promise<Result<RoutingWire>>;
  setRouting(body: RoutingBody): Promise<Result<RoutingWire>>;
}
export function createAlertsClient(options: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }): AlertsTransport;
```

**`<AlertsBell>`** (`./admin`):

```ts
interface AlertsBellProps {
  baseUrl?: string; transport?: AlertsTransport;
  /** Background count refresh while the page is visible, in ms. Default 60000; 0 off. */
  pollMs?: number;
  locale?; theme?; nonce?; className?; style?;
}
```

- A 44 px icon button with the unread count as a badge: hidden at 0, the
  number up to 99, "99+" past it. `aria-label`: "Alerts" / "Alerts, 3 unread".
- The count is fetched on mount, every `pollMs` while
  `document.visibilityState === "visible"`, and again on focus and on
  becoming visible (Ask Lou's bubble, without the drift). **Idle backoff
  (review BO-25):** after 15 minutes with no pointer or keyboard input, the
  poll slows to every 10 minutes; the first input, a focus or becoming
  visible fetches at once and returns to `pollMs`. An office PC left on the
  schedule all day costs six requests an hour, not sixty.
- A `count` answered 401 or 403 renders NOTHING and stops polling (someone
  who can't get alerts here, e.g. a staff member without the key in single
  mode); a network failure keeps the last count and tries again on the next
  tick.
- Open: the latest 10 (`list({ limit: 10 })`), newest first, unread in bold
  with a dot, each with its category icon, title, body's first line and "3 min
  ago"; "Mark all as read"; "See all alerts" (`links.inbox`) and "Alert
  settings" (`links.settings`) when the server gives them. Empty: "Nothing
  new. Alerts about your work show up here."; with `reachable: false`:
  "You're not on any alert lists yet. The owner chooses who hears about new
  work in Alert settings." (review BO-12).
- Choosing an alert marks it read (`markRead`), then goes to its `href` with
  `window.location.assign`, only when `new URL(href, location.origin).origin
  === location.origin` and the href matches D18's pattern (review G15:
  `/\evil.com` is not followed); anything else is not followed. One with no
  `href` is just marked read.
- Desktop (≥ 640 px): a popover under the button, 360 px wide. Phone: a sheet
  across the top of the screen, full width, focus trapped, Escape and a Close
  button close it. Nothing scrolls sideways at 360 px.
- TWO TABS: after a mark, it posts `{ unread }` on a `BroadcastChannel`
  named `ainw:{baseUrl}`; other tabs set their badge and reload an open list.
  No BroadcastChannel (old browsers, SSR): the poll covers it.

**`<AlertsInbox>`** (`./admin`, the full page):

```ts
interface AlertsInboxProps { baseUrl?: string; transport?: AlertsTransport; locale?; theme?; nonce?; className?; style? }
```

All / Unread, grouped by day ("Today", "Yesterday", "Mon, Nov 2"), "Load
more", "Mark all as read", a link to Alert settings. The same open-and-mark
rule as the bell. It shares the bell's channel, so the header's badge follows.

**`<AlertSettings>`** (`./admin`):

```ts
interface AlertSettingsProps { baseUrl?: string; transport?: AlertsTransport; locale?; theme?; nonce?; className?; style? }
```

1. **How you get each alert.** One section per category; per kind its label,
   description, and two radios, "In the app" and "In the app and by email"
   (the second disabled, with `emailNote`, when not offered; with
   `emailOffInMessages`, the note links to `links.messages`). Under a routed
   kind: the `routed` sentence. Kinds with `receives: false` have no radios
   and are listed together at the end under "Not on your list", with the
   sentence "The owner chooses who hears about new work in Alert settings."
   (review BO-12). A change saves at once (`setPreference`) and says "Saved."
   in the status region; a refusal restores the old choice and shows the
   server's sentence. The top line: "Alert emails go to {emailAddress}." or
   `emailOffReason`; with `reachable: false`, the BO-12 sentence first.
2. **Who hears about new work** (only with `canManageRouting`, from
   `routing()`). One card per group: its label, "This covers: …", and two
   choices: "The owner ({name})" (mode `owner`), followed, when
   `ownerEmailIsBusiness`, by "Emails go to {ownerEmail}, the business email
   in company settings." (review BO-01), or "These people" (mode `chosen`): a
   checklist of `candidates` (name, then email in muted text) and "Also email
   these addresses (up to 5)" (each validated as an email before sending).
   `emailNote`, when set, under the label. Save per card. A list with nobody
   ticked says before saving: "Nobody is ticked, so the owner gets these in
   the app." and, with addresses, "These addresses still get the emails."
   (review BO-20).

Exports: `.` → `createAlertsClient`, `AlertsTransport`, `Result`,
`ClientError`, `NOTIFICATIONS_WIRE_VERSION`, the wire types; `./admin` →
`AlertsBell`, `AlertsInbox`, `AlertSettings`, their props types,
`createAlertsClient`, `injectAlertsStyles`, `alertsWidgetCss`,
`NOTIFICATIONS_WIRE_VERSION`.

---

## 6. `@adminigloo/storage` 0.2.0 (files builder)

Everything 0.1 exported keeps working (6.11). The package never imports a
vendor SDK: the Vercel Blob adapter is handed the SDK's functions by the host
(6.2), the S3-compatible one signs its own requests.

### 6.1 Schema (`./schema`)

```ts
export interface DefineStorageTablesOptions {
  /** "" (default: the 0.1 name) or /^[a-z][a-z0-9_]{0,30}_$/. */
  readonly prefix?: string;
  /** A Postgres schema of the host's; default none. */
  readonly schema?: string;
}
export interface StorageTables { readonly prefix: string; readonly schema: string | null; readonly files: PgTable }   // "{prefix}stored_files"
export function defineStorageTables(options?: DefineStorageTablesOptions): StorageTables;
export const storageTables: StorageTables;
/** 0.1's export name: the same table. */
export const storedFiles: StorageTables["files"];
export function storageSql(options?: DefineStorageTablesOptions): string;
export class InvalidTableNameError extends Error { readonly name = "InvalidTableNameError" }
```

**`{prefix}stored_files`** (one row per file; 0.1's column names kept, so a
0.1 install upgrades with ALTERs):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text` primary key | uuidv7 (the package's own) |
| `tenant_id` | `text not null` | the company (`'*'`: 0.1's firm-wide rows) |
| `owner_id` | `text` | WHO ADDED IT (0.1's name). 0.2: nullable; null = the customer or the system |
| `kind` | `text not null` | the PURPOSE key (0.1's name) |
| `filename` | `text not null` | the name shown, `sanitizeFilename`d |
| `content_type` | `text not null` | from the bytes (6.3) |
| `size_bytes` | `integer not null` | measured, never the caller's number |
| `pathname` | `text not null` | the store's key (0.1's name). Never on the wire |
| `url` | `text` | a PUBLIC file's address; null for a private one (0.1: not null) |
| `access` | `text not null default 'public'` | `private` · `public` (0.1's rows were public; 0.2 always writes it) |
| `record_type`, `record_id` | `text` | the record it belongs to (D12) |
| `width`, `height` | `integer` | an image's size, from its header |
| `sha256` | `text` | hex; the content route's ETag |
| `deleted_at` | `timestamptz` | D13 |
| `purge_attempts` | `integer not null default 0` | D13 |
| `created_at` | `timestamptz not null default now()` | |

Indexes: 0.1's `stored_files_tenant_created_idx` and
`stored_files_tenant_kind_idx` (names kept); unique
`stored_files_pathname_uidx (pathname)`; `stored_files_record_idx (tenant_id,
record_type, record_id) where deleted_at is null`; `stored_files_live_idx
(tenant_id, created_at, id) where deleted_at is null`; `stored_files_purge_idx
(deleted_at) where deleted_at is not null`.

Shipped SQL: `sql/storage-0.2.0.sql` (= `storageSql()`, asserted) and
`sql/upgrade-0.1-to-0.2.sql`, each opening with 4.1's guard (review G1): the
create raises "A table named {name} already exists and isn't AdminIgloo's.
Pass a prefix or a schema." when `{prefix}stored_files` exists without
`purge_attempts` (pointing a 0.1 install at the upgrade, as 4.1's does); the
upgrade raises unless the table has exactly 0.1's columns (`id`,
`tenant_id`, `owner_id`, `kind`, `filename`, `content_type`, `size_bytes`,
`pathname`, `url`, `created_at`) and the index
`stored_files_tenant_created_idx`. Then:

```sql
alter table stored_files
  alter column owner_id drop not null,
  alter column url drop not null,
  add column if not exists access text not null default 'public',
  add column if not exists record_type text,
  add column if not exists record_id text,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists sha256 text,
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_attempts integer not null default 0;
-- then the four new indexes, "if not exists"
```

0.1's rows stay public files of the firm-wide library; the README says how to
move them under a business (`update stored_files set tenant_id = '<id>' where
tenant_id = '*'`). **Said plainly in the README's "Upgrading from 0.1" (review
G11):** every 0.1 row, and every 2a estimator photo (2a kept them through
0.1's `storeFile`), is upgraded as `access: 'public'` and stays at its old
public address until it is moved; `storage.moveToPrivate({ purpose })` (6.6)
copies each into the private store, rewrites its row and deletes the public
object, and create-app's files cron runs it for `estimator.photo`.

### 6.2 The store interface and the adapters

```ts
export interface BlobObject {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly contentType: string | null;
  readonly size: number | null;
}
export interface BlobStore {
  /** "private" never hands out a URL. "public": `put` answers the address anyone may open, or null when the host serves it (6.8). */
  readonly access: "private" | "public";
  put(key: string, bytes: Uint8Array, options: { readonly contentType: string; readonly cacheControl?: string }): Promise<{ readonly url: string | null }>;
  /** null when there is no such object. */
  get(key: string): Promise<BlobObject | null>;
  /** Resolves once the object is gone (or was never there). */
  delete(key: string): Promise<void>;
  /**
   * Private stores only, optional (review G9): is this store really private?
   * S3-compatible: puts a probe object, fetches it with an UNSIGNED GET (which
   * must answer 403 or 404), deletes the probe. Vercel Blob: the store's URL
   * host. Memory and local disk: always ok. Never throws ({ ok: false, reason }).
   */
  checkPrivate?(): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
}
/**
 * Every key a 0.2 store is handed (D10, review G7), checked by EVERY adapter
 * (s3, vercel-blob, local, memory) before any I/O; anything else throws
 * `InvalidKeyError` and touches nothing:
 *   private: t/{16 hex}/{YYYY}/{MM}/{32 hex}.{ext}
 *   public:  p/{32 base64url}.{ext}
 * plus, for `get` and `delete` ONLY, the legacy shapes 0.1 and 2a wrote:
 *   t/{tenant id}/{uuid}-{filename}   (0.1's storeFile, 2a's estimator photos)
 *   tenancy/logos/{tenant id}/{uuid}.{ext}   (2a's logos)
 * where no segment is "." or "..", and no character is "%", "\", or a
 * control character.
 */
export const STORAGE_KEY_PATTERN: RegExp;   // /^(t\/[0-9a-f]{16}\/\d{4}\/\d{2}\/[0-9a-f]{32}|p\/[A-Za-z0-9_-]{32})\.[a-z]{3,4}$/
export function isLegacyKey(key: string): boolean;
export class InvalidKeyError extends Error { readonly name = "InvalidKeyError" }
/** 0.1's two-method adapter, for the deprecated 0.1 functions only. */
export interface BlobStoreV1 {
  put(pathname: string, body: BlobBody, options: { contentType: string }): Promise<{ url: string; pathname: string }>;
  delete(pathname: string): Promise<void>;
}
```

`BlobStore` is a NEW shape under 0.1's name (0.1's is now `BlobStoreV1`). The
changeset and the README's upgrade section say so; 0.1's functions take
`BlobStoreV1`, so an old adapter object still compiles against them.

**`./vercel-blob`**:

```ts
/** The four @vercel/blob functions the adapter uses, passed in by the host (`import * as sdk from "@vercel/blob"`), so this package never depends on it. */
export interface VercelBlobSdk {
  put(pathname: string, body: Buffer, options: Record<string, unknown>): Promise<{ url: string; pathname: string }>;
  get(pathname: string, options: Record<string, unknown>): Promise<{ stream: ReadableStream<Uint8Array>; blob?: { contentType?: string; size?: number } } | null>;
  head(pathname: string, options: Record<string, unknown>): Promise<{ url: string; contentType?: string; size?: number }>;
  del(pathname: string, options: Record<string, unknown>): Promise<void>;
}
export function createVercelBlobStore(options: {
  readonly sdk: VercelBlobSdk;
  readonly token: string;
  readonly access: "private" | "public";
  /** Public stores only: seconds. Default one year (keys are never reused). */
  readonly cacheControlMaxAge?: number;
}): BlobStore;
```

`put` passes `{ access, token, contentType, addRandomSuffix: false,
allowOverwrite: false }` (the key is already random) and answers `blob.url` for
a public store, null for a private one. **A "private" store that isn't (review
G9):** when a private store's `put` gets back a `blob.url` whose host ends in
`.public.blob.vercel-storage.com`, it deletes the object and throws
`StorageError("storage_off")` with "The private file store's token belongs to
a public store. Connect a private Blob store for photos and files." — the
file is never kept where anyone can open it; `checkPrivate` makes the same
host check on a probe. `get` on a private store is the SDK's `get(key, {
access: "private", token })`; on a public one `head` then `fetch`. A
not-found from the SDK is null, not a throw. `delete` is `del(key, { token
})`. A test drives it with a fake SDK object.

**`./s3`** (R2, MinIO, AWS S3; no SDK: `fetch` and `node:crypto` SigV4):

```ts
export interface S3CompatibleStoreOptions {
  /** "https://<account>.r2.cloudflarestorage.com", "http://localhost:9000", "https://s3.us-east-1.amazonaws.com". */
  readonly endpoint: string;
  /** Default "auto" (R2); MinIO's default is "us-east-1". */
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly access: "private" | "public";
  /** A public bucket's own address ("https://files.example.com"). Required for access "public": `put` answers `${publicBaseUrl}/${key}`. */
  readonly publicBaseUrl?: string;
  /** {endpoint}/{bucket}/{key}. Default true (R2 and MinIO need it). */
  readonly pathStyle?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}
export function createS3CompatibleStore(options: S3CompatibleStoreOptions): BlobStore;
/** Query-string SigV4 (exported for the test vector and for hosts that presign elsewhere; the package itself never redirects to a presigned URL, D10). */
export function presignS3Url(input: {
  readonly method: "GET" | "PUT"; readonly url: string; readonly region: string;
  readonly accessKeyId: string; readonly secretAccessKey: string;
  readonly expiresInSeconds: number; readonly now: Date;
  readonly query?: Readonly<Record<string, string>>;
}): string;
/** Header SigV4 for one request (exported for the second test vector, review BO-16). */
export function signS3Request(input: {
  readonly method: "GET" | "PUT" | "DELETE"; readonly url: string; readonly region: string;
  readonly accessKeyId: string; readonly secretAccessKey: string; readonly now: Date;
  readonly headers: Readonly<Record<string, string>>;
  /** Hex sha256 of the body ("e3b0c442…b855" for none). */
  readonly payloadHash: string;
}): Readonly<Record<string, string>>;   // the headers to send, Authorization included
```

PUT, GET and DELETE are signed with the Authorization header (`UNSIGNED-PAYLOAD`
is not used: the body hash is computed). The request URL is built by joining
`{endpoint}/{bucket}/` with the key's segments, each encoded with
`encodeURIComponent` (and the RFC 3986 extras SigV4 needs), never by passing a
path through `new URL()` normalisation (review G7), and the key has passed
`STORAGE_KEY_PATTERN` first. A 404 on GET is null; a DELETE of a missing
object resolves. `checkPrivate` puts a few probe bytes under a private-shaped
key (`t/0000000000000000/{YYYY}/{MM}/{32 hex random}.txt`), GETs
`{endpoint}/{bucket}/{key}` with NO
signature (plain `fetch`), expects 403 or 404, and deletes the probe; a 200
answers `{ ok: false, reason: "The private bucket lets anyone read its files.
Remove its public access policy." }`. **Two fixed test vectors (review BO-16),
both AWS's documented examples:**
1. presigned GET: bucket `examplebucket`, key `test.txt`,
   `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
   `us-east-1`, `20130524T000000Z`, 86400 s, virtual-hosted →
   `X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`;
2. header-signed GET Object: `GET https://examplebucket.s3.amazonaws.com/test.txt`,
   header `Range: bytes=0-9`, `x-amz-content-sha256` of the empty body
   (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`),
   `x-amz-date: 20130524T000000Z`, `us-east-1`, the same keys → `Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`.

A fake S3 server (`node:http`, in the test) checks the round trip: it RECORDS
each request and checks the header SHAPE (Authorization present with
`AWS4-HMAC-SHA256 Credential=…/{date}/{region}/s3/aws4_request,
SignedHeaders=…, Signature={64 hex}`, `x-amz-date`, `x-amz-content-sha256`
equal to the body's hash) and the path's encoding; it never verifies a
signature with the package's own signer (that would prove nothing: the two
vectors do). `e2e/README.md` lists "no real R2 or MinIO" as not proven.

**`./local`** (development only; the README says so):

```ts
export function createLocalDiskStore(options: { readonly dir: string; readonly access: "private" | "public" }): BlobStore;
```

A key must pass `STORAGE_KEY_PATTERN` (or, for `get` / `delete`, the legacy
check), else it throws `InvalidKeyError` before touching the disk; the object
is `{dir}/{key}`, resolved and checked to stay inside `dir`, and its type sits
beside it in `{key}.type`. `put` answers url null: public files are then
served by the package's public route (6.8).

**`./testing`**:

```ts
export interface MemoryBlobStore extends BlobStore {
  readonly objects: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly contentType: string }>;
  /** The next call of that kind rejects once (a store that fails). */
  failNext(op: "put" | "get" | "delete"): void;
}
export function createMemoryBlobStore(options: { readonly access: "private" | "public"; readonly publicBaseUrl?: string }): MemoryBlobStore;
```

With `publicBaseUrl`, a public `put` answers `${publicBaseUrl}/${key}` (the e2e
fixture serves it); otherwise null. The memory store checks keys like every
adapter, so the package's own tests exercise the refusal.

### 6.3 File types (root)

```ts
export type FileTypeKey = "jpeg" | "png" | "webp" | "gif" | "heic" | "pdf";
export const FILE_TYPES: Readonly<Record<FileTypeKey, {
  readonly contentType: string; readonly ext: string; readonly image: boolean;
  /** In words: "JPEG photo", "iPhone photo (HEIC)", "PDF". */
  readonly label: string;
}>>;
/** The type the BYTES are, or null. Never trusts a declared type. */
export function sniffFileType(bytes: Uint8Array): FileTypeKey | null;
/** jpeg/png/webp/gif header dimensions (copy the estimator's image.ts reading; never import). */
export function imageSize(bytes: Uint8Array, type: FileTypeKey): { readonly width: number; readonly height: number } | null;
export function formatBytes(bytes: number, locale?: string): string;   // "412 KB", "3.1 MB", "1 GB"
```

Magic numbers: jpeg `FF D8 FF`; png `89 50 4E 47 0D 0A 1A 0A`; webp `RIFF`
then `WEBP` at 8; gif `GIF87a` / `GIF89a`; heic `ftyp` at 4 with a brand at 8 in
`heic heix hevc hevx mif1 msf1`; pdf `%PDF-`. Anything else, SVG and HTML
included, is null.

### 6.4 Purposes (root)

```ts
export interface StoragePurpose {
  /** /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){0,3}$/. Permanent (stored in `kind`). */
  readonly key: string;
  /** "Photo or file" */
  readonly label: string;
  readonly access: "private" | "public";
  readonly types: readonly FileTypeKey[];
  /** The most one file of this purpose may be. */
  readonly maxBytes: number;
  /** Counted in the usage, never refused for the allowance (D11). */
  readonly exemptFromAllowance?: boolean;
  /**
   * 0–1 (review G6). This purpose's live bytes plus a new file must stay
   * within this share of the allowance, checked under the same lock as the
   * allowance (6.6 steps 5 and 8), whether or not it is exempt. Absent: no
   * share. No allowance (null): no share either.
   */
  readonly maxShareOfAllowance?: number;
  /** On top of `files.view` (D12, review G5): one of these is also needed to open a file of this purpose while it is on no record. Default ["files.view"]. */
  readonly view?: readonly string[];
  /** Offer Remove on the Files screen. Default true. false: it is removed where it is used. */
  readonly removableFromFiles?: boolean;
  /** Left off the Files screen until it is attached to a record (a customer's photo with no estimate yet, purged after 48 h by its feature; review BO-13). Default false. Still counted. */
  readonly hiddenUntilAttached?: boolean;
}
export const STORAGE_BUILT_IN_PURPOSES: readonly StoragePurpose[];
```

| key | label | access | types | maxBytes | other |
| --- | --- | --- | --- | --- | --- |
| `attachment` | "Photo or file" | private | jpeg, png, webp, gif, heic, pdf | 4 MiB | on a record (D12) |
| `library` | "Company file" | private | jpeg, png, webp, gif, heic, pdf | 4 MiB | the Files screen's own uploads |
| `company.logo` | "Company logo" | **public** | png, jpeg, webp | 1 MiB | `exemptFromAllowance`, `removableFromFiles: false`, `view: ["tenant.view"]` |

The estimator contributes `estimator.photo` (10.5). 2b-2's feedback board will
contribute `feedback.screenshot`.

### 6.5 Record types (root)

`StorageRecordType` is exactly 3.5's `<Pkg>FileRecordType`. Duplicate types
refused by `createStorage`.

### 6.6 The instance (root)

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StorageDb = PgDatabase<any, any, any>;   // 0.1's name

export interface CreateStorageOptions {
  readonly db: StorageDb;
  /** REQUIRED (D14, review G1): `storageTables` for the 0.1 name, or `defineStorageTables({ prefix, schema })`. */
  readonly tables: StorageTables;
  /** D10. A missing store switches that access off with a sentence. A store whose `access` doesn't match its slot throws InvalidStoreError here. */
  readonly stores: { readonly private?: BlobStore; readonly public?: BlobStore };
  /** Default STORAGE_BUILT_IN_PURPOSES. A duplicate key throws. */
  readonly purposes?: readonly StoragePurpose[];
  readonly records?: readonly StorageRecordType[];
  /** D11. null = no allowance. Default: no allowance. The billing chunk passes the plan's here. */
  readonly allowanceBytes?: (tenantId: string) => number | null | Promise<number | null>;
  /**
   * Signed links (D10). Absent: none are minted. `secret` ≥ 32 characters;
   * `ttlSeconds` default 3600, 60–3600 ("short-lived", review G2).
   * `stillValid` is REQUIRED with `signing`: asked on every open, after the
   * MAC and expiry checks, with the company, the person who made the link and
   * when; false (or a throw, reported) answers the same 404 as a bad link.
   * create-app: the company is active AND the person is still an active member.
   */
  readonly signing?: {
    readonly secret: string;
    readonly ttlSeconds?: number;
    readonly stillValid: (input: { readonly tenantId: string; readonly userId: string; readonly issuedAt: Date }) => Promise<boolean>;
  };
  /**
   * Told after every `store` and every refusal for the company's allowance
   * (not a purpose's share: the company itself isn't full; review BO-07),
   * awaited and contained (a throw is reported, never fails the upload). The
   * host turns it into the "Files" alerts (6.15).
   */
  readonly onUsage?: (event: {
    readonly tenantId: string;
    readonly usage: { readonly usedBytes: number; readonly fileCount: number; readonly allowanceBytes: number | null };
    /** "refused": a file was refused for the allowance (not for a purpose's share). */
    readonly outcome: "stored" | "refused";
    readonly purpose: string;
  }) => void | Promise<void>;
  readonly urls: {
    /** The signed-in content route of a file, e.g. (t, id) => `/api/app/${t}/files/v1/admin/files/${id}/content`. */
    readonly content: (tenantId: string, fileId: string) => string;
    /** Where the public handler (6.8) is mounted, absolute: "https://app.example.com/api/files". */
    readonly publicBase: string;
  };
  /** Default 4 MiB (D11). */
  readonly maxUploadBytes?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly step: string }) => void;
}
export function createStorage(options: CreateStorageOptions): Storage;

export interface StoredFile {
  readonly id: string; readonly tenantId: string; readonly purpose: string;
  readonly access: "private" | "public";
  readonly filename: string; readonly contentType: string; readonly sizeBytes: number;
  readonly width: number | null; readonly height: number | null; readonly sha256: string;
  readonly record: { readonly type: string; readonly id: string } | null;
  readonly addedBy: string | null;
  /** Public files only. */
  readonly publicUrl: string | null;
  readonly createdAt: Date;
  /** The store's key. SERVER ONLY: no wire type has a field for it (D10). */
  readonly key: string;
}
export interface StoreInput {
  readonly tenantId: string;
  readonly purpose: string;
  readonly bytes: Uint8Array;
  /** What the browser said: a hint for the file name's extension only. */
  readonly declaredType?: string | null;
  readonly filename?: string | null;
  readonly addedBy?: string | null;
  readonly record?: { readonly type: string; readonly id: string } | null;
}
export type StorageErrorCode =
  | "storage_off" | "file_type" | "file_too_big" | "storage_full" | "not_removable"
  | "unknown_purpose" | "unknown_record" | "invalid";
/**
 * `name` is checked STRUCTURALLY by other packages (the estimator, 10.5):
 * `error.name === "StorageError"` and `error.code`, never `instanceof`.
 * `storage_full` from a purpose's share carries `share: true`.
 */
export class StorageError extends Error { readonly name = "StorageError"; readonly code: StorageErrorCode; readonly share?: boolean }
export class InvalidStoreError extends Error { readonly name = "InvalidStoreError" }

export interface Storage {
  readonly tables: StorageTables;
  readonly purposes: ReadonlyMap<string, StoragePurpose>;
  readonly records: ReadonlyMap<string, StorageRecordType>;
  readonly maxUploadBytes: number;
  /** Can files of this purpose be kept right now? */
  available(purpose: string): { readonly available: true } | { readonly available: false; readonly reason: string };
  /** The upload pipeline below. Throws StorageError. */
  store(input: StoreInput): Promise<StoredFile>;
  get(input: { readonly tenantId: string; readonly fileId: string }): Promise<StoredFile | null>;
  list(input: {
    readonly tenantId: string; readonly purpose?: string;
    /** One record's files; or every file on any record of `recordType`; or `recordType: null` for files on no record. */
    readonly record?: { readonly type: string; readonly id: string };
    readonly recordType?: string | null;
    /** Newest first (default) or largest first (review BO-22). */
    readonly sort?: "newest" | "largest";
    /** Default false: purposes with `hiddenUntilAttached` are left out while on no record (review BO-13). */
    readonly includeHidden?: boolean;
    readonly cursor?: string | null; readonly limit?: number;
  }): Promise<{ readonly files: readonly StoredFile[]; readonly nextCursor: string | null }>;
  /** The bytes, from `stores[row.access]` (D13, review G11); null when the row or the object is gone (a missing object is reported). */
  open(input: { readonly tenantId: string; readonly fileId: string }): Promise<{ readonly file: StoredFile; readonly object: BlobObject } | null>;
  /** D13: the object is deleted from `stores[row.access]`. */
  remove(input: { readonly tenantId: string; readonly fileId: string }): Promise<{ readonly removed: boolean; readonly objectRemoved: boolean }>;
  /** Sets (or moves) a file's record (review BO-13). An unknown record type is `unknown_record`; a file that isn't this company's: nothing, false. */
  attach(input: { readonly tenantId: string; readonly fileId: string; readonly record: { readonly type: string; readonly id: string } }): Promise<boolean>;
  usage(tenantId: string): Promise<{ readonly usedBytes: number; readonly fileCount: number; readonly allowanceBytes: number | null }>;
  /** null without `signing`, or for a file that isn't this company's. `userId` is the person making it (review G2): the link stops working when they leave. */
  signedLink(input: { readonly tenantId: string; readonly fileId: string; readonly userId: string; readonly ttlSeconds?: number }): Promise<{ readonly url: string; readonly expiresAt: Date } | null>;
  /** The public handler's two lookups (6.8). */
  resolveLink(token: string): Promise<StoredFile | null>;
  publicFile(randomPart: string): Promise<StoredFile | null>;
  /** The files cron (D13). */
  purgeDeleted(options?: { readonly limit?: number; readonly timeBudgetMs?: number }): Promise<{ readonly purged: number; readonly failed: number; readonly gaveUp: number }>;
  /**
   * Review G11: copies each live `access = 'public'` file of `purpose` into the
   * private store under a new private key, rewrites its row (`pathname`,
   * `access: 'private'`, `url: null`; the id, and so every link to it,
   * unchanged) and deletes the public object. A copy that fails leaves the
   * row as it was. Oldest first, within the budget. Without a private store:
   * nothing moves.
   */
  moveToPrivate(options: { readonly purpose: string; readonly tenantIds?: readonly string[]; readonly limit?: number; readonly timeBudgetMs?: number }):
    Promise<{ readonly moved: number; readonly failed: number; readonly stoppedEarly: boolean }>;
  /** Review G9: the private store's `checkPrivate`, or ok when it has none; `{ ok: false, reason: "File storage isn't switched on yet." }` without a private store. */
  checkPrivateStore(): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
  /** Tenancy's LogoStore, structurally (6.9). undefined without a public store. */
  logoStore(): StorageLogoStore | undefined;
  /** A store for one purpose, in the estimator's EstimatorPhotoStore shape (6.9). undefined without its store. */
  purposeStore(purpose: string): StoragePurposeStore | undefined;
}
```

`store(input)`, in order:

1. zod: `tenantId` 1–200; `purpose` known (else `unknown_purpose`, a
   programming error); `bytes` non-empty; `filename` ≤ 200 (sanitized; absent:
   "{purpose label} {YYYY-MM-DD}.{ext}"); `record.type` known (else
   `unknown_record`), `record.id` 1–200. After step 4's sniff, a filename
   whose extension isn't the sniffed type's `FILE_TYPES[type].ext` (`jpg` and
   `jpeg` count as one) gets that extension instead: `report.html` holding a
   PDF is kept and served as `report.pdf`, `photo` as `photo.jpg` (review G18).
2. The purpose's store is present, else `storage_off` "File storage isn't
   switched on yet, so files can't be kept."
3. `bytes.length <= purpose.maxBytes`, else `file_too_big` "That file is too
   big. Files can be up to {formatBytes(maxBytes)}."
4. `sniffFileType(bytes)` is one of `purpose.types`, else `file_type` "That
   kind of file can't be kept here. Use {the purpose's types in words}."
5. The room (D11), with `allowance = allowanceBytes(tenantId)` (null: skip
   both checks):
   - unless the purpose is exempt: `usage + size <= allowance`, else
     `storage_full` "Your storage is full: {used} of {allowance} used. Delete
     files you no longer need to make room." (the handlers re-word it per
     caller, 6.7), and `onUsage` with `outcome: "refused"`;
   - with `maxShareOfAllowance`: the purpose's live bytes in this company +
     size `<= share × allowance`, else `storage_full` with `share: true` and
     the sentence "There's no more room for these right now." (no `onUsage`
     refusal: the company itself isn't full).
6. The key (D10, review G7): private `t/{first 16 hex of
   sha256(tenantId)}/{YYYY}/{MM}/{32 hex random}.{ext}` (16 random bytes);
   public `p/{32 base64url random}.{ext}` (24 random bytes). Both pass
   `STORAGE_KEY_PATTERN`.
7. `put(key, bytes, { contentType, cacheControl })` on `stores[purpose.access]`
   with `private, no-store` or `public, max-age=31536000, immutable`.
8. A transaction: `pg_advisory_xact_lock(hashtext('storage-usage:' ||
   tenant_id))` as its FIRST statement, step 5's checks again (both of them),
   insert the row. Refused or failed: roll back, delete the object (best
   effort, reported), and throw `storage_full` (with `share` when it was the
   share) or the original error.
9. `onUsage` with `outcome: "stored"` and the new usage. Return the file;
   `publicUrl` is `put`'s url, or for a public store that answered null,
   `{publicBase}/v1/p/{random}.{ext}`.

`remove`: `update … set deleted_at = now where tenant_id = $t and id = $id and
deleted_at is null returning pathname, access`; nothing → `{ removed: false
}`; then `stores[access].delete(key)` (never the purpose's store; D13, review
G11); success → delete the row; failure, or no store for that access →
`purge_attempts + 1`, reported, `{ removed: true, objectRemoved: false }`.

`purgeDeleted` (defaults: limit 200): rows with `deleted_at` set and
`purge_attempts < 10`, oldest first, within the time budget: delete the
object from `stores[row.access]`, then the row; a failure (or no store for
that access) adds an attempt; the tenth is reported (step "purge-gave-up",
with the key) and the row stays for a person to look at.

**Guarded statements (D14, review G1):** `remove`, `purgeDeleted`,
`moveToPrivate` and `attach` name `deleted_at` or `purge_attempts` in their
WHERE, so an instance pointed at a host's own `stored_files` errors instead
of changing it.

**Signed links (D10, review G2).** The token is `v1.{base64url(JSON { t, f,
u, i, e })}.{base64url(HMAC-SHA256(secret, "v1." + payload))}`, where `t` is
the company, `f` the file, `u` the person who made it (`signedLink`'s
`userId`), `i` when it was made and `e` when it expires (seconds; `e − i <=
3600`). `resolveLink` checks, in order: the shape; the MAC (timing-safe); `e >
now` and `e − i <= 3600`; the row by (`t`, `f`), live; and
`signing.stillValid({ tenantId: t, userId: u, issuedAt: i })`. Any failure is
null, the same for every cause. A token correctly signed for {t: B, f: A's
file} finds no row (the lookup is by both) and is null.

### 6.7 Handlers (root): `createStorageHandlers` (a company's signed-in routes)

```ts
export type StorageAuthorizeResult = boolean | { userId?: string | number | null } | Response;
export interface CreateStorageHandlersOptions {
  readonly storage: Storage;
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Asked for each permission a route or a record needs (D12), in order; the host memoises per request (2a's seams do). */
  readonly authorize: (req: Request, permission: string, tenantId: string) => StorageAuthorizeResult | Promise<StorageAuthorizeResult>;
  /** Names for "Added by". Absent: not shown. */
  readonly names?: (tenantId: string, userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /**
   * false → 429 rate_limited "Too many uploads for now. Try again in a few
   * minutes." `userId` is the person `authorize` named (null when it named
   * nobody), so a host can limit uploads per person (review BO-09).
   */
  readonly rateLimit?: (req: Request, bucket: "upload" | "link", tenantId: string, userId: string | null) => boolean | Promise<boolean>;
  /** The company's name, for the sentence a member sees when storage is full (review BO-07). Absent: "The company". */
  readonly companyName?: (tenantId: string) => Promise<string | null>;
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly route: string }) => void;
  readonly now?: () => Date;
}
export function createStorageHandlers(options: CreateStorageHandlersOptions): { handle(req: Request): Promise<Response> };
export type StorageAdminRouteKind =
  | "usage" | "files" | "upload" | "file-get" | "file-content" | "file-link" | "file-remove" | "attachments" | "attach";
export const STORAGE_ADMIN_ROUTES: readonly StorageRoute<StorageAdminRouteKind>[];
```

Mechanics as 4.7, except the two upload routes take `multipart/form-data` with
EXACTLY one part, a file part named `file` (the same-site check still
applies). The body is read through a byte-counting stream that aborts at
`maxUploadBytes + 64 KiB` with `413 file_too_big`, whether or not a
`Content-Length` is present (a declared `Content-Length` over the cap is
refused before reading); only then is it parsed (review G10). Any other part,
a second file part, or no `file` part → `400 invalid` "Send one file at a
time." The parsed file's own size is checked again by `store`.

| kind | method | path | permission | query / body → 200 |
| --- | --- | --- | --- | --- |
| `usage` | GET | `v1/admin/usage` | `files.view` | → `UsageWire` |
| `files` | GET | `v1/admin/files` | `files.view` | query `purpose=&record=&sort=&cursor=` → `FileListWire` (30 a page); `record` is a record type, or `none` (on no record); `sort` is `newest` (default) or `size` (largest first) |
| `upload` | POST | `v1/admin/files` | `files.manage` | multipart `file` (purpose `library`) → 201 `FileResponse` |
| `file-get` | GET | `v1/admin/files/{file}` | null: the file decides (D12) | → `FileResponse` |
| `file-content` | GET | `v1/admin/files/{file}/content` | null | → the bytes (always streamed; review BO-24) |
| `file-link` | POST | `v1/admin/files/{file}/link` | null (view) | `{}` → `FileLinkWire` |
| `file-remove` | POST | `v1/admin/files/{file}/remove` | null (manage) | `{}` → `RemoveResponse` |
| `attachments` | GET | `v1/admin/attachments` | null: the record decides | query `record={record-type}&id={record}` → `AttachmentsWire` |
| `attach` | POST | `v1/admin/attachments` | null (manage or assigned) | query `record={record-type}&id={record}`, multipart `file` → 201 `FileResponse` (purpose `attachment`) |

- In the route table, the two upload rows carry `body: { multipart: "file" }`:
  the proof (14.1) and the package test send a 1×1 PNG in that field.
- **Access (D12, review G5)**, worked out per request: ask `files.manage`; a
  `Response` is returned as it is (not a member, suspended, signed out);
  `true` decides at once (view and remove any file, orphans included). Then,
  for a file on a record or a record route: the record type must be
  registered and `records.get(type).find({ tenantId, ids: [id] })` must
  return it (else 404), then the record's `manage`, `view` and `assigned`
  asks (the assigned rule needs the reader among `assignedUserIds`, and
  removes only a file with `addedBy` = the reader and `createdAt` > now − 24 h;
  review BO-21). `files.view` alone grants NOTHING on a record. For a file on
  no record: `files.view` and, when the purpose has a `view` list, one of
  those. Nothing granted → **404 `not_found`** "That file isn't here." (or
  "That isn't here." for a record). The asks stop at the first that decides.
- `files` (the list): each page's rows are filtered by the same rule for
  `needs: "view"` (a runtime permission filter, commented; the record lookups
  are ONE `find` per record type per page): rows the reader can't open are
  dropped, so a member holding `files.view` but not `invoices.view` never
  sees an invoice attachment listed. A row whose record type isn't registered
  or whose record `find` didn't return is shown only to `files.manage`, with
  `record: { type, label: "Attached to something that was removed", href: null
  }`. `usage` stays the company's whole usage. `hiddenUntilAttached` purposes
  on no record are left out.
- `attachments`: the record's files of purpose `attachment` only (a feature's
  own purpose shows in the feature's own panel; D12, review BO-13).
- `file-content`: `content-type` as stored, `content-length`,
  `content-disposition` (`inline` for images, `attachment` for a PDF, with
  `filename*=UTF-8''…` of the stored, extension-corrected name), `etag:
  "{sha256}"`; a matching `if-none-match` is answered `304` from the ROW,
  before the store is read (review BO-19); `cache-control: private,
  max-age=300` for images (thumbnails are viewed again and again) and
  `private, no-cache` for documents; `x-content-type-options: nosniff`,
  `content-security-policy: default-src 'none'; sandbox`, `referrer-policy:
  no-referrer`. Never a redirect: the package streams every private file
  (review BO-24), so the headers above, and no store URL, are what a browser
  sees.
- `file-remove`: a purpose with `removableFromFiles: false` removed by
  `files.manage` alone (not through its record) → `409 not_removable` "This is
  removed where it's used: {where}." (the logo: "in company settings"; an
  estimate photo: "on {record label}", e.g. "on Estimate 1042 · Pat Rivera").
- `file-link`: `storage_off` (409) "Links to files aren't switched on." without
  `signing`; rate-limited (`link` bucket); mints with the reader's `userId`.
- **`storage_full` by caller (review BO-07).** To someone holding
  `files.manage`: `store`'s sentence. To anyone else: "{Company}'s storage is
  full, so this wasn't added. Ask the owner to make room." (`companyName`).
  A `share` refusal: "There's no more room for these right now." to everyone.
- Errors: `storage_off` 409, `file_type` 415, `file_too_big` 413,
  `storage_full` 409, `not_removable` 409, `invalid` 400, `unknown_record`
  404 (as `not_found`), each with its sentence.

### 6.8 The public handler (root): `createStorageLinkHandlers`

```ts
export function createStorageLinkHandlers(options: {
  readonly storage: Storage;
  readonly onError?: (error: unknown, context: { readonly route: string }) => void;
}): { handle(req: Request): Promise<Response> };
export type StoragePublicRouteKind = "link" | "public";
export const STORAGE_PUBLIC_ROUTES: readonly StorageRoute<StoragePublicRouteKind>[];
```

| kind | method | path | → 200 |
| --- | --- | --- | --- |
| `link` | GET | `v1/f/{file-token}` | the bytes, always streamed (review BO-24) |
| `public` | GET | `v1/p/{public-key}` | a PUBLIC file's bytes |

- GET and HEAD only; no CORS needed (an `<img>` loads cross-origin without it).
- `link`: any failure (malformed, altered, expired, removed, another
  company's, a maker who is no longer a member, a suspended company: 6.6's
  `resolveLink`, review G2) → `404 not_found` "This link has expired, or the
  file was removed." `cache-control: private, no-cache` with the row's ETag
  (a browser revalidates every open, so a revoked link stops at once),
  `referrer-policy: no-referrer`, `x-robots-tag: noindex`, and 6.7's
  `nosniff`, CSP and disposition headers.
- `public`: only a row with `access = 'public'`, live, whose key is exactly
  `p/{segment}`. A private file is never served here, whatever is asked for.
  `cache-control: public, max-age=31536000, immutable`.
- Mounted at `/api/files/` in both modes (D15): a link is not a company page,
  and a logo's address must survive a change of web address.

### 6.9 The logo store and the purpose store

```ts
/** Structurally tenancy 0.6's LogoStore (8.3). */
export interface StorageLogoStore {
  /** `pathname` is ignored: storage picks an unguessable key (D10). `tenantId` is required. */
  put(input: { readonly pathname: string; readonly bytes: Uint8Array; readonly contentType: string; readonly tenantId?: string }):
    Promise<{ readonly url: string; readonly key: string }>;
  /**
   * `key` is the file's id, or (review G11) a 2a logo's blob pathname, which
   * starts with exactly `tenancy/logos/{context.tenantId}/`: that object is
   * deleted from the PUBLIC store (it has no row). Any other key that isn't a
   * file id of this company: reported, nothing deleted. Without `context`,
   * nothing can be scoped: reported, nothing deleted.
   */
  delete(key: string, context?: { readonly tenantId: string }): Promise<void>;
}
/** Structurally the estimator's EstimatorPhotoStore (10.5). */
export interface StoragePurposeStore {
  put(input: { readonly tenantId: string; readonly bytes: Uint8Array; readonly contentType: string; readonly filename: string }):
    Promise<{ readonly fileId: string; readonly url: string }>;
  /** `storage.remove`: deletes from the store the file is IN (D13, review G11), so a 2a photo still in the public store is deleted there. */
  delete(input: { readonly tenantId: string; readonly fileId: string }): Promise<void>;
  /** The signed-in content route (private) or the public address. */
  urlFor(input: { readonly tenantId: string; readonly fileId: string; readonly url: string }): string;
  /** Review BO-13: puts the file on its record (`storage.attach`), so the Files screen says "Estimate 1042 · Pat Rivera" and the record's permissions decide. */
  attach(input: { readonly tenantId: string; readonly fileId: string; readonly record: { readonly type: string; readonly id: string } }): Promise<void>;
}
```

- `logoStore().put` stores purpose `company.logo` (public, exempt) and answers
  `{ url: publicUrl, key: file.id }`; a `put` with no `tenantId` throws (an old
  tenancy). Tenancy keeps its own checks (type, 1 MB, magic bytes, the caller
  first); storage checks again.
- `purposeStore("estimator.photo")` is the estimator's photo store: the bytes
  privately, first on no record (a customer's photo before the lead is sent,
  hidden from the Files screen, `hiddenUntilAttached`), then attached to its
  estimate by the estimator (`attach`, review BO-13), after which the
  estimate's permissions decide (D12); `url` the content route. On no record
  the purpose's `view` (`estimator.view`) and `files.view` both apply.

### 6.10 Wire (both copies: `storage/src/wire.ts` and `storage-widget/src/types.ts`, inside the markers)

```ts
export type Instant = string;
export type FilesErrorCode =
  | "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal"
  | "storage_off" | "file_type" | "file_too_big" | "storage_full" | "not_removable";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: FilesErrorCode; message: string; issues?: WireIssue[] } }

export interface UsageWire { usedBytes: number; fileCount: number; /** null = no allowance. */ allowanceBytes: number | null }
export interface UploadRulesWire {
  /** False with `offReason`: nothing can be added right now. */
  available: boolean;
  offReason: string | null;
  maxBytes: number;
  /** For the file input's accept attribute. */
  accept: string[];
  /** In words: "Photos (JPEG, PNG, WebP, HEIC) or PDFs, up to 4 MB". */
  rule: string;
}
export interface FileWire {
  id: string;
  name: string;
  contentType: string;
  /** For the icon, the preview and the filter. */
  kind: "photo" | "document";
  sizeBytes: number;
  width: number | null;
  height: number | null;
  purpose: string;
  purposeLabel: string;
  /** What it's attached to; label "Attached to something that was removed" (href null) for an orphan, shown to files.manage only (D12). */
  record: { type: string; label: string; href: string | null } | null;
  addedBy: string | null;
  at: Instant;
  /** Where it opens: the signed-in content route, or a public file's address. */
  url: string;
  canRemove: boolean;
  canLink: boolean;
}
export interface FileListWire {
  files: FileWire[];
  nextCursor: string | null;
  usage: UsageWire;
  uploads: UploadRulesWire;
  canUpload: boolean;
  /** The purposes present, for the filter: { key, label }. */
  purposes: { key: string; label: string }[];
  /** The installed record types the reader can see files of, for the filter (review BO-22): { type: "scheduling.visit", label: "Visits" } (the type's `pluralLabel`). */
  recordTypes: { type: string; label: string }[];
}
export interface AttachmentsWire {
  record: { type: string; label: string; href: string | null };
  files: FileWire[];
  canAdd: boolean;
  uploads: UploadRulesWire;
}
export interface FileResponse { file: FileWire; /** null for someone without files.view (a crew member). */ usage: UsageWire | null }
export interface RemoveResponse { removed: true; usage: UsageWire | null }
export interface FileLinkWire { url: string; expiresAt: Instant }
```

There is no field for a key, a pathname or a store.

### 6.11 0.1's API, kept

`storeFile(db, store: BlobStoreV1, input, options)`, `listFiles`, `getFile`,
`deleteFile`, `storeFileSchema`, `StoreFileInput`, `StoredFileRow`,
`DEFAULT_MAX_SIZE_BYTES` and `sanitizeFilename` keep their signatures on the
default table (`access` written `public`). All but `sanitizeFilename` are
`@deprecated`, naming the instance method that replaces them.

### 6.12 Permissions (root)

```ts
export const storagePermissions = {
  "files.view": {
    label: "See files",
    description: "The company's own files and how much storage is used. Photos and files on visits, estimates and invoices also need permission to see those.",
    category: "Files",
    defaultFor: ["owner", "admin", "member", "viewer"],
    // Review G5: this opens the company's own files (the Files screen's
    // uploads). A file on a visit, an estimate or an invoice is that record's:
    // its own view permission decides, so removing "See invoices" from a role
    // hides invoice attachments too.
  },
  "files.manage": {
    label: "Manage files",
    description: "Add files to the company's files and delete any file, whatever it's attached to.",
    category: "Files",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, StoragePermissionDefinition>;
export type StoragePermission = keyof typeof storagePermissions;
```

A crew member holds neither; they reach their own visits' photos through the
visit's `assigned` rule (D12).

### 6.13 Package

- `dependencies`: `uuidv7 ^1.2.1` (drop `@adminigloo/db`).
- `peerDependencies`: `drizzle-orm`, `zod` (`catalog:peers`). No vendor peer.
- `devDependencies`: add `@electric-sql/pglite ^0.5.8`; `vitest.config.ts`.
- Entries (tsup and `exports`): `.`, `./schema`, `./vercel-blob`, `./s3`,
  `./local`, `./testing`. `files`: `dist`, `sql`, `README.md`.

### 6.14 `./testing`: `checkHostSeams` (review G19)

`@adminigloo/storage/testing` exports, beside the memory store, the same
`HostSeamsCheckResult` shape as notifications' (4.12, declared here, never
imported) and:

```ts
export function checkHostSeams(input: {
  /** The host's mounted signed-in handlers (`createStorageHandlers(…)`). */
  readonly handlers: { handle(req: Request): Promise<Response> };
  /** The instance those handlers use: the check stores one small file in A and one in B, and removes both after. */
  readonly storage: Storage;
  /** As 4.12: a request to `path` in company `tenantId`, signed in as `member` (of A only). */
  readonly request: (tenantId: string, path: string, init?: { readonly method?: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown }) => Request;
  readonly companyA: string;
  readonly companyB: string;
  readonly member: { readonly userId: string };
}): Promise<HostSeamsCheckResult>;
```

Checks: (1) `usage` in A answers 200; (2) `usage` and `files` in B answer 401,
403 or 404, never 200; (3) B's URL with `?tenantId={A}&tenant={A}` is still
refused; (4) B's stored file asked for under A (`files/{B's id}/content`)
answers 404 (the company is in the lookup); (5) no answer's body contains
either stored file's key. Plants through `storage.store` with purpose
`library`, a 1×1 PNG; removes both in a `finally`. Never throws.

### 6.15 Alert kinds (root, structural; review BO-07)

Storage declares its own fragment in 3.2's shape (no notifications import):

```ts
export const storageAlertKinds: StorageAlertKinds;
/** The draft for one `onUsage` event, or null when it isn't worth an alert. Pure. */
export function storageUsageAlert(
  event: { readonly tenantId: string; readonly usage: { readonly usedBytes: number; readonly allowanceBytes: number | null }; readonly outcome: "stored" | "refused" },
  options: { readonly href: string; readonly now: Date; readonly platformName: string; readonly locale?: string },
): StorageAlertDraft | null;
```

| key | label | category | audience | default | email |
| --- | --- | --- | --- | --- | --- |
| `storage.files.almost-full` | "Your files are almost full" | Files | `files.manage` | `email` | yes |
| `storage.files.full` | "A file couldn't be added because storage is full" | Files | `files.manage` | `email` | yes |

| outcome | when | title | body | dedupeKey |
| --- | --- | --- | --- | --- |
| `stored` | `allowanceBytes` set and `usedBytes >= 0.9 × allowanceBytes` | "Your files are almost full: {used} of {allowance} used" | "Delete files you no longer need in Files, or ask {platformName} for more room." | `storage.files.almost-full:{YYYY-MM}` (UTC) |
| `refused` | always | "A file couldn't be added: your storage is full" | the same body | `storage.files.full:{YYYY-MM-DD}` (UTC) |
| otherwise | | null | | |

`subject` null, `actorUserId` null, `href` the Files page. The dedupe keys
make "once a month" and "once a day" true by construction (D7).

---

## 7. `@adminigloo/storage-widget` 0.1.0 (files builder)

New package, created at `0.0.0` by step 0 of section 18. React is its only
peer, plus `@adminigloo/storage ^0.2.0` as an OPTIONAL peer (and a workspace
devDependency for the wire-parity test only). Entries `.` (wire types,
`STORAGE_WIRE_VERSION = "v1"`, the transport) and `./admin` (the components).
Copy the transport, theme, styles and dialog from comms-widget (never import).
CSS prefix `aifw-`, root `.aifw-root`, tokens `--aifw-*`, AA in light and dark,
44 px targets under 640 px, SSR-safe, never throws.

```ts
export interface FilesTransport {
  usage(): Promise<Result<UsageWire>>;
  files(q?: { purpose?: string; record?: string; sort?: "newest" | "size"; cursor?: string }): Promise<Result<FileListWire>>;
  upload(file: Blob, name: string): Promise<Result<FileResponse>>;
  file(id: string): Promise<Result<FileResponse>>;
  link(id: string): Promise<Result<FileLinkWire>>;
  remove(id: string): Promise<Result<RemoveResponse>>;
  attachments(record: { type: string; id: string }): Promise<Result<AttachmentsWire>>;
  attach(record: { type: string; id: string }, file: Blob, name: string, onProgress?: (fraction: number) => void): Promise<Result<FileResponse>>;
  /** The content route for a file id (what an <img> uses). */
  contentUrl(id: string): string;
}
export function createFilesClient(options: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> }): FilesTransport;

/** Before upload (D11): a photo over `minBytes` or longer than `maxSide` becomes a `maxSide` JPEG. Anything else, unchanged. Never throws (a photo it can't read goes as it is). */
export function shrinkPhoto(file: File, options?: { maxSide?: number; quality?: number; minBytes?: number; encode?: PhotoEncoder }): Promise<{ blob: Blob; name: string; shrunk: boolean }>;
```

Defaults: `maxSide` 2048, `quality` 0.85, `minBytes` 1.5 MB.
`createImageBitmap(file, { imageOrientation: "from-image" })` then a canvas;
`encode` is injectable so happy-dom tests can run the decisions without a
canvas. A HEIC (by type or by its `ftyp` brand) the browser can decode is
ALWAYS converted to JPEG, whatever its size (desktop Chrome can't show HEIC;
review BO-21); one it can't decode goes as it is. `attach` uses
`XMLHttpRequest` when `onProgress` is given (upload progress), else `fetch`;
both answer the same `Result`.

**`<RecordFiles>`** (`./admin`; the files of one visit, estimate or invoice):

```ts
interface RecordFilesProps {
  baseUrl?: string; transport?: FilesTransport;
  record: { type: string; id: string };
  /** The card's heading. Default "Photos and files". */
  title?: string;
  /** One muted line under the heading (review BO-13, BO-22), e.g. "Your team sees these; they aren't sent to the customer." */
  hint?: string | null;
  /** A "Back" link (the visit files page). */
  backHref?: string | null;
  locale?; theme?; nonce?; className?; style?;
}
```

- The record's label as a subheading ("Visit · Pat Rivera · Tue, Nov 3,
  9:00 AM"), then `hint`.
- A grid of photo thumbnails (the content URL in an `<img loading="lazy">`,
  `alt` = the file name) and rows for documents (icon, name, size). A HEIC
  file is a document row, "iPhone photo (HEIC)", open or download, never a
  broken `<img>` (review BO-21). Each opens in a new tab. "Copy a link (works
  for 1 hour)" when `canLink`; Remove when `canRemove`, after "Remove {name}?
  It's deleted for good."
- With `canAdd`: on a phone (pointer: coarse, or under 640 px) two buttons,
  "Take a photo" (`accept="image/*" capture="environment"`) and "Add photos or
  files" (`multiple`, `accept` from the rules); on a desktop one button and
  drop-on-the-card. Each chosen file: `shrinkPhoto`, then `attach` with a
  progress bar; the others carry on whatever happens to one. `uploads.available:
  false` shows `offReason` and no buttons.
- **No lost photo (review BO-05).** A photo taken with "Take a photo" is
  usually NOT in the phone's gallery, so the in-memory `File` is the only
  copy. Each file that fails stays in the list as a card: its preview, the
  server's sentence (or "It didn't send. Check your signal."), "Try again"
  (re-sends the same `File`, shrunk once more if it was refused as too big)
  and "Save to phone" (a link to an object URL with `download={name}`). A
  network failure on `attach` retries once by itself after 3 s before the
  card shows. While any file is uploading or failed, a `beforeunload` warning
  is set ("A photo hasn't been added yet."); it is cleared once none are.
- Not found (404): "These files aren't available to you." No error is a
  dead end: Retry on a network failure.

**`<FilesManager>`** (`./admin`; the company Files screen):

```ts
interface FilesManagerProps {
  baseUrl?: string; transport?: FilesTransport;
  /** Who to ask for more room, in the full sentence (review BO-07): the platform's name. */
  platformName?: string;
  locale?; theme?; nonce?; className?; style?;
}
```

- `<UsageMeter>` at the top (given `platformName`).
- Filters as an owner thinks (review BO-22): "All", then each of
  `recordTypes` ("Visits", "Estimates", "Invoices", query `record={type}`),
  "Not attached" (`record=none`), then each purpose of `purposes` that is on
  no record by nature ("Logo", `purpose=company.logo`); and a sort, "Newest
  first" / "Largest first" (`sort=size`), so a full company can find its big
  files. A table at ≥ 768 px (name, what it's attached to as a link, size,
  added, by), cards below; "Load more".
- "Upload a file" with `canUpload` (purpose `library`); Remove and Copy link as
  in `<RecordFiles>`; a file that is `removableFromFiles: false` shows where
  to remove it instead of a button (from `not_removable`'s sentence, or "Change
  it in company settings" for the logo).
- Empty: "No files yet. Photos and files added to visits, estimates and
  invoices show up here."

**`<UsageMeter>`** (`./admin`, also usable alone):

```ts
interface UsageMeterProps { usage: UsageWire; platformName?: string; locale?; theme?; nonce?; className?; style? }
```

"Using 120 MB of 5 GB" with a bar (`role="meter"`, `aria-valuenow` in bytes);
at 90 % or more the warn tone and "Almost full: delete files you no longer
need."; full: "Full: new files can't be added until you delete some, or ask
{platformName} for more room." (without `platformName`: "…until you delete
some."); no allowance: "Using 120 MB".

Exports: `.` → `createFilesClient`, `FilesTransport`, `Result`, `ClientError`,
`STORAGE_WIRE_VERSION`, the wire types; `./admin` → `RecordFiles`,
`FilesManager`, `UsageMeter`, their props, `shrinkPhoto`, `createFilesClient`,
`injectFilesStyles`, `filesWidgetCss`, `STORAGE_WIRE_VERSION`.

---

## 8. `@adminigloo/tenancy` 0.6.0 and `@adminigloo/tenancy-widget` 0.2.1 (platform builder)

Additive. Tenancy 1's and 2a's behaviour, routes and wire are unchanged.

### 8.1 Events carry an id, a time and the person

```ts
/** Added to EVERY TenancyEvent member of the union. */
readonly id: string;           // uuidv7, unique per event
readonly occurredAt: string;   // ISO, the service's `now`

// member.joined, member.removed and member.left also carry:
readonly person: { readonly name: string | null; readonly email: string | null };
// member.joined also carries:
readonly roleName: string;     // the role they joined with, in words ("Crew member")
```

- Added in ONE place, `ctx.emit` (`src/server/context.ts`): it stamps `id`
  and `occurredAt`. The three member events read the person's name and address
  (one query, `users` by id) where they are emitted; a deleted user gives
  `{ name: null, email: null }`.
- **Events are settled before a handler answers.** `emit` stays
  fire-and-forget for direct service callers, but it now keeps each listener's
  promise in a set on the context, and `TenancyService` gains
  `settleEvents(timeoutMs?: number): Promise<void>` (default 5000: waits for
  the listeners pending NOW, never throws). `createTenancyHandlers` and
  `createTenancyOperatorHandlers` await it before returning the answer to any
  POST. Why: on a serverless platform a promise left running after the
  response is often frozen, and "Cam joined the team" (or a removed member's
  `forget`) was the listener that got cut off. The scheduling and estimator
  events already promise "awaited, in order"; this brings tenancy's handlers
  to the same place.

### 8.2 Members holding a permission

```ts
listMemberPeople(tenantId: string, options?: { readonly holding?: string }): Promise<readonly MemberPerson[]>;
```

Without `holding`: 2a's behaviour, unchanged. With it: only the active members
whose resolved tenant permission set (`resolvePermissionSet` from
`@adminigloo/permissions` over the template grants and the person's overrides,
exactly as a request resolves it) includes the key. **Three queries, whatever the team size**: 2a's
member query (now also selecting each member's template id), the grants of the templates those members hold, and the
overrides in this tenant for those members. Notifications' `people()` is this
(13.5), so an alert costs the same for a team of 3 or 30.

### 8.3 The logo store is told the company

```ts
export interface LogoStore {
  put(input: {
    readonly pathname: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    /** Tenancy 0.6: the company the logo is for (a store that keeps files per company needs it). */
    readonly tenantId: string;
  }): Promise<{ readonly url: string; readonly key: string }>;
  /** Tenancy 0.6 passes the company as `context`. */
  delete(key: string, context?: { readonly tenantId: string }): Promise<void>;
}
```

`setLogo` and `removeLogo` pass them. A 0.5 `LogoStore` object (ignoring both)
still works. Storage 0.2's `logoStore()` (6.9) is this shape.

### 8.4 Alert kinds (root, client-safe, structural; 3.2 and 3.3)

```ts
export const tenancyAlertKinds: TenancyAlertKinds;
export function tenancyAlertsFor(event: TenancyEvent, options: { readonly teamHref: string }): readonly TenancyAlertDraft[];
```

| key | label | category | audience | default | email |
| --- | --- | --- | --- | --- | --- |
| `tenancy.member.joined` | "Someone joins the team" | Team | `members.invite` | `in_app` | yes |
| `tenancy.member.left` | "Someone leaves the team" | Team | `members.invite` | `in_app` | yes |

| Event | title | body | href | dedupeKey | actorUserId |
| --- | --- | --- | --- | --- | --- |
| `member.joined` | "{name} joined the team as {roleName}" | null | `teamHref` | `tenancy.member.joined:{event.id}` | the joiner |
| `member.left` | "{name} left the team" | null | `teamHref` | `tenancy.member.left:{event.id}` | the leaver |
| `member.removed` | "{name} was removed from the team" | null | `teamHref` | `tenancy.member.left:{event.id}` | `by` |
| any other | none | | | | |

`{name}` is the person's name, else their address, else "Someone". `subject`
is `{ type: "tenancy.member", id: userId }`. The mapper lives in the ROOT
(it only formats an event), so `TenancyEvent`'s type moves its declaration to a
root-safe module re-exported by `./server` (no runtime change).

### 8.5 Exports added

Root: `tenancyAlertKinds`, `tenancyAlertsFor`, types `TenancyAlertKinds`,
`TenancyAlertKind`, `TenancyAlertRouting`, `TenancyAlertDraft`,
`TenancyEvent` (now also from the root). `./server`: unchanged names;
`TenancyService` gains `settleEvents`; `listMemberPeople`'s new option.
`barrel.test.ts` is updated.

### 8.6 `@adminigloo/tenancy-widget` 0.2.1

- `package.json`: optional peer `@adminigloo/tenancy` `^0.6.0`.
- `src/__tests__/release.test.ts` is rewritten for 2b-1 (the baseline's one
  failure): the peer is `^0.6.0`, and `.changeset/tenancy-2b1-tenancy.md` and
  `.changeset/tenancy-2b1-tenancy-widget.md` exist (`minor` and `patch`).
- No component or wire change.

---

## 9. `@adminigloo/scheduling` 0.6.0 and `@adminigloo/scheduling-widget` 0.3.0 (field builder)

Every new option is optional; a host passing none gets 0.5's behaviour.

### 9.1 Alert kinds and the mapper (root)

```ts
export const schedulingAlertKinds: SchedulingAlertKinds;
export function schedulingAlertsFor(
  db: SchedulingDb,
  event: SchedulingEvent,
  options: {
    /**
     * Patterns: `visit` takes {id} and {date} ("/app/schedule?date={date}&visit={id}");
     * `crewDay` is a path ("/app/schedule/today"); `visitFiles` takes {id}
     * ("/app/schedule/visits/{id}/files"), absent without file storage.
     */
    readonly hrefs: { readonly visit: string; readonly crewDay: string; readonly visitFiles?: string };
    readonly locale?: string;
    /** Default `new Date()`: decides whether the crew's link is today's route (review BO-04). */
    readonly now?: Date;
  },
): Promise<readonly SchedulingAlertDraft[]>;
```

Routing group: `{ key: "visits", label: "Visit requests and customer changes",
description: "New visit requests, a customer moving or cancelling, and
requests about to lapse.", permission: "schedule.view" }`.

| key | label | audience | default | emailBy |
| --- | --- | --- | --- | --- |
| `scheduling.visit.requested` | "A customer asks for a visit, or books one" | routing `visits`, `schedule.view` | `email` | `producer` (`visit_staff_notice`) |
| `scheduling.visit.moved` | "A customer moves a visit" | routing `visits`, `schedule.view`, assigned `schedule.route` | `email` | `producer` |
| `scheduling.visit.cancelled` | "A customer cancels a visit" | routing `visits`, `schedule.view`, assigned `schedule.route` | `email` | `producer` |
| `scheduling.request.expiring` | "A visit request is about to lapse unanswered" | routing `visits`, `schedule.view` | `email` | notifications |
| `scheduling.request.expired` | "A visit request lapsed unanswered" | routing `visits`, `schedule.view` | `email` | `producer` |

Category "Visits" for all.

The mapper writes an alert exactly when the comms listener writes an office
notice (its `staffNoticeKind`: never for a change staff made), plus nothing
else:

| Event | title | body | dedupeKey |
| --- | --- | --- | --- |
| `visit.requested`, status pending | "New visit request: {customer}, {when}" | "{service}{ at {address}}." + "\nThe address couldn't be found on the map. Check it with them." when `addressUnverified` | `scheduling.visit.requested:{visitId}` |
| `visit.requested`, confirmed (auto) | "New booking: {customer}, {when}" | as above | the same key |
| `visit.rescheduled` by the customer | "{Customer} moved their visit to {when}" | "Now {when}. It was {previous when}. {service}." (both in full, so the alert says everything even where its link can't show the day; review BO-04) | `scheduling.visit.moved:{visitId}:{sequence}` |
| `visit.cancelled` by the customer | "{Customer} cancelled their visit on {when}" | "{service}." + " They said: {reason}" | `scheduling.visit.cancelled:{visitId}:{sequence}` |
| `visit.expired` | "{Customer}'s visit request lapsed unanswered" | "They asked for {when} ({service})." | `scheduling.request.expired:{visitId}` |

- `{when}` is 2a's short form ("Tue, Nov 3, 9:00 AM MST") in the visit's own
  zone; move `formatShort` / `formatWhen` out of `comms.ts` into a shared
  `src/format.ts` (comms keeps importing them). `{customer}` is the name, else
  "a customer" ("A customer" at the start). `subject` `{ type:
  "scheduling.visit", id }`; `replyTo` the customer's email; `actorUserId`
  null (customers and the system).
- `href` = the `visit` pattern with `{id}` and `{date}` (the visit's
  `YYYY-MM-DD`). `assignedHref` (review BO-04: 2a §18 D9 makes the crew's
  route today-only for a login without `schedule.view`): `crewDay` when the
  visit's date (the NEW date on a move, the date on a cancel) is today in the
  visit's zone at `now`; otherwise `visitFiles` with `{id}` (a crew member
  on that visit can open it, and its heading carries the visit's time); with
  no `visitFiles`, null (the alert opens nothing; its body says it all).
- `assignedUserIds` (moved, cancelled): the `user_id` of the visit's crew, and
  of its previous crew on a move (`crewUserIds(db, tenantId, resourceIds)`,
  ONE query, internal); empty when the crew has nobody linked.

### 9.2 The expiring sweep (root)

```ts
export interface ExpiringRequest {
  readonly id: string; readonly sequence: number;
  readonly customerName: string | null; readonly serviceName: string;
  readonly date: string; readonly startsAt: Date; readonly timeZone: string;
  readonly pendingExpiresAt: Date;
}
/**
 * Pending requests whose deadline falls in (now, now + withinHours] AND that
 * were made before `createdBefore` (default now − 6 h): a request for
 * tomorrow morning made this afternoon has a deadline tonight, and its
 * "new request" alert has just gone; a second email 15 minutes later is
 * noise (review BO-15). Default 26 h (a daily cron sees each once before it
 * lapses), limit 200.
 */
export function listExpiringRequests(db: SchedulingDb, tenantId: string, options?: { readonly now?: Date; readonly withinHours?: number; readonly createdBefore?: Date; readonly limit?: number }): Promise<readonly ExpiringRequest[]>;
export function schedulingExpiringAlert(
  tenantId: string, request: ExpiringRequest,
  options: { readonly hrefs: { readonly visit: string }; readonly locale?: string },
): SchedulingAlertDraft;
```

Title "Answer {customer}'s visit request by {deadline}, or it lapses"
(`{deadline}` in the short form), body "They asked for {when} ({service}).",
dedupeKey `scheduling.request.expiring:{id}:{sequence}`. One query on
`scheduling_bookings_pending_expiry_idx`.

### 9.3 The office notice seam (`./comms`)

`SchedulingCommsOptions` gains 3.4's `officeRecipients` and `officeSent`, with
`SchedulingOfficeNotice` (its `kind` from the table in 9.1, its `dedupeKey`
the same as the mapper's, `assignedUserIds` the visit's crew). When
`officeRecipients` is given, the listener's `staffRecipients` is that answer
alone (the saved `staffNotifyEmails` is not read; `staffEmails` only if it
throws, reported, step "office-recipients"). Each office email keeps 2a's
template, variables, reply-to and idempotency key, and goes through comms'
`deliverNow` (12.2, review BO-02); its outcome is handed to `officeSent`
per address (`message.status`, `retryable`); a send that hit the listener's
own time bound is not handed over (it may have gone) and is reported (step
"office-timeout"). Without `officeRecipients`, 2a's behaviour exactly
(`sendNow`, no `officeSent`).

### 9.4 Staff handlers (`createSchedulingAdminHandlers`)

```ts
/** Where Alert settings are, when the host routes office alerts there (D6), e.g. "/app/alerts/settings". Default null. */
alertsHref?: string | null;
```

- `settings-get`: `SettingsWire.alertRecipients` = `{ href: alertsHref }` when
  given, else null.
- `settings-update`, when given: `staffNotifyEmails` is dropped from the patch
  (2a D6's rule: never a 422; a body of only it saves nothing and answers 200).

### 9.5 File records (root, 3.5)

```ts
export function schedulingFileRecords(
  db: SchedulingDb,
  options: { readonly visitHref: string /* pattern with {id} and {date} */; readonly locale?: string },
): readonly SchedulingFileRecordType[];
```

One type: `{ type: "scheduling.visit", label: "Visit", pluralLabel:
"Visits", view: ["schedule.view"], manage: ["schedule.manage"], assigned: {
permission: "schedule.route" } }`. `find` is one query (bookings joined to their crew) in
the tenant: label "Visit · {customer} · {when}", href the pattern,
`assignedUserIds` the crew's `user_id` (or []).

### 9.6 Peer and exports

`@adminigloo/comms` optional peer becomes `^0.4.0`. Root exports add
`schedulingAlertKinds`, `schedulingAlertsFor`, `listExpiringRequests`,
`schedulingExpiringAlert`, `schedulingFileRecords`, and types
`SchedulingAlertKinds`, `SchedulingAlertKind`, `SchedulingAlertRouting`,
`SchedulingAlertDraft`, `ExpiringRequest`, `SchedulingFileRecordType`.
`./comms` adds the type `SchedulingOfficeNotice`.

### 9.7 Wire (both copies: `scheduling/src/wire.ts` and `scheduling-widget/src/admin/types.ts`)

`SettingsWire` gains, at the end:

```ts
  /** Who gets the new-request alerts is chosen in Alert settings (Tenancy 2b-1): show this link instead of the address list. null = the list is edited here. */
  alertRecipients: { href: string | null } | null;
```

`SettingsPatch`'s `Omit` adds `"alertRecipients"`. The admin client's
`parseSettingsWire` reads it (absent → null).

### 9.8 `@adminigloo/scheduling-widget` 0.3.0

- **`<SchedulingSettings>`**: with `settings.alertRecipients`, the "Send
  new-request alerts to" fieldset becomes "Who gets new-request alerts is
  chosen in Alert settings." and a link "Open Alert settings" to its `href`
  (no link when null). Save never sends `staffNotifyEmails`.
- **`<ScheduleCalendar>`** gains:
  ```ts
  /** Open this visit's panel once it's loaded; one outside the loaded range is fetched (`visit-get`) and the calendar moves to its day. A visit that isn't found: a notice, no panel. */
  initialVisitId?: string;
  /** Pattern with {id}: the visit panel shows "Photos and files" linking here. Absent: no link. */
  visitFilesHref?: string;
  ```
- **`<CrewDay>`** gains `filesHref?: string` (pattern with `{id}`): each stop
  shows "Photos" (a 44 px link) to it.
- Tests: the managed fieldset renders and never sends the list; the initial
  visit opens (in range, and fetched from another week); the files links fill
  and encode `{id}`.

---

## 10. `@adminigloo/estimator` 0.5.0 and `@adminigloo/estimator-widget` 0.4.0 (field builder)

Every new option is optional; a host passing none gets 0.4's behaviour.

### 10.1 Alert kinds and the mapper (root)

```ts
export const estimatorAlertKinds: EstimatorAlertKinds;
export function estimatorAlertsFor(
  event: EstimatorEvent,
  options: { readonly hrefs: { readonly estimate: string /* pattern {id} */ }; readonly locale?: string },
): readonly EstimatorAlertDraft[];
```

Pure (the snapshot in the event has everything). Routing group: `{ key:
"estimates", label: "New estimate requests and quote answers", description:
"Someone asking for an estimate, and customers accepting, declining or letting
a quote lapse.", permission: "estimator.view" }`.

| key | label | default | emailBy |
| --- | --- | --- | --- |
| `estimator.lead` | "Someone asks for an estimate" | `email` | `producer` (`estimate_lead_staff`) |
| `estimator.quote.accepted` | "A customer accepts a quote" | `email` | `producer` (`quote_staff_notice`) |
| `estimator.quote.declined` | "A customer declines a quote" | `email` | `producer` |
| `estimator.quote.expired` | "A quote lapses unanswered" | `email` | `producer` |

All: category "Estimates", audience routing `estimates`, `estimator.view`.

| Event | title | body | dedupeKey |
| --- | --- | --- | --- |
| `lead.received` (actor customer) | "New estimate request: {customer}, {range}" | up to three lines "{description} × {quantity}" then "and {n} more", then "{address}", "Phone: {phone}" (each line only when known) | `estimator.lead:{estimateId}` |
| `quote.accepted` (actor customer) | "{Customer} accepted quote {number} ({total})" | "Their note: {note}" when given | `estimator.quote.accepted:{estimateId}:{quoteSequence}` |
| `quote.declined` (actor customer) | "{Customer} declined quote {number}" | "Their note: {note}" | `estimator.quote.declined:{estimateId}:{quoteSequence}` |
| `quote.expired` | "Quote {number} for {customer} lapsed unanswered" | null | `estimator.quote.expired:{estimateId}:{quoteSequence}` |
| any other, or by staff | none | | |

`{range}` is "$480–$620" (`formatMoney` in the estimate's currency and the
settings' locale), or the total when low equals high; `subject` `{ type:
"estimator.estimate", id }`; `replyTo` the customer's email; `href` the
pattern.

### 10.2 The office notice seam (`./comms`)

`EstimatorCommsOptions` gains 3.4's `officeRecipients` and `officeSent`, with
`EstimatorOfficeNotice` (`kind` per the table, the mapper's `dedupeKey`,
`assignedUserIds: []`). When `officeRecipients` is given, `staffRecipients`
is that answer alone (`staffEmails` only if it throws), and each office email
goes through `deliverNow` with its outcome handed to `officeSent`, exactly as
scheduling's (9.3).

### 10.3 Staff handlers (`createEstimatorAdminHandlers`)

`alertsHref?: string | null`: `EstimatorSettingsWire.alertRecipients` =
`{ href }` when given; `settings-update` drops `leadNotifyEmails` then.

### 10.4 File records (root, 3.5)

```ts
export function estimatorFileRecords(db: EstimatorDb, options: { readonly estimateHref: string /* {id} */ }): readonly EstimatorFileRecordType[];
```

`{ type: "estimator.estimate", label: "Estimate", pluralLabel: "Estimates",
view: ["estimator.view"], manage: ["estimator.estimates.manage"] }`; `find`:
one query in the tenant; label "Estimate {number} · {customer}"; no assigned
people.

### 10.5 The photo purpose (root, structural `StoragePurpose`)

```ts
export const estimatorPhotoPurpose = {
  key: "estimator.photo",
  label: "Estimate photo",
  access: "private",
  types: ["jpeg", "png", "webp"],
  maxBytes: 4 * 1024 * 1024,
  // Counted, never refused for a full company: a customer's photo is a lead
  // (review BO-06), and the estimator's own daily caps
  // (DEFAULT_PUBLIC_PHOTO_LIMITS) bound how many arrive.
  exemptFromAllowance: true,
  // But never more than a fifth of the room: 500 anonymous photos a day at up
  // to 4 MB could otherwise fill a company's storage and refuse the crew's job
  // photos (review G6).
  maxShareOfAllowance: 0.2,
  view: ["estimator.view"],
  removableFromFiles: false,
  // A customer's photo before the lead is sent is purged after 48 h; it isn't
  // listed on the Files screen until it is on its estimate (review BO-13).
  hiddenUntilAttached: true,
} as const;
```

**The photo store seam (`EstimatorPhotoStore`) gains one optional method**
(structural; storage's `purposeStore("estimator.photo")` satisfies it, 6.9):

```ts
  /** Puts the stored photo on its estimate (review BO-13). Called after the estimate's write commits; a throw is reported (step "photo-attach") and changes nothing else. */
  attach?(input: { tenantId: string; fileId: string; record: { type: "estimator.estimate"; id: string } }): Promise<void>;
```

- `createPublicEstimate` calls it for each linked `photoIds` photo after its
  transaction commits; `attachStaffPhoto` calls it after its insert.
- **A storage refusal is the estimator's own sentence (review G6).**
  `storePhoto` (photos.ts, the one place that calls `store.put`) catches an
  error with `name === "StorageError"` (checked structurally: no storage
  import) and rethrows `EstimatorInputError`: `code` `storage_full` →
  `photo_limit` with `PHOTO_CAP_MESSAGE`; `file_type` or `file_too_big` →
  `photo_invalid` with its existing sentence; `storage_off` →
  `photos_disabled` "This estimator doesn't take photos." So the public
  `photo` route answers 4xx, never 500, the AI reading keeps going without
  the copy (takeoff-run's existing `photo_limit` rule: not reported), and the
  lead still submits without the photo.

### 10.6 Peer, exports, wire

- `@adminigloo/comms` optional peer `^0.4.0`.
- Root exports add `estimatorAlertKinds`, `estimatorAlertsFor`,
  `estimatorFileRecords`, `estimatorPhotoPurpose`, and their types. `./comms`
  adds `EstimatorOfficeNotice`.
- Wire (both copies: `estimator/src/wire.ts` and
  `estimator-widget/src/admin/types.ts`): `EstimatorSettingsWire` gains, at the
  end, `alertRecipients: { href: string | null } | null;` (the patch's `Omit`
  adds it; the client parses it).

### 10.7 `@adminigloo/estimator-widget` 0.4.0

`<EstimatorSettings>`'s "Lead alerts" panel: with `alertRecipients`, the
address list becomes "Who gets lead alerts is chosen in Alert settings." with
the link; its form never sends `leadNotifyEmails`. Tests for both.

---

## 11. `@adminigloo/invoicing` 0.4.0 and `@adminigloo/invoicing-widget` 0.1.1 (platform builder)

### 11.1 Events (root)

```ts
export type InvoicingEventType = "invoice.viewed" | "invoice.paid";
export interface InvoiceEventSnapshot {
  readonly id: string; readonly number: string; readonly status: StoredInvoiceStatus;
  readonly customerName: string | null; readonly customerEmail: string | null;
  readonly total: number; readonly amountPaid: number; readonly balanceDue: number;   // cents
  readonly dueDate: string | null; readonly viewedAt: string | null; readonly paidAt: string | null;
}
export interface InvoicingEvent {
  readonly id: string;              // uuidv7
  readonly type: InvoicingEventType;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly occurredAt: string;
  readonly actor: { readonly type: "customer" | "staff"; readonly id: string | null };
  readonly data: { readonly invoice: InvoiceEventSnapshot; readonly format: MoneyFormatWire };
}
export type InvoicingEventListener = (event: InvoicingEvent) => void | Promise<void>;
```

Both handler factories gain `onEvent?: InvoicingEventListener` and
`onEventError?: (error: unknown, event: InvoicingEvent) => void`, with
scheduling's guarantees word for word (after commit, awaited before the
response, contained, no token in an event, no event for a no-op):

- `invoice.viewed` from the public `viewed` route when `markInvoiceViewed`
  answered true (the first view), actor customer.
- `invoice.paid` from the staff `payment-record` route when the recorded
  payment left the invoice `paid` and it was not `paid` before (a duplicate
  payment reference is no event), actor the staff member.

`format` is the business's (the `business` seam, 2a 10.4).

### 11.2 The overdue sweep (root)

```ts
export interface OverdueInvoice {
  readonly id: string; readonly number: string; readonly customerName: string | null;
  readonly balanceDue: number; readonly dueDate: Date;
}
/**
 * sent / viewed / partial invoices whose due date has passed, and is on or
 * after `dueSince` (YYYY-MM-DD; default today − 7 days in the business's
 * zone, `timeZone`): "goes overdue" is an event, and older ones are the
 * invoice list's job, so the first cron after deploy doesn't email the owner
 * once per old invoice (review BO-15). Oldest due first. Default limit 200.
 * One query on invoices_tenant_idx.
 */
export function listOverdueInvoices(db: InvoicingDb, tenantId: string, options?: { readonly now?: Date; readonly dueSince?: string; readonly timeZone?: string; readonly limit?: number }): Promise<readonly OverdueInvoice[]>;
```

### 11.3 Alert kinds and mappers (root)

```ts
export const invoicingAlertKinds: InvoicingAlertKinds;
export function invoicingAlertsFor(event: InvoicingEvent, options: { readonly hrefs: { readonly invoice: string /* {id} */ } }): readonly InvoicingAlertDraft[];
export function invoicingOverdueAlert(
  tenantId: string, invoice: OverdueInvoice,
  options: { readonly hrefs: { readonly invoice: string }; readonly format: MoneyFormatWire },
): InvoicingAlertDraft;
```

Routing group `{ key: "invoices", label: "Invoices opened, paid or overdue",
description: "A customer opening an invoice, an invoice paid in full, and one
going past its due date.", permission: "invoices.view" }`.

| key | label | default | title | body | dedupeKey |
| --- | --- | --- | --- | --- | --- |
| `invoicing.invoice.viewed` | "A customer opens an invoice" | `in_app` | "{Customer} opened invoice {number}" | "{balance} due {date}" (or "{balance} due" with no date) | `invoicing.invoice.viewed:{invoiceId}` |
| `invoicing.invoice.paid` | "An invoice is paid in full" | `in_app` | "Invoice {number} is paid: {total} from {customer}" | null | `invoicing.invoice.paid:{invoiceId}:{paidAt}` |
| `invoicing.invoice.overdue` | "An invoice goes overdue" | `email` | "Invoice {number} to {customer} is overdue" | "{balance} was due {date}." | `invoicing.invoice.overdue:{invoiceId}:{dueDate as YYYY-MM-DD in the zone}` |

All: category "Invoices", audience routing `invoices`, `invoices.view`,
notifications-sent email. Money with `Intl.NumberFormat(format.locale, {
style: "currency", currency })`, dates in `format.timeZone`. `actorUserId` the
staff member on `invoice.paid`. `subject` `{ type: "invoicing.invoice", id }`.

### 11.4 File records (root, 3.5)

```ts
export function invoicingFileRecords(db: InvoicingDb, options: { readonly invoiceHref: string /* {id} */ }): readonly InvoicingFileRecordType[];
```

`{ type: "invoicing.invoice", label: "Invoice", pluralLabel: "Invoices",
view: ["invoices.view"], manage: ["invoices.manage"] }`; label "Invoice
{number} · {customer}".

### 11.5 Peer, exports

`@adminigloo/comms` optional peer `^0.4.0`. Root exports add the event types,
`listOverdueInvoices`, `OverdueInvoice`, `invoicingAlertKinds`,
`invoicingAlertsFor`, `invoicingOverdueAlert`, `invoicingFileRecords` and their
types. No wire change.

### 11.6 `@adminigloo/invoicing-widget` 0.1.1

Optional peer `@adminigloo/invoicing` `^0.4.0`. Nothing else.

---

## 12. `@adminigloo/comms` 0.4.0 and `@adminigloo/comms-widget` 0.1.1 (platform builder)

### 12.1 A final failure is told (`CommsDeliveryConfig`)

```ts
export interface CommsFailure {
  readonly tenantId: string;
  /** The delivery-log row that recorded it; null for a queued message abandoned mid-send. */
  readonly messageId: string | null;
  /** The queued message, when it came from the queue. */
  readonly scheduledId: string | null;
  readonly channel: CommsChannel;
  readonly to: string;
  readonly templateKey: string;
  /** The log's words. */
  readonly error: string;
  readonly at: Date;
}
interface CommsDeliveryConfig {
  // …0.3's, plus:
  /**
   * Told once a message has FAILED FOR GOOD (Tenancy 2b-1): every failed
   * `sendNow` / `deliverNow`, and a queued message the drain gives up on
   * (permanent, or out of attempts, or abandoned out of attempts). Not told
   * about a failure the queue will retry, nor about a skip (no provider set
   * up is not a failure). Awaited; a throw is swallowed (the host's own
   * reporter's job), so it can never fail a send or a drain.
   */
  onFailed?: (failure: CommsFailure) => void | Promise<void>;
}
```

`handleClaimed`'s outcome carries the last log row's id, so the drain can say
which row it gave up on.

### 12.2 `deliverNow`

```ts
/** `sendNow`, plus whether trying again could change the outcome (deliver's own `permanent`). */
export function deliverNow(db: CommsDb, input: SendInput, senders: CommsSenders): Promise<{ readonly message: MessageRow; readonly retryable: boolean }>;
```

The alert email seam uses it (13.6), so a held message (the allowance) or a
provider hiccup is retried by the alerts cron and a refused address is not.
`sendNow` is unchanged (it is `deliverNow(...).message`).

### 12.3 Words and the alert kind (root)

```ts
/** "visit_reminder" → "Visit reminder"; "team_alert" → "Team alert". Moved from comms-widget's words (the widget keeps its copy). */
export function templateLabel(key: string): string;
export const commsAlertKinds: CommsAlertKinds;
/** null for a template not in `customerTemplateKeys` (an office notice, a team alert): only customer emails are alerted. */
export function commsFailureAlert(
  failure: CommsFailure,
  options: { readonly href: string; readonly customerTemplateKeys: ReadonlySet<string> },
): CommsAlertDraft | null;
```

| key | label | category | audience | default | email |
| --- | --- | --- | --- | --- | --- |
| `comms.message.failed` | "An email to a customer doesn't go" | Messages | `comms.manage` | `in_app` | **false** (never emailed: an alert about mail that failed mustn't depend on mail, and it can't loop) |

Title "The {template label in lower case} email to {to} didn't go" (e.g. "The
visit reminder email to pat@x.com didn't go"; review BO-26; `templateLabel`
keeps title case for lists); body "Open Messages to see what happened."; dedupeKey `comms.message.failed:{messageId}` (or
`comms.message.failed:queued:{scheduledId}`); `subject` `{ type:
"comms.message", id: messageId ?? scheduledId }`.

### 12.4 `@adminigloo/comms-widget` 0.1.1

Optional peer `@adminigloo/comms` `^0.4.0`. `team_alert` already groups under
"Other" and labels "Team alert"; a test pins that.

---

## 13. create-app 0.24.0: the wiring plan (create-app builder)

A file-by-file plan. Every new or changed emitted file obeys the generator
rules: no emitted `if` about a feature or a mode, overlays only add, pages are
thin wrappers around package components. "Companies" means `tenantNoun !==
"none"`; "single" means `"none"`; "shell" means `adminShell !== "none"`.

### 13.1 Answers, packages, versions

**`versions.ts`** (each with its why-comment):

| Package | Version |
| --- | --- |
| `notifications` | `0.2.0` |
| `notifications-widget` | `0.1.0` (new entry) |
| `storage` | `0.2.0` |
| `storage-widget` | `0.1.0` (new entry) |
| `tenancy` | `0.6.0` |
| `tenancy-widget` | `0.2.1` |
| `scheduling` | `0.6.0` |
| `scheduling-widget` | `0.3.0` |
| `estimator` | `0.5.0` |
| `estimator-widget` | `0.4.0` |
| `invoicing` | `0.4.0` |
| `invoicing-widget` | `0.1.1` |
| `comms` | `0.4.0` |
| `comms-widget` | `0.1.1` |

**`answers.ts`**
- `packagesFor`: `notifications-widget` with `--notifications`;
  `storage-widget` with `--storage`. `@vercel/blob` stays a project dependency
  with `--storage` (the project hands its functions to the adapter, 6.2).
- The comments on `includeNotifications` and `includeStorage` are rewritten:
  the producers are wired (no longer "yours to wire"); files are private.
- `overlayNamesFor`:

  | Overlay | Pushed when | Holds |
  | --- | --- | --- |
  | `notifications` | never (empty after 13.2) | |
  | `notifications-companies` | companies && notifications | 13.3's alert pages and the alerts route |
  | `notifications-single` | single && notifications | `app/api/admin/alerts/[...path]/route.ts` |
  | `notifications-admin` | single && notifications && shell | `/admin/alerts`, `/admin/alerts/settings`, `/admin/inbox` (a redirect) |
  | `storage` | storage | `app/api/files/[...path]/route.ts` (signed links and public files, both modes), `app/api/cron/files/route.ts` |
  | `storage-companies` | companies && storage | `/app/files` and the files route |
  | `storage-visits-companies` | companies && storage && scheduling | `/app/schedule/visits/[id]/files` |
  | `storage-single` | single && storage | `app/api/admin/files/[...path]/route.ts` |
  | `storage-admin` | single && storage && shell | `/admin/files` (rewritten thin) |
  | `storage-visits-admin` | single && storage && scheduling && shell | `/admin/schedule/visits/[id]/files` |

- `capabilityKeysFor`: `notifications.inbox` and `storage.library` are pushed
  for companies OR a shell (a company's area needs no shell); new keys
  `notifications.bell` (notifications), `notifications.producers`
  (notifications and any 2a feature), `storage.attachments` (storage and any
  of scheduling, estimator, invoicing).
- The README's answer and capability tables follow.

### 13.2 Overlays retired or re-cut

| From | To |
| --- | --- |
| `overlays/notifications/src/server/notify.ts` | deleted: `notifyStaff` is replaced by the emitted `src/server/alerts.ts` (13.5) |
| `overlays/notifications/src/server/routers/notifications.ts` | deleted (tRPC retired, D16; 2a D3's reason) |
| `overlays/notifications-admin/app/admin/inbox/page.tsx` | rewritten: `redirect("/admin/alerts")` |
| `overlays/storage/app/api/files/route.ts` | deleted (0.1's staff upload; uploads are the package's routes) |
| `overlays/storage/src/server/blob-store.ts` | deleted: the stores are built in the emitted `src/server/files.ts` from the package's adapter |
| `overlays/storage/src/server/routers/files.ts` | deleted (tRPC retired) |
| `overlays/storage-admin/app/admin/files/page.tsx` | rewritten thin (13.4) |

`ROUTER_SCOPES` (tenancy-proofs-emit.ts) loses `notifications` and `files`;
`renderAppRouter` loses both routers; `procedure-scopes.test.ts` follows.

### 13.3 Companies mode: pages and routes

Every private page is a server component calling `CompanyGate` itself, with
the permission in the table; widgets get `baseUrl` and nothing else they could
get wrong.

| Page (overlay) | Gate permission | Renders |
| --- | --- | --- |
| `app/(site)/app/alerts/page.tsx` (`notifications-companies`) | `alerts.view` | `<PageHeader title="Alerts" actions={Alert settings link}>` then `<AlertsInbox baseUrl={`/api/app/${company.id}/alerts`}>` |
| `app/(site)/app/alerts/settings/page.tsx` (`notifications-companies`) | `alerts.view` | `<PageHeader title="Alert settings" description="How you hear about what happens at {company}.">` then `<AlertSettings baseUrl>` |
| `app/(site)/app/files/page.tsx` (`storage-companies`) | `files.view` | `<PageHeader title="Files">` then `<FilesManager baseUrl={`/api/app/${company.id}/files`} platformName={SITE_NAME}>` |
| `app/(site)/app/schedule/visits/[id]/files/page.tsx` (`storage-visits-companies`) | none (the visit decides, D12) | `<RecordFiles baseUrl record={{ type: "scheduling.visit", id }} backHref={can.includes("schedule.view") ? `/app/schedule?visit=${id}` : "/app/schedule/today"}>` (a runtime permission choice, commented) |

| Route file | Builder |
| --- | --- |
| `app/api/app/[tenantId]/alerts/[...path]/route.ts` (`notifications-companies`) | `buildAlertsHandlers()` |
| `app/api/app/[tenantId]/files/[...path]/route.ts` (`storage-companies`) | `buildFilesHandlers()` |
| `app/api/files/[...path]/route.ts` (`storage`, both modes) | `buildFileLinkHandlers()` (GET and HEAD only) |
| `app/api/cron/alerts/route.ts` (emitted, 13.8) | |
| `app/api/cron/files/route.ts` (`storage`, both modes) | `files.purgeDeleted({ timeBudgetMs: 45_000 })` |

Each route file is the 2a two-liner (`runtime = "nodejs"`, `dynamic =
"force-dynamic"`, `maxDuration = 30` for the files routes).

**Changed 2a pages (static overlays):**
- `scheduling-companies/app/(site)/app/schedule/page.tsx`: reads
  `searchParams.visit` (a 1–128 id shape, else undefined) into
  `<ScheduleCalendar initialVisitId>`, and passes
  `visitFilesHref={VISIT_FILES_HREF}`.
- `scheduling-companies/app/(site)/app/schedule/today/page.tsx`:
  `<CrewDay filesHref={VISIT_FILES_HREF}>`.
- `estimator-companies/app/(site)/app/estimates/[id]/page.tsx`: after
  `<EstimateEditor>`, `<RecordFilesSlot baseUrl={`/api/app/${company.id}/files`}
  record={{ type: "estimator.estimate", id }} title="Other files" hint={ESTIMATE_FILES_HINT} />`
  with `ESTIMATE_FILES_HINT = "Photos of the job go in Photos above, so the
  estimate can read them. Your team sees these; they aren't sent to the
  customer."` (review BO-13, BO-22; the editor already has its own "Photos"
  panel, so this card is for everything else).
- `invoicing-companies/app/(site)/app/invoices/[id]/page.tsx`: after
  `<InvoiceEditor>`, `<RecordFilesSlot … record={{ type: "invoicing.invoice", id }}
  hint="Your team sees these; they aren't sent to the customer." />`.

`VISIT_FILES_HREF` comes from the emitted `src/server/visit-files.ts` (with
scheduling): `"/app/schedule/visits/{id}/files"` with storage, `undefined`
without (two variants, no `if`). `RecordFilesSlot` is 13.5's.

### 13.4 Single-business mode

| File (overlay) | Content |
| --- | --- |
| `app/admin/alerts/page.tsx` (`notifications-admin`) | `<AlertsInbox baseUrl="/api/admin/alerts">` under the shell's `PageHeader` |
| `app/admin/alerts/settings/page.tsx` (`notifications-admin`) | `<AlertSettings baseUrl="/api/admin/alerts">` |
| `app/admin/inbox/page.tsx` (`notifications-admin`) | `redirect("/admin/alerts")` |
| `app/api/admin/alerts/[...path]/route.ts` (`notifications-single`) | `buildAlertsHandlers()` (single variant) |
| `app/admin/files/page.tsx` (`storage-admin`) | `<FilesManager baseUrl="/api/admin/files" platformName={SITE_NAME}>` |
| `app/admin/schedule/visits/[id]/files/page.tsx` (`storage-visits-admin`) | `<RecordFiles baseUrl="/api/admin/files" record={{ type: "scheduling.visit", id }} backHref="/admin/schedule/today">` |
| `app/api/admin/files/[...path]/route.ts` (`storage-single`) | `buildFilesHandlers()` (single variant) |
| `scheduling-admin`'s `/admin/schedule` and `/admin/schedule/today` | `initialVisitId`, `VISIT_FILES_HREF` (`"/admin/schedule/visits/{id}/files"` single variant) |
| `estimator-admin`'s `/admin/estimates/[id]`, `invoicing-admin`'s `/admin/invoices/[id]` | `<RecordFilesSlot baseUrl="/api/admin/files" record={…} … />` with 13.3's `title` and `hint` |

Single without a shell: the bell is shown to staff with no "See all" or
settings links (`links` null), and the 2a office-notice lists keep working
exactly as in 2a (no `officeRecipients`, no `alertsHref`): there is no Alert
settings page to move them to. Listed as not included.

### 13.5 Emitted modules (both modes unless said; the generator writes the variant)

**`src/server/alerts.ts`** (with --notifications). The instance, the
producers and the sweeps. It must NOT import `company-routes` (13.10).

```ts
/** GENERATED: one fragment per installed package (tenancy in companies mode only; storage's with --storage). */
export const ALERT_REGISTRY = defineAlertRegistry([tenancyAlertKinds, schedulingAlertKinds, estimatorAlertKinds, invoicingAlertKinds, commsAlertKinds, storageAlertKinds]);
/** GENERATED per mode: where each kind opens. `visitFiles` with storage and scheduling only. */
export const ALERT_HREFS = {
  team: "/settings/team",
  visit: "/app/schedule?date={date}&visit={id}", crewDay: "/app/schedule/today", visitFiles: "/app/schedule/visits/{id}/files",
  estimate: "/app/estimates/{id}", invoice: "/app/invoices/{id}", messages: "/app/messages", files: "/app/files",
} as const;
/** createNotifications({ db, tables: notificationTables, registry: ALERT_REGISTRY, people, ownerEmail (companies), email?, emailIdempotent: true (with comms: Resend honours the key), emailDelivery?, onError }) */
export const alerts: Notifications;
export async function alertOnTenancyEvent(event: TenancyEvent): Promise<void>;       // companies; + forget on member.removed / member.left; + prune on member.role.changed
export async function alertOnSchedulingEvent(event: SchedulingEvent): Promise<void>; // with scheduling
export async function alertOnEstimatorEvent(event: EstimatorEvent): Promise<void>;   // with the estimator
export async function alertOnInvoicingEvent(event: InvoicingEvent): Promise<void>;   // with invoicing
export async function alertOnCommsFailure(failure: CommsFailure): Promise<void>;     // with comms
/** Storage's onUsage (6.6, 6.15): storageUsageAlert → alerts.notify, and a refusal reported to /admin/errors at most once a day per company. With storage. */
export async function alertOnStorageUsage(event: StorageUsageEvent): Promise<void>;
/** Per company, from the alerts cron: requests about to lapse (scheduling), invoices newly overdue (invoicing). GENERATED body. */
export async function runAlertSweeps(tenantId: string): Promise<{ readonly alerted: number }>;
/** The office emails' recipients (D6): alerts.claimEmails (which throws only when its database fails, so the listener falls back to staffEmails). With comms. */
export async function officeRecipientsFor(notice: { tenantId: string; kind: string; dedupeKey: string; assignedUserIds: readonly string[] }): Promise<readonly string[]>;
/** The office emails' outcomes (D6, review BO-02): a `failed` + retryable one → alerts.releaseClaim. With comms. */
export async function officeSentFor(
  notice: { tenantId: string; kind: string; dedupeKey: string },
  result: { to: string; status: "sent" | "skipped" | "failed"; retryable: boolean },
): Promise<void>;
/** Insert team_alert for a company if absent, once per process. With comms. */
export async function ensureTeamAlertTemplate(tenantId: string): Promise<void>;
```

- **`people`, companies**: `companyProfile(id)`; not an active org → `[]`;
  else `tenancy.listMemberPeople(id, { holding: permission })` mapped to
  `{ userId, name, email, isOwner: roleKey === "owner" }`.
- **`ownerEmail`, companies** (review BO-01): `async (id) =>
  (await tenancy.companyProfile(id))?.inbox[0] ?? null` (2a D8's inbox: the
  business email from company settings, else the owner's own address).
  Single: not passed (each staff admin's own address).
- **`alertOnTenancyEvent`, role change** (review G4): on `member.role.changed`,
  the person's new permission set among `ALERT_REGISTRY.permissions` is read
  with `tenancy.listMemberPeople(id, { holding })` per permission (memoised
  for the call), and `alerts.prune({ tenantId, userId, permissions })` runs.
- **`people`, single**: the site's staff (users holding a FIRM-WIDE staff
  role), filtered by `loadStaffPermissions(…).can(STAFF_KEY_FOR[permission])`,
  `isOwner` = holds the staff `admin` template. `STAFF_KEY_FOR` is the
  generated spread of `SCHEDULING_STAFF_KEYS`, `ESTIMATOR_STAFF_KEYS`,
  `INVOICING_STAFF_KEYS`, `COMMS_STAFF_KEYS` and `ALERTS_STAFF_KEYS`
  (`alerts.view` → `staff.alerts.view`, `alerts.manage` →
  `staff.alerts.manage`); a key with no mapping holds nobody.
  `ALERTS_TENANT = "primary"` lives here, single variant only.
- **`email`** (with comms): `ensureTeamAlertTemplate(tenantId)`, then
  `deliverNow(db, { tenantId, to, templateKey: "team_alert", vars: { title,
  body, linkLine, settingsLine, businessName }, idempotencyKey, replyTo },
  commsSenders)`; `sent` → sent, `skipped` → skipped, `failed` → failed with
  `retryable`. Links: companies `companyLinksFor(profile.slug).app(href)`
  (through the switch route, 2a D2); single `new URL(href, appUrl)` only when
  its origin is `appUrl`'s (review G15; otherwise the Alerts page's link).
  `settingsLine` by 4.9's rule (an `addressOnly` message: "You get this
  because {businessName} added this address."). `businessName`: the company's
  name (single: `SITE_NAME`).
- **`emailDelivery`** (with comms): `{ available: commsEmailConfigured,
  offReason: commsEmailConfigured ? null : "This site doesn't send email yet,
  so alerts stay in the app.", offKinds }`, where `offKinds` (review BO-11)
  comes from ONE query of the company's `comms_templates` rows with
  `is_active = false` among `team_alert` and the producer kinds' templates
  (the generated `ALERT_EMAIL_TEMPLATES`: `estimator.lead` →
  `estimate_lead_staff`, the three quote kinds → `quote_staff_notice`, the
  scheduling producer kinds → `visit_staff_notice`, every other kind →
  `team_alert`), each named by comms' `templateLabel` (the name the Messages
  screen shows: "New lead (to your office)", "Team alert"). Without comms:
  neither seam is passed (in the app only; Alert settings says so).
- **`onError`**: `log.error` and `reportError` (`/admin/errors`), with
  `feature: "alerts"`.
- `CUSTOMER_TEMPLATE_KEYS` (with comms): generated from the installed
  packages' own lists (`SCHEDULING_EMAIL_TEMPLATES` and
  `ESTIMATOR_EMAIL_TEMPLATES` entries with `audience: "customer"`,
  `INVOICE_EMAIL_TEMPLATES`).

**`src/server/alerts-routes.ts`** (with --notifications):
`buildAlertsHandlers(overrides?: FeatureHandlerOverrides)`:
companies → `createNotificationHandlers({ notifications: alerts, resolveTenant:
companyRoutes.resolveTenant, authorize: companyAuthorizer(overrides), links: {
inbox: "/app/alerts", settings: "/app/alerts/settings", messages:
"/app/messages" (with comms) }, hrefFor, onError })`, where `hrefFor`
(review G16) answers the PATH form of `companyLinksFor(slug).app(href)`
(`/app/switch/{slug}?next=…`, which `safeSwitchNext` already validates), the
slug read once per request through `companyProfile`; single → `tenantId:
ALERTS_TENANT`, `authorize: authorizeStaffFor(STAFF_KEY_FOR, "Sign in to see
your alerts.")`, links `/admin/alerts`, `/admin/alerts/settings` and
`/admin/messages` (with comms) (all null without a shell), no `hrefFor`.

**`src/server/files.ts`** (with --storage). The stores and the instance. It
must NOT import `company-routes` (tenancy imports it for the logo, 13.10).

```ts
import * as vercelBlob from "@vercel/blob";
/**
 * Private files (D10): a PRIVATE Vercel Blob store. A token equal to the
 * public store's is refused by the env check (13.7, review G9).
 */
const privateBlob = env.BLOB_PRIVATE_READ_WRITE_TOKEN ? createVercelBlobStore({ sdk: vercelBlob, token: env.BLOB_PRIVATE_READ_WRITE_TOKEN, access: "private" }) : undefined;
/** Public files (the logo): the project's existing public store. */
const publicBlob = env.BLOB_READ_WRITE_TOKEN ? createVercelBlobStore({ sdk: vercelBlob, token: env.BLOB_READ_WRITE_TOKEN, access: "public" }) : undefined;
/**
 * Review BO-08: with NEITHER token and outside production, files are kept on
 * this machine's disk (`.data/files/`, git-ignored) so `pnpm dev` and a
 * client-style install have working logo uploads and job photos. An
 * ENVIRONMENT check, not a feature or mode conditional (generator rule 1):
 * the same file is emitted for every project with storage.
 */
const devDisk = !privateBlob && !publicBlob && env.NODE_ENV !== "production";
const privateStore = privateBlob ?? (devDisk ? createLocalDiskStore({ dir: ".data/files/private", access: "private" }) : undefined);
const publicStore = publicBlob ?? (devDisk ? createLocalDiskStore({ dir: ".data/files/public", access: "public" }) : undefined);
/** What the project's own tests build too (14.1): the same purposes, records and rules over any stores. */
export function createFilesStorage(
  stores: { readonly private?: BlobStore; readonly public?: BlobStore },
  options?: { readonly signingSecret?: string | null; readonly stillValid?: FileLinkStillValid },
): Storage;
export const files: Storage;   // createFilesStorage({ private: privateStore, public: publicStore }, { signingSecret: fileLinkSecret() })
export const filesLogoStore: StorageLogoStore | undefined;    // files.logoStore()
export const estimatorPhotoStore: StoragePurposeStore | undefined;   // with the estimator: files.purposeStore("estimator.photo")
/** GENERATED: the purposes the files cron moves out of the public store (review G11). ["estimator.photo"] with the estimator, [] without. */
export const FILES_MOVE_TO_PRIVATE: readonly string[];
```

`createFilesStorage` passes: `tables: storageTables` (D14, review G1);
`purposes: [...STORAGE_BUILT_IN_PURPOSES, estimatorPhotoPurpose]` (the
estimator's only with it); `records: [...schedulingFileRecords(db, {
visitHref }), ...estimatorFileRecords(db, { estimateHref }),
...invoicingFileRecords(db, { invoiceHref })]` (each with its feature; the
hrefs per mode); `allowanceBytes: () => (env.FILES_ALLOWANCE_MB ?? 5120) *
1024 * 1024` with a why-comment (the platform owner's default, 5 GB, review
BO-07; the billing chunk replaces this function with the plan's answer);
`signing` when a secret is known (`fileLinkSecret()`: `FILES_LINK_SECRET`,
else, review BO-19, `HMAC-SHA256(CLERK_SECRET_KEY, "adminigloo:file-links:v1")`
in hex, with a why-comment that rotating Clerk's key ends every open link;
neither set: no links), with `stillValid` (review G2): companies `async ({
tenantId, userId }) => (await tenancy.companyProfile(tenantId))?.status ===
"active" && (await tenancy.membership({ userId, tenantId }))` admits them
(the gate's own verdict), with `tenancy` reached by a DYNAMIC import inside
the function (`files.ts` must not import `tenancy.ts` at load, 13.10 rules 2
and 4); `createFilesStorage`'s `stillValid` option replaces it (type
`FileLinkStillValid` = `CreateStorageOptions["signing"]["stillValid"]`);
single: the user still holds a firm-wide staff role (`loadStaffPermissions`,
also imported dynamically);
`onUsage` (with notifications) → `(event) => import("./alerts").then((m) =>
m.alertOnStorageUsage(event))`, DYNAMIC on purpose (13.10); without
notifications, a refusal is still reported to `/admin/errors` at most once a
day per company (an in-process map, as `companySendAllowance`'s);
`urls.content`: companies ``(t, id) =>
`/api/app/${t}/files/v1/admin/files/${encodeURIComponent(id)}/content` ``,
single `` `/api/admin/files/v1/admin/files/${…}/content` ``; `urls.publicBase`:
`new URL("/api/files", appUrl)`. `FILES_TENANT = "primary"` in the single
variant.

**`src/server/files-routes.ts`** (with --storage):
`buildFilesHandlers(overrides?: FeatureHandlerOverrides & { readonly storage?:
Storage })` (companies: `companyRoutes.resolveTenant`,
`companyAuthorizer(overrides)`, `names` from `listMemberPeople`,
`companyName` from `companyProfile`, `rateLimit` on the project's limiter
(review BO-09): uploads keyed `files:{tenantId}:{userId}:upload` at 120 an
hour per person AND `files:{tenantId}:upload` at 600 an hour per company;
links `files:{tenantId}:link` at 60 an hour per company; single: `tenantId:
FILES_TENANT`, `authorizeStaffFor(FILES_STAFF_KEY_FOR, "Sign in to see
files.")` where `FILES_STAFF_KEY_FOR` spreads the installed features' staff
keys and `files.view` → `staff.files.view`, `files.manage` →
`staff.files.manage`, the same limits keyed on `FILES_TENANT`);
`buildFileLinkHandlers()`.

**`src/components/AlertsBellSlot.tsx`** (every project; three variants):

```tsx
export function AlertsBellSlot(props: { readonly session: SessionState | null; readonly can: readonly string[]; readonly isStaff: boolean }): ReactNode;
```

- companies + notifications: a ready session whose `can` includes
  `alerts.view` → `<AlertsBell baseUrl={`/api/app/${session.company.id}/alerts`} />`,
  else null (runtime state, commented);
- single + notifications: staff → `<AlertsBell baseUrl="/api/admin/alerts" />`
  (the bell hides itself on a 401 or 403, section 5);
- no notifications: returns null ("generated without alerts").

**`src/components/RecordFilesSlot.tsx`** (every project with any of
scheduling, estimator, invoicing; two variants): props `{ baseUrl, record,
title?, hint? }`; with storage `<RecordFiles baseUrl={props.baseUrl}
record={props.record} title={props.title} hint={props.hint} />`; without, it
renders null and says why in a comment.

**`src/server/visit-files.ts`** (with scheduling; two variants per mode):
`export const VISIT_FILES_HREF: string | undefined`.

**`src/server/tenancy-logo.ts`** (2a's, re-cut): with storage
`export const tenancyLogoStore: LogoStore | undefined = filesLogoStore;`
(from `./files`); without, `undefined` as in 2a.

**`src/server/estimator-services.ts`** (2a's, re-cut): the photo store block
becomes `export { estimatorPhotoStore } from "@/server/files";` with storage
(the `getBlobStore` / 0.1 `storeFile` block is deleted); without storage,
unchanged.

**`src/server/scheduling-notify.ts` / `estimator-notify.ts`** (both modes,
with notifications): `LISTENERS` becomes `[alertOnSchedulingEvent,
schedulingComms.onEvent]` (ALERTS FIRST, 4.5), or `[alertOnSchedulingEvent]`
without comms. With comms, the listener gets `officeRecipients: (notice) =>
officeRecipientsFor(notice)` and `officeSent: (notice, result) =>
officeSentFor(notice, result)` (companies, and single with a shell); it KEEPS
2a's `staffEmails` (the company's inbox), which is now read only when
`officeRecipients` throws (3.4, review BO-02). `schedulingAlertsFor` gets
`hrefs: { visit, crewDay, visitFiles: VISIT_FILES_HREF }` (the generated
constant: undefined without storage). The estimator's the same.

**`src/server/scheduling.ts` / `estimator.ts`** (admin builders, with
notifications): `alertsHref: "/app/alerts/settings"` (single with a shell:
`"/admin/alerts/settings"`; single without: not passed).

**`src/server/invoicing.ts`** (with notifications): both builders get
`onEvent: (event) => alertOnInvoicingEvent(event)`.

**`src/server/comms-senders.ts`** (with notifications): `onFailed: (failure)
=> import("./alerts").then((m) => m.alertOnCommsFailure(failure))`. DYNAMIC on
purpose (13.10), with tenancy.ts's comment.

**`src/server/comms-senders.ts`, the team allowance** (companies, with comms;
review BO-10): `COMMS_SEND_ALLOWANCE` gains `team: { hour: 60, day: 300 }`,
and a generated `TEAM_TEMPLATE_KEYS = new Set(["team_alert",
"estimate_lead_staff", "quote_staff_notice", "visit_staff_notice"])` (only the
installed packages' keys). `companySendAllowance` reads the message's
`templateKey`: a team template counts in `comms-out-team:{bucket}:{tenantId}`
at the team caps (the same for a new company: these go only to its own people
and at most five addresses per group), never in the customer bucket
`comms-out:{bucket}:{tenantId}`; everything else exactly as 2a. Its report
names which allowance was reached.

**`src/server/company-setup.ts`** (companies): `SETUPS` gains `{ name:
"alerts", run: (id) => ensureTeamAlertTemplate(id) }` with notifications and
comms; `onCompanyEvent` calls `alertOnTenancyEvent(event)` with notifications
(a generated line). Single mode: `ensureTeamAlertTemplate` runs lazily from
the email seam.

**`src/server/permissions.ts` / the catalog (`renderPermissionsCatalog`)**:
- `PACKAGE_PERMISSION_FRAGMENTS` gains two TENANT rows: `notificationsPermissions`
  (`companies && notifications`) and `storagePermissions` (`companies &&
  storage`), each with its `why` (every company hears about and keeps its own
  work).
- Single-mode staff keys (`single && …`):

  | Key | Label | defaultFor |
  | --- | --- | --- |
  | `staff.alerts.view` | "Get alerts" | admin, cs_lead, cs_agent |
  | `staff.alerts.manage` | "Choose who hears about new work" | admin |
  | `staff.files.view` | "See files" | admin, cs_lead |
  | `staff.files.manage` | "Manage files" | admin |

- A generator test: every route-table permission (alerts and files) is
  declared in the catalog its mode uses; every kind's audience permission and
  every record type's permissions are declared.

**`src/nav.ts`**: companies `APP_LINKS` gains `{ label: "Files", href:
"/app/files", permission: "files.view" }` with storage, after Messages. Single
admin nav: "Inbox" becomes "Alerts" (`/admin/alerts`) with notifications;
"Files" stays.

**`template/src/components/AuthHeader.tsx`**: renders `<AlertsBellSlot
session={viewer.session} can={viewer.can} isStaff={viewer.isStaff} />` just
before `<UserButton />`, OUTSIDE the phone menu (the bell must show on a
phone), inside the existing try/catch.

**`src/server/company-links.ts`** (companies): `CompanyLinks.app` widens to
`` (path: `/app/${string}` | `/settings/${string}` | "/dashboard") => string ``
and `safeSwitchNext` admits `/settings/company` and `/settings/team` (an
alert about the team opens the team page). Its test adds both.

### 13.6 Who is told, in what order (summary for the builder)

| Producer | Glue | Listeners, in order |
| --- | --- | --- |
| tenancy `onEvent` | `company-setup.ts` `onCompanyEvent` | setup (2a), `alertOnTenancyEvent` (alerts, then `forget` on removal, `prune` on a role change) |
| scheduling `onEvent` | `scheduling-notify.ts` `LISTENERS` | `alertOnSchedulingEvent`, then the comms listener (office email via `officeRecipientsFor`; each outcome to `officeSentFor`) |
| estimator `onEvent` | `estimator-notify.ts` `LISTENERS` | `alertOnEstimatorEvent`, then the comms listener (the same) |
| invoicing `onEvent` | `invoicing.ts` | `alertOnInvoicingEvent` |
| comms `onFailed` | `comms-senders.ts` | `alertOnCommsFailure` |
| storage `onUsage` | `files.ts` | `alertOnStorageUsage` (with notifications) |
| the alerts cron | `app/api/cron/alerts/route.ts` | `runAlertSweeps` per company, then `deliverPendingEmails` (active companies), then `cleanup` |
| the files cron | `app/api/cron/files/route.ts` | `purgeDeleted`, then `moveToPrivate({ purpose: "estimator.photo" })` (with the estimator), then `checkPrivateStore` (a failure reported) |

### 13.7 Env and `/setup`

- `BLOB_PRIVATE_READ_WRITE_TOKEN` (storage, optional): "Photos and files on
  visits, estimates and invoices, and customers' estimate photos. Without it
  they can't be added, and the screens say so." The env check REFUSES it when
  it equals `BLOB_READ_WRITE_TOKEN` ("The private store needs its own token:
  connect a second Blob store with access Private."; review G9).
- `BLOB_READ_WRITE_TOKEN` (storage): its row now says "Company logos (and
  feedback screenshots)".
- **/setup's storage rows** (review BO-08, G9): with `BLOB_READ_WRITE_TOKEN`
  set and `BLOB_PRIVATE_READ_WRITE_TOKEN` not, a warning row: "Customers'
  estimate photos and job photos aren't kept until the private store is
  connected." With neither, in development: "Files are kept on this computer
  (.data/files) until a Blob store is connected." With the private store set,
  the row runs `files.checkPrivateStore()` and shows its `reason` when not ok.
- `FILES_ALLOWANCE_MB` (storage, optional, a whole number 1–1048576, default
  5120): "How much each company may store. The billing chunk will set this
  per plan."
- `FILES_LINK_SECRET` (storage, optional, at least 32 characters): "Copy a
  link to a file. Without it a key is made from your Clerk secret key." (review
  BO-19).
- `CRON_SECRET`'s condition adds notifications and storage.

### 13.8 Crons

- **`/api/cron/alerts`** (emitted, both modes; with notifications), the 2a
  secret check, `maxDuration = 60`:
  - companies: `runForEachCompany(tenancy, (id) => runAlertSweeps(id), {
    timeBudgetMs: 30_000, onError: log })`, then `alerts.deliverPendingEmails({
    tenantIds: await tenancy.activeCompanyIds(), limit: 1000, timeBudgetMs:
    15_000 })` (a run that `stoppedEarly` is reported to `/admin/errors`, 2a
    §18; review BO-14), then `alerts.cleanup({ timeBudgetMs: 5_000 })`;
    answers the three reports.
  - single: the same with `tenantIds: [ALERTS_TENANT]`.
- **`/api/cron/files`** (static, `storage` overlay): `files.purgeDeleted({
  timeBudgetMs: 30_000 })`; then, for each purpose in the generated
  `FILES_MOVE_TO_PRIVATE` (from `files.ts`: `["estimator.photo"]` with the
  estimator, `[]` without: a generated array, no `if`), `files.moveToPrivate({
  purpose, timeBudgetMs: 10_000 })` (review G11); then
  `files.checkPrivateStore()`, a failure reported to `/admin/errors` (review
  G9).
- **`vercel.json`**: `/api/cron/alerts` at `15 14 * * *` with notifications;
  `/api/cron/files` at `45 14 * * *` with storage. DEPLOYMENT.md: a daily run
  retries an alert email once a day; point any scheduler at the route every
  15 minutes for retries within the hour.

### 13.9 Everything else the generator writes

- **`capabilities.ts`** (each with a real `provenBy`):
  - `notifications.producers`: `src/server/alerts.ts` contains
    `createNotifications(` and each installed producer (`alertOnSchedulingEvent`
    … ), and `scheduling-notify.ts` / `estimator-notify.ts` list it first in
    `LISTENERS`;
  - `notifications.bell`: `AlertsBellSlot.tsx` contains `<AlertsBell`;
  - `notifications.inbox`: the companies or single inbox page contains
    `<AlertsInbox`;
  - `storage.files`: `src/server/files.ts` contains `createStorage(` and
    `app/api/files/[...path]/route.ts` exists;
  - `storage.library`: the Files page contains `<FilesManager`;
  - `storage.attachments`: `RecordFilesSlot.tsx` contains `<RecordFiles`;
  - `estimator.photos`: `src/server/files.ts` contains
    `purposeStore("estimator.photo")` (it was the 0.1 `storeFile` block).
- **README (emitted) and create-app's README**: an "Alerts and files" section
  (what each company gets: the bell, the choices, who hears about new work,
  files on visits, estimates and invoices, the Files screen and its allowance),
  and 17.2's "Not included" verbatim. **DEPLOYMENT.md**: the two new crons,
  `FILES_ALLOWANCE_MB`, `FILES_LINK_SECRET`, and (review BO-19, Q1 resolved:
  two stores, as Ask Lou's `privateBlob.ts` runs them, because a Vercel Blob
  store is public or private as a whole) these exact steps: "Keep the Blob
  store you have: it holds company logos. For photos and files, in the Vercel
  dashboard open Storage → Create → Blob, set its access to Private, and
  connect it to this project with the environment variable prefix
  `BLOB_PRIVATE` (that gives `BLOB_PRIVATE_READ_WRITE_TOKEN`). Redeploy."
  Then a paragraph **"What files cost"**: Vercel's included Blob storage and
  operations are for the whole platform, not per company; every thumbnail
  view runs a function and a store read (cached in the browser for five
  minutes); for a platform with many companies, R2 through
  `@adminigloo/storage/s3` (one change in `src/server/files.ts`) costs less.
  The template's `_gitignore` (`template/_gitignore`, every project; harmless
  without storage) gains `.data/` (review BO-08).
- **`add.ts`**: `add notifications` and `add storage` re-emit 13.5's modules
  and apply the overlays of the project's mode.
- **D12's grep** (2a's generator test) adds `ALERTS_TENANT` and
  `FILES_TENANT`.

### 13.10 Import order

`company-routes → company-setup → the feature glue → scheduling-notify →
alerts` is a chain, and `tenancy.ts → tenancy-logo → files` another. They stay
safe by four rules, each said in a comment where it applies:

1. `alerts.ts` and `files.ts` never import `company-routes`; their handler
   builders live in `alerts-routes.ts` and `files-routes.ts`, which only route
   files import.
2. `files.ts` imports nothing that imports `tenancy.ts` (it needs only `db`,
   `env` and the packages) at load, because `tenancy.ts` imports it at load;
   its `stillValid` and `onUsage` reach `tenancy` and `alerts` by dynamic
   imports inside the functions.
3. Every cross-module use inside the chains happens INSIDE a function, never at
   a module's top level (2a 11.5's rule).
4. `comms-senders.ts` reaches `alerts.ts` by a dynamic import (the
   `tenancy.ts` precedent), and so does `files.ts`.

The emitted unit tests import each glue module first and alone (2a's rule),
which fails loudly if any of this breaks.

### 13.11 Generator tests (`packages/create-app/src/__tests__/tenancy-2b1.test.ts`)

For `--tenant-noun Company` with every feature and `--notifications
--storage`, for `none` with the same, and for Company with each of
notifications and storage alone:

- **Rule 1:** the existing no-feature-conditional check covers every new file;
  the three slot variants are chosen by the generator.
- **No fixed tenant in a companies project** (2a D12, plus `ALERTS_TENANT`,
  `FILES_TENANT`).
- **Retired:** no `routers/notifications.ts`, `routers/files.ts`,
  `notify.ts`, `blob-store.ts`, `notifyStaff`, `getBlobStore`, `storeFile(`
  or `access: "public"` outside the logo store; no `ROUTER_SCOPES` rows for
  them.
- **Producers:** with notifications, every installed 2a feature's events reach
  `alerts.notify` (the listener is in `LISTENERS`, first), comms senders carry
  `onFailed`, `company-setup.ts` calls `alertOnTenancyEvent`.
- **One email per lead:** with notifications and comms, the scheduling and
  estimator listeners are given `officeRecipients` and `officeSent` (and
  `staffEmails` stays, commented as the fallback for a throw only); the admin
  builders get `alertsHref`.
- **Named tables (review G1):** `alerts.ts` passes `tables:
  notificationTables` and `files.ts` passes `tables: storageTables`.
- **Team allowance (review BO-10):** `TEAM_TEMPLATE_KEYS` lists exactly the
  installed packages' office templates plus `team_alert`.
- **Dev disk (review BO-08):** `files.ts` builds `createLocalDiskStore` under
  the environment check only; the emitted `.gitignore` has `.data/`.
- **Links (review G2):** `files.ts` passes `stillValid` with the signing
  secret; the secret falls back to the Clerk-derived key.
- **Registry and records:** the emitted `ALERT_REGISTRY` and `records` list
  exactly the installed features; every permission they name is declared.
- **Overlays:** 13.1's table per configuration; the collision check passes for
  every configuration in `configurations.ts`.
- **Routes ↔ pages:** every alerts and files page's `baseUrl` names a route
  directory that exists.
- **Imports:** `alerts.ts` and `files.ts` don't import `company-routes`;
  `files.ts` doesn't import `tenancy`.
- **Versions and peers:** `versions.test.ts` and `peer-dependencies.test.ts`
  pass with the new pins.

---

## 14. The emitted proofs (the unit project; PGlite)

All run on every `pnpm test` with nothing configured (Tenancy 1 D20), mock
`@/db` with `createAppPglite()` as 2a's do, and build A and B through tenancy
the same way (owners Ada and Ben; "Alpha Lawn Care" and "Bravo Roofing"; A2 a
member of A). Each is generated per installed feature.

### 14.1 `feature-isolation.test.ts` grows two suites (companies)

`suitesFor` (feature-proofs-emit.ts) gains:

```ts
{ feature: "notifications", glue: "@/server/alerts-routes", adminBuilder: "buildAlertsHandlers", adminRoutes: "NOTIFICATIONS_ADMIN_ROUTES",
  adminSegment: "alerts", publicBuilder: null, publicRoutes: null, publicSegment: null, pkg: "notifications", permissions: "notificationsPermissions" },
{ feature: "storage", glue: "@/server/files-routes", adminBuilder: "buildFilesHandlers", adminRoutes: "STORAGE_ADMIN_ROUTES",
  adminSegment: "files", publicBuilder: "buildFileLinkHandlers", publicRoutes: "STORAGE_PUBLIC_ROUTES", publicSegment: null /* fixed base /api/files/ */,
  pkg: "storage", permissions: "storagePermissions" },
```

and `FEATURE_ENTITIES` gains `notifications: ["alert", "person"]`,
`storage: ["file", "file-token", "public-key", "record-type", "record"]`.

**Planting** (`src/test/company-rows.ts`, per feature, for A and for B):
- notifications: one alert for the owner through `alerts.notify` with the
  registry's first kind and `dedupeKey: "proof:{label}"` → `rows.alert`; the
  member's id → `rows.person`; AND (review BO-18, so the choices and routing
  snapshots hold rows of A and "fails if any checked table has no row of A"
  holds) `alerts.setChoice({ tenantId, userId: owner, kind: the registry's
  first kind, channel: "in_app" })` and, when the registry has a routing,
  `alerts.setRouting({ tenantId, routing: the first routing, mode: "chosen",
  userIds: [member], extraEmails: ["office@{label}.test"], by: owner })`.
  A's extra address is pushed onto `fx.aStrings`, so B's `routing` answer is
  checked never to contain it.
- storage: the proof builds its own instance, `createFilesStorage({ private:
  createMemoryBlobStore({ access: "private" }), public:
  createMemoryBlobStore({ access: "public" }) }, { signingSecret:
  "proof-signing-secret-of-thirty-two-plus" })` (the project's real
  `stillValid` over the test's tenancy), and every storage route in the proof
  is built with `buildFilesHandlers({ principal, storage })`. It plants a
  `library` file → `rows.file`; `signedLink` for it, made by A's owner →
  `rows["file-token"]`; the logo through `logoStore()` → `rows["public-key"]`;
  with a record type installed, an attachment on the company's first record of
  the first type (a visit whose crew has nobody linked, an estimate or an
  invoice from the 2a planting) → `rows["record-type"]`, `rows.record`. EVERY
  PRIVATE object key it stored is pushed onto `fx.aStrings` (for A), so
  "nothing of A" also means "no private key of A's"; A's PUBLIC logo address
  (and its key) is pushed onto the list checked against B's answers only
  (`fx.aStringsForB`), since A's own Files list rightly shows it (review G8).
  The snapshot of A's rows gains the alerts, choices, routing and file tables.

**Expectations** (2a 12.1, unchanged, over the new rows), plus:
- The two multipart rows (`upload`, `attach`) are sent as `multipart/form-data`
  with a 1×1 PNG in `file`.
- **The role pass covers the "row decides" storage rows (reviews G14,
  BO-18).** For each row with `permission: null`, the expected answer per
  role is worked out from the row's `access` (3.1), the planted file (the
  library file for `scope: "file"`, the attachment's record for `scope:
  "record"`), the record type's `view` / `manage` / `assigned` lists and
  `files.view` / `files.manage`, and each role's DEFAULTS in the catalog the
  project uses (computed by the generator, emitted as a table with a comment
  saying how each cell was derived). At minimum, and asserted by name:
  - viewer → `file-remove` (library file) 404, `attach` 404;
  - member → `file-remove` (library file) 404;
  - crew (not assigned to the planted record) → `file-get`, `file-content`
    and `file-link` of the library file 404, `attachments` and `attach` on
    the record 404; and crew → `files` and `upload` refused as for any route
    they don't hold;
  - every role whose defaults hold none of the record type's `view` /
    `manage` lists nor `files.manage` → `file-content` of the attachment 404.
  The answers come from the real authorizer over the test's tenancy.
- **The public storage suite** at `/api/files/`, anonymous:
  - `link` with A's token → 200;
  - with A's token re-signed for B's company id (a tampered payload, the MAC
    kept) → 404;
  - with a token CORRECTLY signed with the proof's secret for {t: B, f: A's
    file, u: B's owner} → 404 (the (company, file) lookup, not only the MAC;
    reviews G2, G14);
  - with a token for a REMOVED file → 404; an expired one (the clock moved
    past it) → 404;
  - A2 (A's member) makes a link to the library file, A2 is removed
    (`removeMember`) → that link 404; A suspended → A's owner's link 404,
    and reactivated → 200 again (review G2);
  - `public` with A's logo's random part → 200; with the random part of A's
    PRIVATE file's key → 404 (a private file is never public, whatever is
    asked);
  - no body or header, A's own included, carries a PRIVATE object key of A's
    (review G8; the package never redirects, so there is no `Location` to
    exempt).
- **Negative control** (in the same file): `expectIsolated` rejects a stub
  storage handler that answers B's `file-content` request with A's bytes, and
  a stub alerts handler that answers B's `list` with A's alert.

### 14.2 `src/server/__tests__/company-alerts.test.ts` (companies, with notifications)

Through the project's own glue (`alerts`, the listeners, the cron route), with
`buildCommsSenders(capture)` when comms is installed:

1. **A lead is A's** (with the estimator): a `lead.received` for A reaches A's
   owner's alerts and nobody in B; with comms, exactly ONE
   `estimate_lead_staff` email reaches A's owner (From "Alpha Lawn Care") and
   no `team_alert`. **With a business email** set in A's company settings
   (`contactEmail: office@alpha.test`), the next lead's `estimate_lead_staff`
   goes to `office@alpha.test`, once, and not to the owner's sign-in address
   (review BO-01).
2. **Twice is once:** the same event handed to `onEstimatorEvent` again → no
   second alert, no second office email (the claim).
3. **The crew** (with scheduling): A has two crews, one linked to A2 (given
   the Crew role); a customer moves a visit on A2's crew to TODAY → A2 has the
   alert (its href the crew-day page); with comms, A2's email is a
   `team_alert` whose link is the crew page, there is NO `visit_staff_notice`
   to A2, and A's owner still gets exactly one `visit_staff_notice` (review
   BO-03); a move to another day → A2's alert opens the visit's files page
   (with storage) or nothing (review BO-04); a move on the other crew → A2
   has nothing.
4. **Choices:** the owner switches "A customer moves a visit" to "In the app";
   the next move emails nobody and still alerts in the app.
5. **Routing:** the owner chooses A2 for "visits"; the next request alerts A2,
   not the owner; A2 removed (`removeMember`) → the next request alerts the
   owner again (never nobody), A2's alerts in A are gone, and A2's `count` call
   answers 403.
6. **Suspended:** A suspended → a request event for A writes nothing.
7. **The cron** (with scheduling or invoicing): a request expiring tomorrow and
   an overdue invoice → one alert each; the cron again → none more; an alert
   email that failed in the request (`capture` failing once) goes on the cron
   run.
8. **An email didn't go** (with comms): a customer `sendNow` that fails →
   one `comms.message.failed` alert for the owner, never emailed; a failing
   `team_alert` → no alert (no loop).
9. **Demoted** (review G4): A2, made an admin and chosen for "estimates",
   has lead alerts; A2 is changed to Crew (`changeMemberRole`) → A2's `list`
   holds only visit alerts reached through assignment, the count matches the
   list, and A2 is off the "estimates" routing list.
10. **A failed office email is retried once** (with comms and the estimator;
    review BO-02): the lead's office email fails once (the capture failing,
    retryable) → the alerts cron delivers exactly one `team_alert` to the
    owner for it; a second cron run sends none.
11. **Team mail doesn't hold customer mail** (with comms; review BO-10): 25
    team alerts to A's people in one hour, then a customer's `quote_sent` (or
    `visit_confirmed`) for A → it is sent, not held; the team bucket holds the
    61st team email in the hour.
12. **Removed while waiting** (review G3): an alert email left `pending` for
    A2 (the capture failing, retryable), then A2 is removed with the `forget`
    listener NOT run (a direct `removeMember` with the alerts listener
    stubbed out) → the cron sends nothing to A2 and the row ends `skipped`.
13. **Switched off in Messages** (with comms and the estimator; review
    BO-11): A's owner switches `estimate_lead_staff` off → A's owner's
    `preferences` show `emailOffInMessages` on "Someone asks for an
    estimate" with the Messages link, the "estimates" routing card has its
    `emailNote`, and the next lead alerts in the app and emails nobody.

### 14.3 `src/server/__tests__/company-files.test.ts` (companies, with storage)

With the in-memory stores (14.1's instance):

1. A's owner uploads through `buildFilesHandlers` → 201; its `content` as A →
   200 with the bytes and the nosniff and CSP headers; as B (with A's company
   in the path) → 403; as B under B's company with A's file id → 404.
2. A PNG renamed `.pdf` is kept as a PNG (the bytes decide); an SVG → 415.
3. The allowance: `FILES_ALLOWANCE_MB` stubbed to 1 → a 600 KB file then a 500
   KB file: the second → 409 `storage_full` with the owner's sentence, and the
   same refusal to A's member reads "Alpha Lawn Care's storage is full, so
   this wasn't added. Ask the owner to make room." (review BO-07); the logo
   still uploads (exempt); with the estimator, at full a customer's estimate
   photo still stores (exempt; review BO-06) while a staff `library` upload is
   refused; with notifications, the refusal writes one
   `storage.files.full` alert for A's owner, and a second refusal the same
   day writes none.
3b. The share (with the estimator; review G6): with a 1 MB allowance,
   customers' public photos stop at 20 % with the estimator's
   `PHOTO_CAP_MESSAGE` (the estimator's own `photo_limit` answer, a 4xx,
   never 500)
   while a staff `library` upload still succeeds.
3c. Uploads per person (review BO-09): two people at 70 uploads each in one
   hour both succeed; one person's 121st in the hour → 429.
4. Remove → the object is gone from the memory store and the row from the
   list; with the store failing once, the row stays marked, and the files cron
   purges it on its next run.
5. With scheduling: A2 (Crew) attaches a photo to a visit on their own crew →
   201; to a visit on another crew → 404; lists only their own visit's files.
6. With the estimator: a customer's estimate photo is stored private (the
   public store holds nothing new), its `url` on the estimate is the content
   route, and once the lead is sent the Files list row reads "Estimate
   {number} · {customer}" (review BO-13); before it is sent it isn't listed.
7. The logo: `tenancy.setLogo` stores it public under `p/…`, the company's
   `logoUrl` is that address, and the old logo's object is deleted on a
   replace; a 2a logo (a `tenancy/logos/{A}/…` pathname in the public memory
   store) replaced through `setLogo` is deleted from the public store (review
   G11).
8. Record permissions decide (review G5, with invoicing): a role holding
   `files.view` but not `invoices.view` gets 404 on an invoice attachment's
   content and doesn't see it in `files`; `files.manage` removes an
   attachment whose invoice row was deleted (listed as "Attached to something
   that was removed") and the usage drops.

### 14.4 Changes to the earlier proofs

- `procedure-scopes.test.ts`: `ROUTER_SCOPES` loses `notifications` and
  `files`.
- `company-email.test.ts` (2a 12.3): its "office notice to A's inbox" case
  becomes "to the people Alert settings name (the owner's copy at the
  business email)" when notifications is installed (a generated variant),
  and keeps 2a's wording without it. Its allowance cases gain the team
  bucket (review BO-10).
- `scripts/verify-generated.mjs`: unchanged in shape.

---

## 15. Tests (package builders)

PGlite for every service and handler test (copy scheduling's
`src/__tests__/pglite.ts`). The race rule of Tenancy 1 section 13 applies:
serial interleavings in both orders, and lock statements asserted from the
query log. Each security claim is asserted against SQL, never a fake (IF-21).

### 15.1 notifications and notifications-widget

`packages/notifications/src/__tests__/` (PGlite):
- **Schema:** the default names snapshot (0.1's two index names kept); a
  prefix and a schema build a second, independent set in the same database;
  `notificationsSql()` equals `sql/notifications-0.2.0.sql`; the SQL with
  `{ schema: "adminigloo", prefix: "aig_" }` builds tables the package's whole
  service suite then runs against (a host that has its OWN table named
  `notifications` in `public` keeps it untouched: created first, asserted
  unchanged); 0.1's rows upgrade with `upgrade-0.1-to-0.2.sql` and 0.1's
  suite passes on 0.2.
- **A host's own `notifications` table (review G1):** create a host
  `public.notifications(id text, user_id text, read_at timestamptz,
  created_at timestamptz)` with rows; then (a) running `notificationsSql()`
  (default names) raises the guard's sentence, and so does
  `upgrade-0.1-to-0.2.sql`; (b) an instance built with `tables:
  notificationTables` over that database throws from `cleanup`, `forget`,
  `prune`, `markAllRead` and `deliverPendingEmails`; (c) the host's rows are
  unchanged (compared before and after). A type test: `createNotifications`
  without `tables` doesn't compile (`// @ts-expect-error`).
- **Registry:** each refusal of 4.2; ordering; duplicates across fragments;
  `permissions` lists every distinct permission.
- **Audience (4.4):** permission filter; routing default = the owner, chosen
  people, extra addresses (deduplicated against people, the business email
  included); a chosen list with no person left but an address → the owner in
  the app AND the address by email (review BO-20); `people()` with no owner →
  everyone permitted, reported once (`no-owner`; review G13); `ownerEmail`
  answering an address → the owner's copy goes there, a throw → the owner's
  own address and a report (review BO-01); assigned crew only for listed
  people holding the assigned permission, `reached_via: assigned`; the actor
  excluded; a suspended company (people → []) writes nothing; a kind in
  `offKinds` gets no email copy (review BO-11).
- **Drafts:** a `title` with `\n`, `\r`, U+2028 or U+2029 is refused; `href`
  `/\evil.com`, `/\t/evil.com`, `//evil.com`, `/a b` refused, `/app/x?y=1`
  kept (review G15, G12).
- **Dedupe:** the same draft twice (sequentially and in one call) → one row
  per person; `duplicates` counted; email only for inserted rows.
- **Email:** sent / skipped / failed retryable / failed permanent / throw /
  timeout, each to its row state; `breakLinks` applied; the idempotency key is
  `alert:{id}`; `addressOnly` set for `email:` rows; `deliverPendingEmails`
  with `emailIdempotent: true` reclaims a stale `sending`, and with it false
  ends it `failed` with its sentence and never sends it (review G12); expires
  an old `pending`, retries with backoff, gives up after `maxAttempts`,
  honours `tenantIds` (an empty list claims nothing) and the time budget; two
  runs at once claim each row once (the attempt guard); **companies take
  turns** (A has 600 due rows, B has 1, `limit: 10` → B's row is sent in the
  first run; review BO-14).
- **Re-checked before a retry (review G3):** (a) a `pending` row, then the
  member is removed WITHOUT `forget`, then the cron runs → `skipped`, nothing
  sent; (b) the member's role no longer holds the kind's permission →
  `skipped`; (c) the extra address taken off its group → `skipped`; (d) the
  member's address changed → sent to the new one, `email_to` updated.
- **Claims (D6):** a producer kind writes `owed` rows for the office and
  `pending` for assigned-only people, who get a `team_alert` with the
  `assignedHref` (review BO-03); `claimEmails` returns the owed addresses once
  and `[]` the second time; a person on "In the app" is not returned; with no
  rows at all it falls back (assigned-only people left out) and reports; a
  notifications-sent kind is refused; a database failure throws
  `AlertsUnavailableError` after reporting (review BO-02). `releaseClaim`
  turns one claimed row back to due, the cron sends it once as a team alert,
  a second release of the same row moves nothing, and a non-producer kind is
  never touched.
- **Reads (D2, review G4):** company AND person in every WHERE: B's id, or
  A's other member's alert id, marks nothing (`not_found`); `already` for a
  second mark; a reader without the kind's permission neither sees, counts
  nor marks its rows; a row reached through assignment needs the assigned
  permission; the count and the list agree when a kind is unregistered or
  not permitted; the cursor pages; a bad cursor is an input error.
- **forget / prune / cleanup:** forget removes the person's alerts, choices
  and routing entries in THAT company only; `prune` with a Crew-shaped
  permission set deletes the person's lead and invoice rows, keeps their
  assigned visit rows and takes them off "estimates" (review G4); cleanup's
  two ages and its budget, and 0.1's rows (`dedupe_key` null) untouched.
- **`renderAlertEmail` (reviews G12, BO-17):** `<script>` in a title or body
  is escaped in `html`; a link-shaped body is broken in both; CR/LF stripped
  from `subject`; empty body and null link fold their lines away; an
  `addressOnly` message gets "You get this because {businessName} added this
  address." and no settings link; the words equal `TEAM_ALERT_EMAIL_TEMPLATE`'s.
- **Handlers:** every route with and without its permission; `authorize`
  without a person → 403; cross-site POSTs refused; the route table routes
  each row to its kind and each example reaches its lookup (2a 13.2's
  pattern); `routing-set` with a stranger's id → 400 with an issue that
  doesn't echo it; two companies through every route (B gets 404 or nothing
  of A); `hrefFor` rewrites every listed href, and one answering `//evil` is
  dropped to null and reported (review G16); `reachable` false for a member
  on no list, true for crew holding `schedule.route` (review BO-12);
  `emailOffInMessages` for a kind in `offKinds`; `routing`'s `ownerEmail` and
  `ownerEmailIsBusiness`.
- **`checkHostSeams` (review G19):** passes against the package's own
  handlers over two PGlite companies; fails, with the right line, against a
  `resolveTenant` that reads `?tenantId=`, an `authorize` that ignores the
  company, and a `people` that ignores the company.

`notifications-widget`: the transport (every route, never throws, 401 →
signed out, HTML → `bad_response`); the bell (badge 0 hidden, 7, 99, "99+";
the aria label; polling only while visible; **idle backoff** with fake timers:
after 15 minutes without input it polls every 10 minutes and one keypress
fetches at once and restores 60 s (review BO-25); a 403 hides it; the popover
on a wide viewport and the sheet under 640 px, focus trapped, Escape;
choosing an alert marks it read then navigates; `/\evil.com`,
`//evil.com` and `https://evil.com` are not followed (review G15); the
`reachable: false` empty state; the BroadcastChannel updates another
instance); the inbox (filters, day groups, load more, mark all); settings
(both radios, the disabled email with its note, the Messages link for a
switched-off kind, "Not on your list", a refused save restores, the routing
cards, the business-email line, the email checks, the "owner gets these in
the app" sentence with and without addresses); SSR of all three; AA tokens;
wire parity.

### 15.2 storage and storage-widget

`packages/storage/src/__tests__/` (PGlite, the memory store, a fake S3
server):
- **Schema:** as 15.1 (names, prefix, schema, SQL, upgrade, 0.1's suite), and
  a host's own `stored_files(id text, tenant_id text, pathname text)` with
  rows: the SQL guard raises, an instance mis-pointed at it throws from
  `remove` and `purgeDeleted`, the host's rows are unchanged (review G1);
  `createStorage` without `tables` doesn't compile; a `stores.private` with
  `access: "public"` throws `InvalidStoreError`.
- **Types:** `sniffFileType` for each type and for SVG, HTML, an EXE, an
  empty file, a JPEG declared as PDF; `imageSize` for each image type.
- **store:** each refusal with its sentence; the private key shape
  (`t/{16 hex}/…`, matching `STORAGE_KEY_PATTERN`, never the raw id) and the
  public one (`p/` + 32 characters, no tenant id, no file name); a tenantId of
  `a/../b` and one of `%2e%2e` each land under its own hashed prefix (review
  G7); PDF bytes named `x.html` are stored and served as `x.pdf` (review
  G18); bytes first, row second, bytes deleted on a failed insert; the
  allowance re-checked under the lock (two uploads interleaved in both
  orders: one wins, the loser's object deleted; the lock statement is the
  transaction's first, from the query log); an exempt purpose never refused
  for the total; a purpose with `maxShareOfAllowance` refused at its share
  (`share: true`) while another purpose still stores (review G6); `onUsage`
  told `stored` and `refused` (not for a share refusal; review BO-07).
- **Access (D12, review G5)** through the handlers: `files.view` /
  `files.manage`; a member holding `files.view` but not the record's view
  permission → 404 on the record's file and not in `files`; a record's view
  and manage; the assigned rule (assigned → view and add; not assigned →
  404; remove of their own file within 24 h → removed, after 24 h or someone
  else's → 404; review BO-21); a purpose's `view`; `files.manage` views and
  removes a file whose record type is unregistered, and one whose record
  `find` no longer returns, listed as "Attached to something that was
  removed"; 404 everywhere a stranger or another company asks; a `Response`
  from `authorize` returned as it is; `storage_full` worded per caller.
- **Uploads (review G10):** a chunked 10 MB body with no `Content-Length` →
  413, with no more than the cap read (the counting stream's high-water
  mark asserted); a declared `Content-Length` over the cap → 413 unread; two
  file parts → 400; a part not named `file` → 400.
- **Serving:** the content headers (images `private, max-age=300`, documents
  `private, no-cache`); a matching `If-None-Match` → 304 WITHOUT a store read
  (the memory store's `get` count; review BO-19); never a 302; a missing
  object → 404 and reported.
- **Links (review G2):** sign, resolve, expire, tamper (payload and MAC), a
  removed file, another company; a token correctly signed for {t: B, f: A's
  file} → null; `stillValid` false (the maker removed, the company
  suspended) → null; a `ttlSeconds` over 3600 refused at construction; no
  `signing` → `storage_off`.
- **Public route:** serves only public rows; a private file's random part →
  404.
- **Remove and purge (D13, review G11):** the object goes; a failing store
  leaves a marked row; the purge retries and gives up after ten, reporting the
  key; a 0.1-style PUBLIC `estimator.photo` row (legacy key in the public
  memory store) deleted through `purposeStore("estimator.photo").delete` →
  the public object is gone; `moveToPrivate` moves it (same id, private key,
  public object deleted, content route still serves it) and a failing copy
  leaves the row as it was; `logoStore().delete` of a `tenancy/logos/{A}/…`
  pathname deletes it from the public store, of `tenancy/logos/{B}/…` with
  A's context deletes nothing.
- **Keys (review G7):** every adapter (memory, local, s3 against the fake
  server, vercel-blob against the fake SDK) refuses `t/../x.png`,
  `t/abc/%2e%2e/x.png`, an absolute path and a backslash before any I/O; the
  legacy shapes are accepted by `get` and `delete` only.
- **Adapters:** Vercel Blob with a fake SDK (put options, private get, public
  head+fetch, not-found → null, del; a private store whose put answers a
  `.public.blob.vercel-storage.com` URL deletes it and throws `storage_off`;
  review G9); S3 (BOTH AWS vectors, review BO-16; put/get/delete round trip
  against the fake server, which checks header shape and path encoding only;
  404 → null; a missing-object delete resolves; `checkPrivate` against a fake
  server answering an unsigned GET 200 → not ok, 403 → ok); local disk (round
  trip in a temp dir; `../` and absolute keys refused before any disk access).
- **logoStore / purposeStore:** 6.9's shapes; a logo `put` without a company
  throws; `purposeStore(…).attach` sets the record.
- **Handlers:** route table (every row routes; examples reach lookups,
  including the two multipart rows; every null-permission private row has
  `access`, 3.1); two companies through every route; no response body or
  header contains a PRIVATE key (asserted over the whole suite's responses);
  `files` with `record=`, `record=none` and `sort=size`; `recordTypes` lists
  only types the reader can see.
- **`checkHostSeams` (review G19):** passes over the package's own handlers;
  fails, with the right line, against a `resolveTenant` that reads the query
  and against a lookup that ignores the company.
- **Alert kinds (6.15):** `storageUsageAlert` at 89 % → null, 90 % → the
  almost-full draft with this month's key, a refusal → the full draft with
  today's key; the fragment passes 4.2's rules (copied as a structural check).

`storage-widget`: the transport (multipart, progress via XHR, never throws,
`record`/`sort` queries); `shrinkPhoto` decisions with an injected encoder (big
→ shrunk to 2048 JPEG; small → untouched; a small HEIC the browser can decode
→ JPEG; a PDF → untouched; an unreadable photo → sent as it is);
`<RecordFiles>` (thumbnails, documents, a HEIC as a document row, the phone's
two buttons, a per-file refusal leaves the others going and keeps its card
with "Try again" (which succeeds on the next answer) and a "Save to phone"
link with `download`, the network failure retried once by itself after 3 s,
`beforeunload` set while a file is pending or failed and cleared after
(review BO-05), `hint`, remove confirm, copy link, off state, 404 state);
`<FilesManager>` (usage, the record-type filters and "Not attached", "Largest
first", table and cards, the not-removable hint, empty state); `<UsageMeter>`
(each sentence, `platformName` in the full one; `role="meter"`); SSR; AA;
wire parity.

### 15.3 scheduling, estimator and their widgets

- **scheduling** (`src/__tests__/alerts.test.ts`, `files.test.ts`): the mapper
  writes exactly where `staffNoticeKind` does (a table-driven test over every
  event type and actor); titles in the visit's zone; the crew's people on a
  move (old and new crew); dedupe keys per the table; `assignedHref` for a
  move to today (crew day), to another day (the visit files pattern), with no
  `visitFiles` (null), and a cancel of today's and of another day's visit;
  the move body states both times in full (review BO-04);
  `listExpiringRequests` window edges (just inside, just outside, already
  past, not pending) and `createdBefore` (a request made 5 h ago is left out,
  7 h ago is in; review BO-15); `officeRecipients` replaces the saved list,
  `[]` sends nothing, a throw is reported and falls back to `staffEmails`,
  each office email goes through `deliverNow` and `officeSent` hears `sent`,
  `failed` + retryable and `failed` permanent per address, a timed-out send
  is not handed to `officeSent` and is reported (review BO-02), and the
  notice's `kind` and `dedupeKey` equal the mapper's for the same event;
  without `officeRecipients`, 2a's `sendNow` path exactly; `alertsHref` reports
  `alertRecipients` and drops `staffNotifyEmails`; `schedulingFileRecords`
  finds only the tenant's visits, labels and assigned people; the fragment
  passes `defineAlertKinds` (a structural test, no notifications import: the
  rules of 4.2 copied as a check).
- **scheduling-widget**: 9.8's tests; parity of the admin wire copy.
- **estimator**: the mapper per event and actor (staff-made changes alert
  nobody); `{range}` formatting; `officeRecipients`, `officeSent` and
  `alertsHref` as scheduling's; `estimatorFileRecords` (with `pluralLabel`);
  `estimatorPhotoPurpose` is a valid storage purpose (structural: exempt,
  share 0.2, hidden until attached); a store whose `put` throws `{ name:
  "StorageError", code }` for each code gives the mapped
  `EstimatorInputError` from the public `photo` route (4xx, never 500), from
  `attachStaffPhoto`, and from the AI reading (which keeps going, unreported
  for `photo_limit`), and the lead still submits without the photo (review
  G6); `attach` is called with `{ type: "estimator.estimate", id }` after a
  lead with photos commits and after a staff photo, a throwing `attach` is
  reported and changes nothing (review BO-13).
- **estimator-widget**: 10.7's tests.

### 15.4 tenancy, invoicing, comms and their widgets

- **tenancy** (`src/__tests__/tenancy-2b1.test.ts`): every event has an `id`
  and `occurredAt`; member events carry the person; `settleEvents` waits for a
  slow listener (bounded) and never throws; the handlers' POSTs answer only
  after their events settled (a listener's write is visible right after the
  response); `listMemberPeople({ holding })` with grants, an allow override
  and a deny override, in the same three queries for 2 and for 20 members (query log);
  `setLogo` and `removeLogo` pass `tenantId`; the alert mapper's table.
- **tenancy-widget**: the rewritten release test.
- **invoicing**: `invoice.viewed` once (a second view, a preview, a draft: no
  event); `invoice.paid` only on the payment that settles it (a partial, a
  duplicate reference: no event; a reversal and a new full payment: a new
  event); events after commit and contained; `listOverdueInvoices` (open
  statuses only, the tenant, the order; `dueSince` edges: due 7 days ago in
  the zone is in, 8 days ago is out; review BO-15); the mappers' table and
  money words; `invoicingFileRecords` (with `pluralLabel`).
- **comms**: `onFailed` for a failed `sendNow`, for a queued row given up
  (permanent, out of attempts, abandoned), never for a retry or a skip, a
  throwing `onFailed` changes nothing; `deliverNow`'s `retryable` per failure
  kind; `templateLabel`; `commsFailureAlert` returns null for a template not in
  the customer set, and its title reads "The visit reminder email to … didn't
  go" (review BO-26).
- **invoicing-widget, comms-widget**: the peer ranges; comms-widget's
  `team_alert` label and group.

### 15.5 create-app

- 13.11's generator tests.
- `node scripts/verify-generated.mjs` for:
  - `--tenant-noun Company --admin full --estimator --scheduling --invoicing --comms --email --storage --notifications --ai`;
  - `--tenant-noun none --admin minimal --estimator --scheduling --invoicing --comms --email --storage --notifications`.

  Report each project's unit-test count, including section 14's files. If the
  full run can't finish (registry or network), generate both and run
  `tsc --noEmit` plus `vitest run --project=unit` in each against the
  workspace tarballs, and say which.

---

## 16. The browser scenario (create-app builder)

**Fixture: `e2e/fixtures/tenancy-2b1-scenario-server.ts`**, on
`tenancy-2a-scenario-server.ts`'s pattern (reuse its pieces; don't edit the 2a
fixture):

- **A real backend** from the BUILT packages (`dist`): PGlite with the 2a
  tables plus notifications' and storage's; the 2a companies setup; the alerts
  instance and the files instance built the way 13.5 builds them, over
  `createMemoryBlobStore` (private) and `createMemoryBlobStore({ access:
  "public", publicBaseUrl: "{origin}/__blob" })` (public), with a signing
  secret.
- **Email:** comms senders over the capturing transport; `GET /__test/outbox`
  as 2a's (`to`, `fromName`, `replyTo`, `subject`, `text`, `templateKey`).
- **Blobs:** `GET /__test/blobs` → `{ key, access, size }[]` (the fixture's
  view of both memory stores; never served to the pages); `GET /__blob/{key}`
  serves the PUBLIC store only (as a public CDN would).
- **Clock and crons:** 2a's `POST /__test/clock` and `POST
  /__test/cron/{alerts|files|scheduling|…}`.
- **Events twice:** `POST /__test/replay-last-event` hands the last scheduling
  or estimator event to the listeners again (a retried delivery).
- **Pages:** 2a's, plus `/app/alerts`, `/app/alerts/settings`, `/app/files`,
  `/app/schedule/visits/:id/files`, the bell in every company page's header,
  and `RecordFiles` under the estimate and invoice editors.
- `e2e/bundle.mjs` gains `notifications-widget` (`NotificationsWidget`) and
  `storage-widget` (`StorageWidget`).

**Spec: `e2e/tests/tenancy-2b1-scenario.spec.ts`** (one `test.describe.serial`;
an axe check on every screen it lands on):

1. **Alerts.** Green Acres (Gail, owner; Mia, member; Cam, crew on crew
   "North"; business email `office@greenacres.test` in company settings) and
   Summit Lawn (Sam) set up as in 2a. A signed-out customer asks Green Acres
   for an estimate: Gail's bell shows 1, the alert reads "New estimate
   request: …" and opens the estimate; Sam's bell shows nothing. The outbox
   has ONE `estimate_lead_staff`, to `office@greenacres.test` (the business
   email; review BO-01), From "Green Acres", and Alert settings' "estimates"
   card says "Emails go to office@greenacres.test, the business email in
   company settings." The customer requests a visit for today and later moves
   it (it is on North, still today): Gail gets "New visit request" and "…
   moved their visit …"; Cam's bell has only the move, opening Today's route,
   and Cam's email is a `team_alert` (no `visit_staff_notice` to Cam; review
   BO-03); Mia has nothing (not on the visits list) and her bell's empty
   state says she isn't on any alert lists yet (review BO-12).
   `/__test/replay-last-event` → no new alert, no new email. Opening the
   estimate alert in one tab updates the badge in a second tab of the same
   page without a reload.
2. **Choices.** Gail sets "A customer moves a visit" to "In the app"; the next
   move emails nobody. Gail opens "Who hears about new work", ticks Mia for
   visits and adds `dispatch@greenacres.test`; the next request alerts Mia
   (not Gail) and the outbox has the office notice to Mia and to the dispatch
   address, once each. Gail switches Mia back to the owner.
3. **Housekeeping.** Gail uploads a company file on `/app/files`; Mia
   (holding `files.view`) opens it and copies a link to it. Gail removes Mia; Mia's next request to
   `/api/app/{Green Acres id}/alerts/v1/admin/count` → 403, and her copied
   link now shows "This link has expired, or the file was removed." (review
   G2). Summit is suspended
   (by Ava, in `/admin/companies`); a customer's request to Summit's page is
   refused (2a), and nothing is written for Summit. The clock moves 31 days and
   the alerts cron runs: Gail's read alerts are gone, her unread stay. At 390 px
   the bell's count matches the server's and its sheet opens without sideways
   scroll; at 1280 px the popover.
4. **Files.** Gail uploads the logo in company settings (a file): the public
   page shows it from `/__blob/p/…`, and `/__test/blobs` shows it `public`.
   Cam, at 390 px, opens Today's route, taps "Photos" on his stop and adds a
   photo (the "Take a photo" input fed a file); it appears on the visit's files
   page for Gail. Gail attaches a PDF to the invoice and a photo to the
   estimate. The customer's estimate photo is on the estimate and `private` in
   `/__test/blobs`. `/app/files` lists all of them, says "Using … of 5 GB",
   links each to its record ("Estimate … · …" for the customer's photo; review
   BO-13), and its "Invoices" filter shows only the PDF. Cam's 390 px upload
   with the network cut once keeps its card with "Try again", which then adds
   it (review BO-05).
5. **Files are private.** Fetched anonymously: the content route of Cam's photo
   → 401/403; `/__blob/{its private key}` → 404 (not in the public store); a
   copied link opens it, and after the clock moves 61 minutes → "This link has
   expired, or the file was removed." Sam's browser asking Green Acres' files
   route with a Green Acres file id → 403, and his own company's route with
   that id → 404. Gail deletes the PDF: gone from `/__test/blobs`. Mia (removed
   earlier) gets 403 from the files route. A 5 MB PDF → "That file is too
   big…"; an SVG → "That kind of file can't be kept here…".

**Negative controls** (in the FIXTURE, never in the packages; run with
`test.fail()`):
- `?break=no-dedupe`: the fixture appends a random suffix to every draft's
  `dedupeKey`. Step 1's "replay → no new alert, no new email" must FAIL.
- `?break=no-crew-scope`: the fixture's `people()` ignores the permission. Step
  1's "Cam's bell has only the move" must FAIL.
- `?break=private-as-public`: the files instance gets, as its private store,
  the PUBLIC memory store wrapped to report `access: "private"` (so
  `createStorage`'s own access check, review G9, doesn't stop the fixture).
  Step 5's "`/__blob/{private key}` → 404" must FAIL.
- `?break=link-ignores-maker`: the fixture's `stillValid` always answers
  true. Step 3's "her copied link now shows the expired sentence" must FAIL
  (review G2).

Document all four in `e2e/README.md`, with what the scenario does NOT prove
(one connection; no real Resend; no real Vercel Blob, S3, R2 or MinIO (the S3
signer is proven only by AWS's two published vectors, review BO-16); no real
Clerk; no real phone camera).

---

## 17. Docs, changesets, and what's not included

### 17.1 READMEs

- **`packages/notifications/README.md`** (new; none today) and
  **`packages/storage/README.md`** (new), on the scheduling-widget README's
  structure: one paragraph; "What each install gets you" (a table: the
  package alone, with the widget, with create-app); Install (the registry,
  the `.npmrc` scope line, the token); "Upgrading from 0.1" (the SQL, and what
  0.1's rows become); a quick start for the template; **"In an app that isn't
  ours (Ridgeline)"**, in this order (review G19):
  1. `drizzle(pool)` on node-postgres (or `neon-serverless`); drizzle
     `neon-http` is NOT supported (no transactions; storage's allowance lock
     needs one);
  2. the tables under the `adminigloo` schema (or a prefix), passed as
     `tables` (REQUIRED: there is no default that could point at your own
     `notifications` table; review G1), and why `export *` from `./schema` is
     wrong under a prefix (the analytics README's rule);
  3. the shipped SQL into Prisma's own history: `npx prisma migrate dev
     --create-only --name adminigloo_alerts`, paste
     `notificationsSql({ schema: "adminigloo" })` (and `storageSql(…)`) into
     the new `migration.sql`, then `npx prisma migrate dev`, so every
     environment gets it and the drift check stays clean; the guard in the
     SQL refuses to run over a table of yours;
  4. the host seams with a sample over a host's own `users` and roles
     (`people()` from its own tables, `isOwner` marked for at least one
     person per company, `authorize` from its own session, integer ids
     stringified);
  5. mounting next to server actions: `app/api/alerts/[...path]/route.ts`
     exporting `GET` and `POST` from `handlers.handle` (and the same for
     files), with `runtime = "nodejs"`;
  6. notifications: the nodemailer `email` seam using `renderAlertEmail`
     (4.9, verbatim), `emailIdempotent` left false and why;
  7. storage: an R2/MinIO `createS3CompatibleStore` sample with TWO buckets
     (the private one with NO anonymous policy; MinIO's `mc anonymous set
     public` also allows listing, review G9) and `createLocalDiskStore` for
     development; the `signing.stillValid` sample over the host's own
     membership table (review G2); the strict-CSP note is not needed (files
     are always served by your own route);
  8. the cron calls (any scheduler with the bearer): `deliverPendingEmails({
     tenantIds: <your active company ids> })` (required; review G3),
     `cleanup()`, `purgeDeleted()`, `moveToPrivate(…)` only if you upgraded
     from 0.1;
  9. **"Check your install"**: a test file the host runs with its own seams,
     `checkHostSeams(…)` from `/testing` (4.12, 6.14), printing each line;
     "show the business owner a passing list".
  Then "Not included" (17.2) verbatim. "Upgrading from 0.1" says plainly that
  0.1's (and 2a's) files stay public at their old addresses until
  `moveToPrivate` moves them (review G11).
- **`packages/notifications-widget/README.md`**, **`packages/storage-widget/README.md`**
  (new): install, quick start, props, theme, the transport sketch, "Not
  included".
- Each touched 2a package's README gains an "Alerts and files (Tenancy 2b-1)"
  section: its alert kinds (the table), its mapper, `officeRecipients` /
  `alertsHref` (scheduling, estimator), its record types, its new events
  (invoicing), `onFailed` / `deliverNow` (comms), the tenancy changes; each
  with a foreign-host sample.
- create-app's README: the Quick start's command adds `--notifications`; an
  "Alerts and files" paragraph; the new "Not included".

### 17.2 Not included (Tenancy 2b-1), listed in each README that touches it and in the emitted README

- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The AI assistant per company** — Tenancy 2b-3.
- **Website analytics, SEO/AEO and book-a-call (booking) per company** —
  Tenancy 2b-4.
- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Plans, limits and billing enforcement** — the billing chunk. Each
  company's storage allowance is one setting for everyone
  (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is
  there.
- **Stripe Connect** (customers paying a company by card).
- **Custom domains.**
- **Virus scanning of uploads.** Files are checked for their type and size
  only.
- **Uploads over 4 MB, and uploads straight from the browser to storage.**
  Phone photos are made smaller before they're sent; other files over 4 MB are
  refused with a plain sentence.
- **Serving files straight from S3 or R2 by presigned link.** Every private
  file is sent through the site's own route.
- **Thumbnails.** Photos are shown at their (shrunk) size.
- **Turning a kind of alert off.** Each kind comes in the app, or in the app
  and by email; who gets the work alerts is the owner's choice.
- **Alerts from your other companies in the bell.** The bell shows the
  company you're working in.
- **A daily or weekly digest of alerts.**
- **Customers seeing files** (photos on their quote or invoice page).
- **Editing the wording of the team alert email** beyond the Messages screen
  (it is the `team_alert` message there).
- **Carrying 2a's per-feature alert address lists over.** With alerts
  installed, the people (and extra addresses) are chosen again in Alert
  settings; the old lists are no longer read.
- **Alert settings in a single-business project without an admin shell.** Its
  staff get the bell; the office emails keep 2a's lists.
- **A transactional outbox.** Alerts are written right after the change they
  report (D8); the events package (S2) brings the outbox.
- **Crew alerts when the office moves, reassigns or cancels their visit.**
  Only a customer's change alerts the crew.
- **An alert when a customer opens a quote** (invoices only).
- **A history of cron runs, and an alert when a cron fails.**
- **Alerts for the platform owner** (a new company, a company out of
  storage). A company's storage refusal is reported in `/admin/errors` once a
  day.
- **Giving one company more storage than the others.** `FILES_ALLOWANCE_MB`
  is one number until the billing chunk.
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.

### 17.3 Changeset files (write them; don't version)

| File | Package: bump | Says |
| --- | --- | --- |
| `.changeset/tenancy-2b1-notifications.md` | `@adminigloo/notifications: minor` | Alerts per company and person: the kind registry, who gets what (permission, routing groups with the owner's copies at the business email, crew), two channels, email copies with retries (the recipient checked again first), the claim for a producer's own email and its release when it fails, dedupe, reads that follow the reader's permissions now, forget, prune, cleanup, `renderAlertEmail`, handlers, permissions, wire, prefix or schema (`tables` required), guarded shipped SQL (upgrade SQL), `./testing` with `checkHostSeams`, no `@adminigloo/db`. 0.1's functions kept, deprecated |
| `.changeset/tenancy-2b1-notifications-widget.md` | `@adminigloo/notifications-widget: minor` | First release: `AlertsBell`, `AlertsInbox`, `AlertSettings` |
| `.changeset/tenancy-2b1-storage.md` | `@adminigloo/storage: minor` | Private files per company, purposes (with a share of the allowance), records (their permissions decide), allowance and usage with almost-full and full alerts, signed links checked against the person and the company on every open, keys without company ids, delete removes the object from the store it is in, moving old public files to the private store, a private-store check, logo and purpose stores, handlers, adapters (Vercel Blob, S3-compatible, local disk, memory), prefix or schema (`tables` required), guarded shipped SQL, `checkHostSeams`. `BlobStore` is a new shape (0.1's is `BlobStoreV1`); 0.1's functions kept, deprecated |
| `.changeset/tenancy-2b1-storage-widget.md` | `@adminigloo/storage-widget: minor` | First release: `RecordFiles`, `FilesManager`, `UsageMeter` |
| `.changeset/tenancy-2b1-tenancy.md` | `@adminigloo/tenancy: minor` | Event ids, times and people; events settled before a handler answers; `listMemberPeople({ holding })`; the logo store is told the company; alert kinds |
| `.changeset/tenancy-2b1-tenancy-widget.md` | `@adminigloo/tenancy-widget: patch` | Peer `^0.6.0` |
| `.changeset/tenancy-2b1-scheduling.md` | `@adminigloo/scheduling: minor` | Alert kinds and mappers, the expiring sweep, `officeRecipients` and `officeSent` (office emails through `deliverNow`), `alertsHref`, file records, comms peer `^0.4.0` |
| `.changeset/tenancy-2b1-scheduling-widget.md` | `@adminigloo/scheduling-widget: minor` | Alert list managed elsewhere, `initialVisitId`, files links |
| `.changeset/tenancy-2b1-estimator.md` | `@adminigloo/estimator: minor` | Alert kinds and mapper, `officeRecipients` and `officeSent`, `alertsHref`, file records, the photo purpose, photos attached to their estimate, a full store answered with the estimator's own photo sentences, comms peer |
| `.changeset/tenancy-2b1-estimator-widget.md` | `@adminigloo/estimator-widget: minor` | Lead-alert list managed elsewhere |
| `.changeset/tenancy-2b1-invoicing.md` | `@adminigloo/invoicing: minor` | Events (viewed, paid), the overdue sweep, alert kinds and mappers, file records, comms peer |
| `.changeset/tenancy-2b1-invoicing-widget.md` | `@adminigloo/invoicing-widget: patch` | Peer `^0.4.0` |
| `.changeset/tenancy-2b1-comms.md` | `@adminigloo/comms: minor` | `onFailed`, `deliverNow`, `templateLabel`, the failed-email alert kind |
| `.changeset/tenancy-2b1-comms-widget.md` | `@adminigloo/comms-widget: patch` | Peer `^0.4.0` |
| `.changeset/tenancy-2b1-create-app.md` | `@adminigloo/create-app: minor` | Section 13 in plain words. Removed: the notifications and files tRPC routers, `notifyStaff`, `blob-store.ts`, 0.1's upload route. Moved: `/admin/inbox` → `/admin/alerts` |

Plain words, as 2a's are. `versions.test.ts` reads the frontmatter: get the
package names exactly right.

---

## 18. Hand-off

### 18.1 Order

0. **Workspace preparation** (one person, before anyone else starts: the
   orchestrator or the alerts builder). Create `packages/notifications-widget`
   and `packages/storage-widget` at `0.0.0` on comms-widget's skeleton:
   `package.json` (React the only peer, the server package an OPTIONAL peer
   `^0.2.0`, devDependencies `happy-dom`, `react`, `react-dom`, the React types
   and the server package as `workspace:^`), `tsconfig.json`, `tsup.config.ts`
   (entries `index` and `admin`, the `"use client"` banner), `src/index.ts`,
   `src/admin/index.ts`, `src/version.ts` and a smoke test. Add
   `@electric-sql/pglite ^0.5.8` and `uuidv7 ^1.2.1` to notifications and
   storage (and drop `@adminigloo/db`), with comms' `vitest.config.ts`. Then
   `pnpm install --offline` (everything is in the store). Build and test both
   new packages (1/1 each) and report.
1. **In parallel:** the alerts, files, field and platform builders. None needs
   another's code: the shapes are structural (3), and each package's tests
   supply fake seams.
   - The platform builder builds `comms` FIRST and reports "comms dist built"
     (the scheduling and estimator comms tests run against comms' `dist`), then
     tenancy, then invoicing.
   - Each builder builds its packages into `dist/` and reports.
2. **The create-app builder** starts when all four have reported `dist/`
   built. It builds against `dist/`.

### 18.2 Every builder reports

- test counts per package against section 0's baselines, and each new test
  file;
- typecheck and build status for every touched package;
- every `// CONTRACT:` call they made, and any route-table example they had to
  change;
- anything they couldn't do, and why. Don't install anything beyond step 0;
  stop and say so.

### 18.3 Checklists

**Alerts builder**
- [ ] notifications and notifications-widget: build, typecheck, test green; 0.1's suite passes on 0.2.
- [ ] The schema snapshot, the prefix/schema set, the shipped SQL (with its guard) and its suite run; the host-`notifications`-table test (G1).
- [ ] Reads filtered by the reader's permissions; prune; the retry re-check; companies taking turns; releaseClaim; renderAlertEmail; checkHostSeams.
- [ ] Wire regions byte-identical. READMEs and two changesets.

**Files builder**
- [ ] storage and storage-widget: build, typecheck, test green; 0.1's suite passes on 0.2.
- [ ] Both S3 test vectors; the four adapters, each refusing a bad key before any I/O; no PRIVATE key in any response body or header (the suite-wide check).
- [ ] Links re-checked with `stillValid`; record permissions decide (G5); the share; stores by `row.access`; moveToPrivate; the counting upload stream; checkHostSeams; storage alert kinds.
- [ ] Wire regions byte-identical. READMEs and two changesets.

**Field builder**
- [ ] scheduling, scheduling-widget, estimator, estimator-widget: build, typecheck, test green; 2a's suites untouched.
- [ ] Mappers and office notices agree on `kind` and `dedupeKey` (a test per package); office emails through `deliverNow` with `officeSent` when `officeRecipients` is given, 2a's path exactly when not.
- [ ] The estimator's StorageError mapping (never a 500) and `attach`.
- [ ] Wire copies updated in both places. READMEs and four changesets.

**Platform builder**
- [ ] comms dist reported early (18.1).
- [ ] tenancy, tenancy-widget, invoicing, invoicing-widget, comms, comms-widget: build, typecheck, test green; the tenancy-widget release test rewritten.
- [ ] `listMemberPeople({ holding })` in three queries for any team size (query log); `listOverdueInvoices`' `dueSince`. READMEs and six changesets.

**create-app builder**
- [ ] create-app tests green (count them; list each new test).
- [ ] `verify-generated` for both configurations of 15.5, with the emitted proofs' counts.
- [ ] The role pass over the "row decides" file routes, the correctly-signed cross-company token, the removed-maker and suspended-company links (14.1).
- [ ] The e2e fixture and spec written and run (Chromium is cached), with the four negative controls failing as they must.
- [ ] No fixed tenant in a companies project; nothing retired left behind (13.11).
- [ ] READMEs, emitted README, DEPLOYMENT.md, changeset.

---

## 19. Every file to create or change

**Step 0 (18.1)** — create `packages/notifications-widget/{package.json,
tsconfig.json, tsup.config.ts, src/index.ts, src/admin/index.ts,
src/version.ts, src/__tests__/smoke.test.ts}` and the same for
`packages/storage-widget`; change `packages/notifications/package.json`,
`packages/storage/package.json` (dependencies, devDependencies, `files`,
storage's entries), add `vitest.config.ts` to both; `pnpm-lock.yaml`.

**`packages/notifications`** — create `src/columns.ts` (its uuidv7 and
`createdAt`), `src/registry.ts`, `src/audience.ts` (4.4), `src/instance.ts`
(`createNotifications`), `src/email.ts` (sends, claims, retries), `src/links.ts`
(`breakLinks`), `src/template.ts` (`TEAM_ALERT_EMAIL_TEMPLATE`),
`src/legacy.ts` (0.1's functions), `src/sql.ts` (`notificationsSql`),
`src/permissions.ts`, `src/http.ts`, `src/routes.ts`, `src/handlers.ts`,
`src/wire.ts`, `src/reader.ts` (the read filter and `prune`'s kind lists,
D2), `src/render.ts` (`renderAlertEmail`), `src/testing.ts`
(`checkHostSeams`, the `./testing` entry), `sql/notifications-0.2.0.sql`,
`sql/upgrade-0.1-to-0.2.sql`, `src/__tests__/{pglite.ts, schema.test.ts,
sql.test.ts, host-table.test.ts, registry.test.ts, audience.test.ts,
notify.test.ts, email.test.ts, recheck.test.ts, claims.test.ts,
reads.test.ts, prune.test.ts, render.test.ts, handlers.test.ts,
routes.test.ts, host-seams.test.ts, legacy.test.ts}`, `README.md`; change
`src/index.ts`, `src/schema.ts`, `tsup.config.ts` and `package.json`
`exports` (the `./testing` entry); replace the 0.1 fake-db
test `src/__tests__/notifications.test.ts` with `legacy.test.ts` on PGlite
(its six cases kept).

**`packages/notifications-widget`** — fill `src/index.ts`,
`src/admin/index.ts`; create `src/types.ts`, `src/client.ts`, `src/http.ts`,
`src/theme.ts`, `src/styles.ts`, `src/ui.tsx`, `src/channel.ts`
(BroadcastChannel), `src/href.ts` (the same-origin check, D18),
`src/idle.ts` (the poll's idle backoff), `src/admin/AlertsBell.tsx`,
`src/admin/AlertsInbox.tsx`, `src/admin/AlertSettings.tsx`,
`src/admin/words.ts`,
`src/__tests__/{client.test.ts, bell.test.tsx, inbox.test.tsx,
settings.test.tsx, styles.test.ts, wire-parity.test.ts, dom.ts}`, `README.md`.

**`packages/storage`** — create `src/columns.ts`, `src/file-types.ts`
(`FILE_TYPES`, `sniffFileType`, `imageSize`, `formatBytes`),
`src/purposes.ts`, `src/records.ts`, `src/keys.ts`, `src/signing.ts`,
`src/instance.ts` (`createStorage`), `src/legacy.ts`, `src/sql.ts`,
`src/permissions.ts`, `src/http.ts`, `src/routes.ts`, `src/handlers.ts`,
`src/link-handlers.ts`, `src/wire.ts`, `src/body.ts` (the byte-counting
multipart reader, G10), `src/move.ts` (`moveToPrivate`), `src/alerts.ts`
(`storageAlertKinds`, `storageUsageAlert`), `src/host-seams.ts`
(`checkHostSeams`, re-exported by `./testing`), `src/vercel-blob.ts`,
`src/sigv4.ts`, `src/s3.ts`, `src/local.ts`, `src/testing.ts`,
`sql/storage-0.2.0.sql`, `sql/upgrade-0.1-to-0.2.sql`,
`src/__tests__/{pglite.ts, fake-s3.ts, schema.test.ts, sql.test.ts,
host-table.test.ts, file-types.test.ts, keys.test.ts, store.test.ts,
access.test.ts, uploads.test.ts, serving.test.ts, links.test.ts,
purge.test.ts, move.test.ts, adapters.test.ts, handlers.test.ts,
routes.test.ts, host-seams.test.ts, alerts.test.ts, legacy.test.ts}`,
`README.md`; change `src/index.ts`, `src/schema.ts`, `tsup.config.ts` (the
four new entries); replace `src/__tests__/storage.test.ts` with
`legacy.test.ts` (its eleven cases kept).

**`packages/storage-widget`** — fill the entries; create `src/types.ts`,
`src/client.ts`, `src/http.ts`, `src/theme.ts`, `src/styles.ts`, `src/ui.tsx`,
`src/shrink.ts`, `src/admin/RecordFiles.tsx`, `src/admin/FilesManager.tsx`,
`src/admin/UsageMeter.tsx`, `src/admin/Uploader.tsx`, `src/admin/words.ts`,
`src/__tests__/*`, `README.md`.

**`packages/tenancy`** — change `src/server/context.ts` (stamps, the pending
set, settle), `src/server/types.ts` (the event fields, `LogoStore`,
`settleEvents`, `listMemberPeople`'s option), `src/server/service.ts`,
`src/server/profile-read.ts` (`holding`), `src/server/profile.ts` (the logo
store's `tenantId`), `src/server/team.ts` and
`src/server/invitations-lifecycle.ts` (the person on member events),
`src/server/handlers.ts` and `src/server/operator-handlers.ts` (settle before
answering), `src/server.ts`, `src/index.ts`; create `src/events.ts` (the
`TenancyEvent` type, root-safe, re-exported by `./server`), `src/alerts.ts`
(kinds and mapper), `src/__tests__/tenancy-2b1.test.ts`; change
`src/__tests__/barrel.test.ts`, `README.md`.

**`packages/tenancy-widget`** — change `package.json` (peer),
`src/__tests__/release.test.ts`.

**`packages/scheduling`** — create `src/format.ts` (moved `formatShort` /
`formatWhen`), `src/alerts.ts` (kinds, `schedulingAlertsFor`,
`listExpiringRequests`, `schedulingExpiringAlert`, `crewUserIds`, the shared
kind-and-key function), `src/files.ts` (`schedulingFileRecords`),
`src/__tests__/{alerts.test.ts, files.test.ts}`; change `src/comms.ts`
(`officeRecipients`, `officeSent`, `deliverNow` for office emails, the
formats' import), `src/admin-handlers.ts`
(`alertsHref`), `src/settings.ts` (`toSettingsWire`'s new field),
`src/wire.ts`, `src/index.ts`, `package.json` (comms peer), `README.md`.

**`packages/scheduling-widget`** — change `src/admin/types.ts`,
`src/admin/client.ts`, `src/admin/SchedulingSettings.tsx`,
`src/admin/ScheduleCalendar.tsx`, `src/admin/VisitPanel.tsx`,
`src/admin/CrewDay.tsx`, tests, `README.md`.

**`packages/estimator`** — create `src/alerts.ts`, `src/files.ts`
(`estimatorFileRecords`, `estimatorPhotoPurpose`),
`src/__tests__/{alerts.test.ts, files.test.ts, photo-storage.test.ts}`;
change `src/comms.ts` (`officeRecipients`, `officeSent`, `deliverNow`),
`src/photos.ts` (the `attach?` seam method, `storePhoto`'s StorageError
mapping, `attachStaffPhoto` calling `attach`), `src/estimates.ts`
(`createPublicEstimate` calling `attach` after commit),
`src/admin-handlers.ts`, `src/settings.ts`, `src/wire.ts`, `src/index.ts`,
`package.json`, `README.md`.

**`packages/estimator-widget`** — change `src/admin/types.ts`,
`src/admin/client.ts`, `src/admin/EstimatorSettings.tsx`, tests, `README.md`.

**`packages/invoicing`** — create `src/events.ts`, `src/alerts.ts`
(`listOverdueInvoices`, kinds, mappers), `src/files.ts`
(`invoicingFileRecords`), `src/__tests__/{events.test.ts, alerts.test.ts,
files.test.ts}`; change `src/handlers.ts`, `src/admin-handlers.ts` (emit),
`src/index.ts`, `package.json`, `README.md`.

**`packages/invoicing-widget`** — change `package.json` (peer).

**`packages/comms`** — create `src/alerts.ts` (`templateLabel`, kind,
`commsFailureAlert`), `src/__tests__/{failures.test.ts, alerts.test.ts}`;
change `src/index.ts` (`onFailed`, `deliverNow`, the drain's outcome id),
`README.md`.

**`packages/comms-widget`** — change `package.json` (peer), a words test.

**`packages/create-app`** —
- `src/`: `versions.ts`, `answers.ts`, `emit.ts` (planEmit; vercel.json; env
  module, `.env.local`, `.env.example`, `/setup` rows; the catalog's fragments
  and staff keys; `renderAppRouter` without the two routers; comms senders'
  `onFailed` and the team allowance (`TEAM_TEMPLATE_KEYS`); single-mode
  scheduling and estimator notify variants; estimator services' photo store;
  nav and admin nav), `features-emit.ts` (companies
  notify variants; invoicing glue `onEvent`; company setup; company links),
  `tenancy-emit.ts` (`renderTenancyLogo`), a new `alerts-files-emit.ts`
  (`renderAlerts`, `renderAlertsRoutes`, `renderAlertsCron`, `renderFiles`,
  `renderFilesRoutes`, `renderAlertsBellSlot`, `renderRecordFilesSlot`,
  `renderVisitFiles`), `feature-proofs-emit.ts` (the two suites, entities,
  planting, the public storage suite, `renderCompanyAlertsTest`,
  `renderCompanyFilesTest`, the company-email variant),
  `tenancy-proofs-emit.ts` (`ROUTER_SCOPES`), `capabilities.ts`,
  `readme-emit.ts`, `add.ts`, `cli.ts` (help text);
- `overlays/`: delete `notifications/src/server/notify.ts`,
  `notifications/src/server/routers/notifications.ts`,
  `storage/app/api/files/route.ts`, `storage/src/server/blob-store.ts`,
  `storage/src/server/routers/files.ts`; rewrite
  `notifications-admin/app/admin/inbox/page.tsx`,
  `storage-admin/app/admin/files/page.tsx`; create
  `notifications-admin/app/admin/alerts/{page.tsx, settings/page.tsx}`,
  `notifications-companies/**`, `notifications-single/**`,
  `storage/app/api/files/[...path]/route.ts`, `storage/app/api/cron/files/route.ts`,
  `storage-companies/**`, `storage-visits-companies/**`, `storage-single/**`,
  `storage-visits-admin/**`; change the 2a pages of 13.3 and 13.4
  (`scheduling-companies` schedule and today, `estimator-companies`
  estimate, `invoicing-companies` invoice, `scheduling-admin` schedule and
  today, `estimator-admin` estimate, `invoicing-admin` invoice);
- `template/`: `src/components/AuthHeader.tsx`, `_gitignore` (`.data/`);
- `src/__tests__/tenancy-2b1.test.ts` (new), `configurations.ts` (a
  Company-with-everything and a none-with-everything entry including
  `--notifications --storage`), and every existing test the changes touch
  (`capabilities.test.ts`, `every-configuration.test.ts`,
  `permission-scopes.test.ts`, `emitted-tests.test.ts`, `versions.test.ts`,
  `tenancy-2a.test.ts`, `scheduling-overlay.test.ts`,
  `estimator-overlay.test.ts`, `add.test.ts`, and the comms allowance's
  test for the team bucket);
- `README.md`.

**Repo root** — `e2e/fixtures/tenancy-2b1-scenario-server.ts`,
`e2e/tests/tenancy-2b1-scenario.spec.ts`, `e2e/bundle.mjs`, `e2e/README.md`;
the fifteen changeset files of 17.3. `scripts/verify-generated.mjs` needs no
change.

---

## 20. Open questions for the founder (builders: take the default and go on)

1. **Vercel Blob: one store or two?** RESOLVED (review BO-19): two. A Vercel
   Blob store is public or private as a whole; Ask Lou's `privateBlob.ts`
   runs exactly this pair. `BLOB_PRIVATE_READ_WRITE_TOKEN` must be a
   different token from `BLOB_READ_WRITE_TOKEN` (the env check refuses the
   same one, review G9). DEPLOYMENT.md's steps are in 13.9.
2. **Each company's storage allowance.** **Default:** 5 GB
   (`FILES_ALLOWANCE_MB=5120`; review BO-07) until the billing chunk sets it
   per plan. The math: a two-crew lawn company taking 40 shrunk photos a day
   (about 0.7 MB each) uses about 28 MB a day: 1 GB in about five weeks, 5 GB
   in about six months. Founder: confirm 5 GB, or name the number you'll
   sell; customers' estimate photos may use at most a fifth of it (question
   9).
3. **No "off" for a kind of alert.** The bar names two choices. **Default:**
   two; the routing groups keep the noise down. (An owner CAN switch a kind's
   email off in Messages; Alert settings now says so, question 8.)
4. **Invoice alerts go to the owner by default** (the "invoices" group), not
   to everyone who can see invoices. **Default:** the owner (at the business
   email when one is set, review BO-01).
5. **Single-business "owner".** **Default:** every staff admin gets the routed
   alerts until someone is chosen; with no admin at all, everyone who holds
   the group's permission (review G13).
6. **The alerts cron runs once a day** on Vercel Hobby, so an alert email that
   failed in the request (and a failed office email, now retried, review
   BO-02) is retried the next day. **Default:** daily, with DEPLOYMENT.md
   saying how to run it every 15 minutes.
7. **Alert emails and sending allowances.** CHANGED (review BO-10):
   **Default:** team emails (`team_alert` and the three office notices) count
   in their own per-company team allowance, 60 an hour and 300 a day, never in
   the allowance that holds customers' quotes and invoices.
8. **A kind's email switched off in Messages.** CHANGED (review BO-11):
   **Default:** Alert settings shows "Emails for this are switched off in
   Messages (…). Turn it back on there." with a link, and no email copy is
   made for that kind while it is off.
9. **Customers' estimate photos and the allowance** (reviews G6, BO-06).
   **Default:** counted, never refused because the company is full, and
   capped at 20 % of the allowance (so strangers can't fill the room the
   crew's photos need). Founder: is a fifth right?
10. **Signed links last at most one hour** (review G2). **Default:** 1 hour,
    and a link stops working as soon as the person who made it leaves the
    company or the company is suspended.

---

## 21. Contract review (what the critics found, and what was done)

Two critics reviewed this contract against the code on `feat/tenancy-2b`: a
security and foreign-host lens (G1–G19) and a business-owner lens (BO-01 to
BO-26). Every accepted gap is written into the sections above (the sections
cite the gap); this table is the record. Where two gaps asked for the same
thing, both are accepted and the merge is named.

| Gap | Severity | Decision | Where, or why not |
| --- | --- | --- | --- |
| G1 | high | accepted | `tables` required (D14, 4.3, 6.6); package-only columns in every write (4.5, 6.6); guarded shipped SQL (4.1, 6.1); host-table tests (15.1, 15.2) |
| G2 | high | accepted | token carries maker and issue time; `stillValid` required; TTL ≤ 1 h (D10, 6.6, 6.8, 13.5); proof and e2e cases (14.1, 16 step 3, a fourth negative control). The 60 s presign part is moot (BO-24) |
| G3 | high | accepted | recipient re-checked before each retry; `tenantIds` required (D9, 4.3, 4.5, 15.1, 14.2 case 12, 17.1) |
| G4 | medium | accepted | `reached_via` column; reads filtered by the reader's permissions now; `prune` on a role change (D2, D9, 4.1, 4.3, 4.5, 4.7, 13.5, 14.2 case 9) |
| G5 | medium | accepted | `files.view` opens no record's files; `files.manage` sees and removes orphans; the list is filtered (D12, 6.7, 6.12, 14.3 case 8, 15.2) |
| G6 | medium | accepted, merged with BO-06 | `maxShareOfAllowance` (6.4, 6.6); the estimator photo is exempt AND capped at 20 %; StorageError mapped to the estimator's own sentences (10.5, 14.3 case 3b) |
| G7 | medium | accepted | hashed company prefix in private keys; every adapter refuses a bad key before I/O; S3 builds encoded paths (D10, 6.2, 6.6, 15.2) |
| G8 | medium | accepted, (b) moot by BO-24 | "no PRIVATE key in any body or header"; the public logo address checked against B only (0 bar 8, D10, D17, 14.1, 15.2). No presign, so no `presignReads` option and no `Location` exemption |
| G9 | medium | accepted | private-store check (`checkPrivate`, `checkPrivateStore`); Vercel public-URL refusal; same-token env refusal; two buckets in the READMEs; `createStorage` refuses a mismatched store; the negative control re-cut (D10, 6.2, 6.6, 13.7, 13.8, 16, 17.1, 20 Q1) |
| G10 | medium | accepted | byte-counting upload stream; exactly one `file` part (D11, 6.7, 15.2) |
| G11 | medium | accepted | stores chosen by `row.access`; 2a logo pathnames deletable; `moveToPrivate` run by the files cron; the upgrade notes say it plainly (D13, 6.1, 6.6, 6.9, 13.8, 15.2, 14.3 case 7) |
| G12 | medium | accepted, merged with BO-17 | `renderAlertEmail`; one-line titles; `emailIdempotent` (D7, D18, 3.3, 4.3, 4.5, 4.9, 15.1) |
| G13 | medium | accepted | owner fallback to everyone permitted, reported (D4, 4.3, 4.4, 15.1, 20 Q5) |
| G14 | medium | accepted, merged with BO-18 | `access` on null-permission routes; the role pass covers them; a correctly signed cross-company token (3.1, D17, 14.1, 15.2) |
| G15 | low | accepted | strict href pattern; same-origin follow in the widgets and the single-mode email link (D18, 3.3, 5, 13.5, 15.1) |
| G16 | low | accepted | `hrefFor` (may be async, so the glue can read the slug) through the switch route (4.7, 13.5) |
| G17 | low | rejected | Checking an added address needs a public confirm route, token state and its own proofs: a chunk of its own. 2a's lists had the same exposure; 2b-1 bounds it with five addresses per group and the team allowance (BO-10). Listed in 17.2 |
| G18 | low | accepted | the extension follows the sniffed type (D11, 6.6, 15.2) |
| G19 | low | accepted | `checkHostSeams` in both `./testing` entries; the README's route-handler, Prisma-migration and driver steps (D14, 4.12, 6.14, 17.1) |
| BO-01 | high | accepted | `ownerEmail` seam; the owner's routed copies at the business email; the card says so (D4, 4.3, 4.4, 4.7, 4.8, 5, 13.5, 14.2 case 1, 16 step 1) |
| BO-02 | high | accepted | `officeSent` + `deliverNow`; `releaseClaim`; a throwing `officeRecipients` (and a claim whose database fails) falls back to `staffEmails` (D6, D8, 3.4, 4.3, 4.5, 9.3, 10.2, 13.5, 14.2 case 10) |
| BO-03 | high | accepted | assigned-only people get notifications' `team_alert`, never the office notice (D6, 3.4, 4.5, 14.2 case 3, 16 step 1) |
| BO-04 | medium | accepted | `assignedHref` is the crew's day only for today, else the visit's files page; the body states both times (9.1, 13.5, 15.3) |
| BO-05 | high | accepted | failed photos keep a card with Try again and Save to phone; one automatic retry; `beforeunload` (7, 15.2, 16 step 4) |
| BO-06 | high | accepted, merged with G6 | the estimator photo is `exemptFromAllowance` (10.5, 14.3 case 3) |
| BO-07 | medium | accepted | sentence by caller; `onUsage` and storage's alert kinds; refusals to `/admin/errors` once a day; default 5 GB; `platformName` in the meter (D11, 6.6, 6.7, 6.15, 7, 13.5, 20 Q2) |
| BO-08 | medium | accepted | local-disk stores in development (an environment check); `.data/` git-ignored; the /setup warning (13.5, 13.7, 13.9) |
| BO-09 | medium | accepted | uploads per person 120/h plus a company ceiling 600/h; `rateLimit` gets `userId` (6.7, 13.5, 14.3 case 3c) |
| BO-10 | medium | accepted | team templates in their own allowance bucket (D5, 13.5, 14.2 case 11, 20 Q7) |
| BO-11 | medium | accepted | `offKinds`; the note and the Messages link (D5, D6, 4.3, 4.4, 4.7, 4.8, 5, 13.5, 14.2 case 13, 20 Q8) |
| BO-12 | medium | accepted | `viaAssigned`, `reachable`, `receives`, "Not on your list" (4.7, 4.8, 5, 16 step 1) |
| BO-13 | medium | accepted | "Other files" with a hint; `attach` on the purpose store and the estimator's seam; label "Estimate photo"; `hiddenUntilAttached`; attachments list `attachment` only (D12, 6.4, 6.6, 6.7, 6.9, 10.5, 13.3, 14.3 case 6) |
| BO-14 | medium | accepted | companies take turns in the email retry; `limit: 1000`, `stoppedEarly` reported (4.5, 13.8, 15.1) |
| BO-15 | medium | accepted | `createdBefore` (6 h) and `dueSince` (7 days) (9.2, 11.2, 15.3, 15.4) |
| BO-16 | medium | accepted | the second AWS vector (header-signed GET); the fake server never verifies with our signer (6.2, 15.2, 16) |
| BO-17 | medium | accepted, merged with G12 | `renderAlertEmail` with the email-only settings line; the README's nodemailer sample (4.3, 4.9, 17.1) |
| BO-18 | medium | accepted, merged with G14 | choices and routing planted for A and B; the role-pass table (14.1) |
| BO-19 | medium | accepted | Q1 resolved (two stores) with DEPLOYMENT.md's steps; the link key derived from `CLERK_SECRET_KEY`; "What files cost"; 304 from the row before the store; thumbnails cached five minutes (6.7, 13.5, 13.7, 13.9, 20 Q1) |
| BO-20 | low | accepted | an emptied list goes to the owner in the app while its addresses keep their emails (D4, 4.4, 5, 15.1) |
| BO-21 | low | accepted | the adder may remove within 24 h; HEIC always converted, else shown as a document (D12, 3.5, 6.7, 7, 15.2) |
| BO-22 | low | accepted | `pluralLabel`, `recordTypes`, the record and size filters; the "aren't sent to the customer" hint (3.5, 6.6, 6.7, 6.10, 7, 13.3) |
| BO-23 | low | accepted | the five "Not included" lines (17.2) |
| BO-24 | low | accepted | `removeForRecord` and every presign/302 path dropped; `presignS3Url` kept only as an exported signer; a "Not included" line (D10, 6.2, 6.6, 6.7, 6.8, 17.2) |
| BO-25 | low | accepted | idle backoff to 10 minutes after 15 idle minutes (5, 15.1) |
| BO-26 | low | accepted | "The {label in lower case} email to {to} didn't go" (12.3, 15.4) |
