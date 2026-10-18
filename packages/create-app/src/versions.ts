/**
 * What version of each base package a NEW project installs.
 *
 * Its own module because three things now read it — the generated
 * `package.json`, the generated `adminigloo.json`, and the test that checks it
 * against the workspace — and a table that three callers share should not be
 * buried halfway down the emitter.
 *
 * Hardcoded, and guarded by a test, because the obvious shortcut is wrong in a
 * way that fails silently. Every package sat at `^0.1.0`, and a caret range on
 * a 0.x version means `>=0.1.0 <0.2.0`: the moment @adminigloo/env shipped
 * 0.2.0, a freshly generated project quietly installed the OLD one. Everything
 * resolved, everything built, and the feature the release added simply was not
 * there.
 *
 * WHAT THIS MUST BE IN STEP WITH IS THE NEXT RELEASE, NOT THE LAST ONE, and
 * that correction is the whole of the second bug. The guard used to compare
 * each entry against the version currently in the workspace manifest, which is
 * the version already published — so it went green on a table that was, by
 * construction, one release behind the code the template is written against.
 * @adminigloo/observability sat at 0.1.1 here with a pending `minor` changeset
 * for `createErrorReporter`, an export `src/server/error-reporter.ts` imports
 * on every generated project. A project generated against the registry
 * therefore resolved `^0.1.1`, got a build with no such export, and failed to
 * compile — the same shape of failure the invitations router hit, and a
 * generator that emits projects which cannot build is not a generator.
 *
 * So the rule enforced by `versions.test.ts` is: THE RANGE EMITTED HERE MUST
 * ADMIT THE VERSION THIS COMMIT WILL PUBLISH — the workspace version with every
 * pending `.changeset` applied. A patch bump needs no edit, because a caret
 * already covers it, and demanding one would churn this file on every release
 * for no benefit. A minor bump on a 0.x version needs one, because the caret
 * excludes it precisely as it excluded 0.2.0 above. That distinction is the
 * mechanism: an entry here changes exactly when leaving it alone would break a
 * generated project, and never otherwise.
 *
 * A PIN THAT MOVES AHEAD OF THE REGISTRY IS DELIBERATE. Between writing the
 * changeset and running the release, `pnpm install` in a freshly generated
 * project cannot resolve the range, and CI's end-to-end `generate` job — which
 * installs the PUBLISHED packages — fails until the release lands. That is an
 * honest report rather than a regression: in that window the generator really
 * cannot produce a project that builds, and the alternative is the silence this
 * comment exists to describe. `versions.test.ts` also requires create-app to
 * carry a changeset of its own whenever a pinned package takes a minor bump, so
 * the corrected pin cannot be left sitting unpublished behind one that is.
 */
const PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  // 0.3.0 for the host-agnostic `resolveAppEnv()`. A project resolving 0.2.x
  // gets the four-line body that failed open — an unlabelled deployment read as
  // somebody's laptop — and `checkout.simulate` refuses to give the shop away
  // on precisely that answer.
  env: "0.3.0",
  db: "0.2.2",
  auth: "0.2.0",
  // 0.3.0: creating a tenant now writes its owner the owner role as a row, and
  // the emitted code calls the export that does it. Owning a tenant conferred
  // nothing before that, so a project on 0.2.x compiles and grants nobody
  // anything.
  // 0.5.0 (Tenancy 2a): the companies project's feature glue builds its routes
  // on createCompanyRouteSeams / createPublicCompanySeams, reads every company's
  // basics through companyProfile, runs the crons through runForEachCompany
  // over activeCompanyIds, composes its roles with defineTenantRoles (Crew) and
  // renders public pages through resolvePublicCompany. None exist in 0.4.x.
  // 0.6.0 (Tenancy 2b-1): every event carries an id and a time (the alerts'
  // dedupe keys), member events name the person, `listMemberPeople({ holding
  // })` is who gets an alert, the logo store is told the company (private
  // files keep logos per company), and `tenancyAlertKinds` /
  // `tenancyAlertsFor` are the team alerts. The emitted alerts glue calls
  // all of them; none exist in 0.5.x.
  tenancy: "0.7.0",
  permissions: "0.2.0",
  // 0.2.0 rather than 0.1.x because `requireTenant(...).input(...)` did not
  // compile before it. `^0.1.0` would resolve to a build a generated project
  // cannot typecheck against.
  trpc: "0.3.0",
  // The same, and the one that was actually broken: `createErrorReporter` ships
  // in 0.2.0 and `src/server/error-reporter.ts` imports it unconditionally, so
  // a project resolving 0.1.x fails to compile on a file every project gets.
  observability: "0.2.1",
  // 0.2.0 for the subscription mirror. The generated webhook route imports
  // `subscriptionSnapshot`, `subscriptionIdFromInvoice` and
  // `SUBSCRIPTION_EVENT_TYPES`, and the billing router imports
  // `ensurePlanPrice`; none of the four exist in 0.1.x, so a project resolving
  // a caret over the old line fails to compile on files the generator wrote.
  // The two that read a Stripe subscription would be the worse failure if a
  // caret somehow admitted them: the period moved onto the subscription ITEM
  // two API versions ago, and code reading the old field mirrors every
  // subscription with no period at all.
  // 0.4.0 (getting paid, part 1): Connect for companies — the emitted
  // payments glue and the Connect webhook call startConnectOnboarding,
  // companyForConnectEvent, runLedgeredEvent and createDirectCheckoutSession,
  // and the schema has stripe_connected_accounts. None exist in 0.3.x.
  // 0.4.1 (getting paid, part 2): createDirectCheckoutSession's `lines` — the
  // store's server-priced lines on Stripe's page. Not in 0.4.0.
  stripe: "0.4.1",
  // 0.2.0 for the variant- and product-name rules. The product builder refuses
  // to start a save that `validateProduct` cannot clear, so a project resolving
  // 0.1.x gets a validator with no opinion about a blank variant name — which
  // is the hole the form used to fall through: it created the product, had
  // `upsertVariant` refuse it, and left a draft with nothing under it.
  // 0.3.0 (getting paid, part 2): product_variants.held — the stock open store
  // checkouts hold, apart from what is on the shelf. The store reads it.
  catalog: "0.3.0",
  // 0.2.0 (getting paid, part 2): a store of its own — the emitted store
  // glue imports @adminigloo/commerce/store and /widget, the route tables and
  // storePermissions, and the schema has store_checkouts and store_alerts.
  // None exist in 0.1.x.
  commerce: "0.2.0",
  // 0.2.0 for the typed plan record. `src/plans.ts` is emitted into every
  // project that sells something and calls `definePlans`, which does not exist
  // in 0.1.x — so a project resolving the old line fails to compile on a file
  // the generator wrote. The same release changed `grantsForPlan` and
  // `planGrantDiff` to take a `PlanTier`, and a caret over 0.1.x would resolve
  // to the signatures nothing here calls.
  billing: "0.3.0",
  // 0.2.0 (Tenancy 2b-3): the ledger moved into the package — the emitted
  // src/server/ai.ts and src/server/assistant.ts import recordAiUsage,
  // aiSpendSince and checkAiAllowance from ./server, which 0.1.x doesn't have.
  // 0.3.0 (Tenancy 2b-4b): a call's fees beyond tokens (`feesMicros`: web
  // searches), which src/server/ai-mentions.ts settles every AI mention check with.
  ai: "0.3.0",
  // 0.3.0 (Tenancy 2a, D8): a per-message From name and Reply-To, so a
  // company's email carries its name on the platform's verified address.
  email: "0.3.0",
  // First releases, all three proven on adminigloo.com before they were
  // offered here — the same publish → dogfood → template rhythm feedback
  // followed. The emitted routers import from each unconditionally, so a
  // caret over nothing older can resolve wrong; these exist to move IN STEP
  // with the workspace versions the drift test reads.
  // 0.2.0 (Tenancy 2b-4b): the search check per company — its handlers and
  // route table, the safe fetcher, the screen (./ui) — none of which 0.1 has.
  "seo-reports": "0.2.0",
  // 0.2.0 (Tenancy 2b-1): alerts per company and per person. The emitted
  // src/server/alerts.ts builds createNotifications over the named tables,
  // the kind registry and the host seams, and the routes mount
  // createNotificationHandlers; 0.1 had a firm-wide inbox and none of these.
  notifications: "0.2.0",
  // First release (Tenancy 2b-1): the bell, the alerts page and Alert
  // settings, over notifications 0.2's wire. Pinned in step with the
  // workspace, as every first release here is.
  "notifications-widget": "0.1.0",
  // 0.2.0 (Tenancy 2b-1): private files per company. The emitted
  // src/server/files.ts builds createStorage with two stores, purposes,
  // records, the allowance, signed links and the logo store, and the routes
  // mount createStorageHandlers / createStorageLinkHandlers; 0.1 had a
  // public-only, firm-wide file table behind a two-method adapter.
  storage: "0.2.0",
  // First release (Tenancy 2b-1): photos and files on a record, the Files
  // screen and the usage meter, over storage 0.2's wire.
  "storage-widget": "0.1.0",
  // 0.2.0 was the answering engine (loop, registry, chat handler, conversations
  // + page-doc + pending-action tables); 0.2.1-0.2.2 hardened it; 0.3.x knowledge retrieval; 0.4.0 write-action confirm flow; 0.5.0 retention + erasure; 0.6.0 eval loop; 0.7.0 embeddings+RRF — valid history
  // replay for tool-using turns, type-based abort detection, neutral provider
  // errors, a metered/persisted errored turn, and a seeded system prompt. The
  // emitted router imports createSection/publishSection/assemblePrompt; the app's
  // AI route imports assemblePrompt — none exist below 0.1.0.
  // 0.8.0 adds the optional AdminIgloo license gate (deps @adminigloo/license);
  // it is a no-op unless the app passes license config with mode "enforce", so
  // the emitted route needs no change to keep working.
  // 0.9.0 (Tenancy 2b-3): an assistant per company. Every brain function takes
  // the company, the emitted glue builds createAssistantHandlers and
  // createAnthropicProvider (./anthropic), and the tools import saveFaq — none
  // of which exist in 0.8.x.
  assistant: "0.9.0",
  // 0.3.0: the launcher, history, Stop, starters and the "ask before acting"
  // card, and the settings screen (./admin) the company pages mount.
  "assistant-widget": "0.3.0",
  // 0.6.0 for the onEvent producer hook (optional, so the emitted route
  // needs no change); 0.5.0 was the column editor and unread marks. The emitted router imports
  // `createStatus`, `deleteStatus`, `markTicketRead` and friends; none exist
  // in 0.4.x, so a project resolving the old line fails to compile on files
  // the generator wrote. (0.4.0 was the same story for the /v1/thread and
  // /v1/reply endpoints the 0.2.x widget calls.)
  // 0.7.0 is the serious board: DB-row categories, terminal/WIP/aging on
  // statuses, soft archive, bulk move. The emitted router imports
  // `listCategories`, `archiveTicket` and friends; none exist in 0.6.x. 0.7.2 is
  // the workspace-protocol publish fix (0.7.1 shipped an unresolved workspace:^).
  // 0.8.0 adds the optional AdminIgloo license gate (deps @adminigloo/license),
  // a no-op unless the app passes license config with mode "enforce".
  // 0.10.0 (Tenancy 2b-2a): a board per company. Every staff function takes
  // the company, and the emitted src/server/feedback.ts mounts
  // createFeedbackAdminHandlers and the intake with resolveTenant and admit —
  // none of which exist in 0.9, whose functions act on the whole install.
  // 0.11.0: the complete board. The emitted settings pages render
  // FeedbackSettingsPanel from the new ./admin entry, the glue passes
  // listPeople, and the isolation proof plants rows for the new routes
  // (New ticket, editing, the trail) and the board's filters — none of which
  // exist in 0.10.
  // 0.12.0: epics. The emitted epics pages import the new ./epics entry, the
  // boards pass `epicsHref`, and the isolation proof plants an epic (createEpic,
  // setEpicTickets) for the epic routes — none of which exist in 0.11.
  feedback: "0.12.0",
  // 0.2.1 — 0.2.0 brought the "My reports" view the thread endpoints exist
  // to serve; the patch is the glacier re-skin with the widget's own dark
  // theme, which a caret would cover anyway. Pinned at the workspace version
  // because the drift test rightly refuses a pin pointing at a release that
  // is neither current nor pending.
  // 0.3.0 captures open position:fixed overlays (modals, dialogs, an AI panel)
  // separately and stitches them onto the screenshot — a full-page capture drops
  // fixed positioning, so a report about a modal used to show only the page
  // behind it. The emitted FeedbackWidget only mounts the provider, so a caret
  // over the old line would resolve a widget that photographs the wrong thing.
  // 0.4.0 (Tenancy 2b-2a): a company's public feedback page sends no key,
  // takes no screenshot and asks for the reporter's email — the emitted
  // CompanyFeedbackForm passes all three, and FeedbackLauncher is new.
  "feedback-widget": "0.4.0",
  // A devDependency of every generated project rather than a dependency, and
  // it belongs here all the same. `renderPackageJson` spelled `^0.1.1` out
  // inline, which put a fourteenth version in a place no drift test looked at —
  // the exact arrangement the rest of this table exists to replace.
  testing: "0.2.4",
  // Field service — first releases, pinned at the workspace versions the drift
  // test reads. The emitted routers/handlers import from each unconditionally
  // for the config that selects it, so a caret over anything older can resolve
  // wrong; these move IN STEP with the workspace.
  // 0.2.0 (the gs-glass port sweep): the emitted public submit calls
  // createPublicEstimate/publicSubmitSchema (a browser can no longer set its own
  // price), and the routers pass tenantId to getEstimate/getProductDetail/
  // updateProduct/deactivateProduct/setEstimateStatus — none exist in 0.1.x.
  // 0.3.0: the generated project has no estimator router any more. Its routes
  // mount createEstimatorHandlers / createEstimatorAdminHandlers (one public
  // factory for the page and the embed, a staff factory behind the authorize
  // seam), its notify module builds createEstimatorCommsListener from
  // ./comms, the photo reading is createAnthropicTakeoffRunner from
  // ./anthropic, the cron calls expireQuotes and purgeOrphanPhotos, and the
  // glue calls markEstimateConverted, getEstimate and the estimator_settings
  // table — none of which exist (or have these shapes) in 0.2.x.
  // 0.4.0 (Tenancy 2a): company, admit on both paths, the AI ceiling, async
  // links and inbox, checklist items, route tables. None exist in 0.3.
  // 0.5.0 (Tenancy 2b-1): the alert kinds and mapper, `officeRecipients` /
  // `officeSent` on the comms listener, `alertsHref`, the estimate as a
  // file record and the private photo purpose. The alerts and files glue
  // imports all of them.
  // 0.5.1 (the customer list): its comms range moves to ^0.5.0 with comms 0.5 (onSent).
  estimator: "0.5.1",
  // 0.2.0: the estimate page, the quote page and the four staff pages render
  // its components (EstimateTool, QuoteView, EstimatesQueue, EstimateEditor,
  // PriceBook, EstimatorSettings, EmbedKeys). It speaks 0.3's wire, so it
  // moves with estimator 0.3 and never with 0.2; 0.1.x had only the modal.
  // 0.3.0: pattern hrefs a server page can pass ("/app/estimates/{id}"), the
  // closed-by-the-business message, the logo, the ceiling hint, #embed.
  // 0.4.0 (Tenancy 2b-1): who hears about new leads is handed to Alert
  // settings, so the old list isn't offered beside the new one.
  // 0.5.0 (getting paid, part 1): `depositHref`, the accepted quote's "Pay the deposit".
  "estimator-widget": "0.5.0",
  // 0.3.0: the emitted public procedures call findPublicSlots (PublicSlots only —
  // 0.2's slots route returned the previous customer's street address) and
  // requestPublicBooking with a requesterKey (server-derived times and crew,
  // pending, a cap on one caller's waiting requests, one transaction under a
  // per-crew lock); the policy module extends requestPublicBookingSchema; every
  // staff call passes the tenant to the by-id functions (updateResource/
  // deactivateResource/listAvailability/setBookingStatus), `validate` uses
  // timeOfDaySchema/endTimeSchema, the bookings list sends
  // nextBookingStatuses, the seed asks listResources({ includeInactive }), and
  // the admin reads hoursConfigured/acceptsPublicBookings. None of that exists
  // in 0.2.x, so a caret over it would resolve a build the emitted code cannot
  // compile against.
  // 0.4.0: the generated project no longer has a scheduling router at all. Its
  // routes mount createSchedulingHandlers / createSchedulingAdminHandlers, its
  // notify module builds createSchedulingCommsListener from ./comms, the cron
  // calls expirePendingRequests, the setup writes first settings through
  // updateSchedulingSettings and runs backfillVisitInstants, and the maps
  // provider is createGoogleMapsProvider behind createCachedMapsProvider —
  // none of which exist in 0.3.x.
  // 0.5.0 (Tenancy 2a): the companies glue passes the company, admit,
  // async links and the company inbox, reads settings through
  // resolveSchedulingSettings (the zone convergence), seeds Crew from
  // SCHEDULING_CREW_ROLE, lists the checklist items and the isolation proof
  // drives SCHEDULING_ADMIN_ROUTES / _PUBLIC_ROUTES — none of which exist in 0.4.
  // 0.6.0 (Tenancy 2b-1): the alert kinds and mapper, the expiring sweep,
  // `officeRecipients` / `officeSent`, `alertsHref` and the visit as a
  // file record. The alerts and files glue imports all of them.
  // 0.6.1 (the customer list): its comms range moves to ^0.5.0 with comms 0.5.
  scheduling: "0.6.1",
  // First release. The booking page, the manage page and the three staff
  // pages render its components; it speaks 0.4's wire, so it moves with
  // scheduling 0.4 and never with 0.3.
  // 0.2.0: the company pages pass accentColor and inviteHref, and the settings
  // screen shows the company-owned fields read-only — none of it in 0.1.
  // 0.3.0 (Tenancy 2b-1): the calendar opens a visit from ?visit= and links
  // its photos and files, and today's route has a Photos button per stop.
  "scheduling-widget": "0.3.0",
  // Tenancy 1's screens (onboarding, the switcher, the team page, company
  // settings, the operator console). In the BASE set: the team page is in
  // every project, single-business ones included.
  // 0.2.0 (Tenancy 2a): CompanyBrandBar and CompanyUnavailable on every
  // company's public pages, and any role the server offers (Crew). 0.2.1
  // (Tenancy 2b-1): its tenancy peer is ^0.6.0 — pinned, so a project's
  // lockfile can't keep a 0.2.0 whose peer still names tenancy 0.5.
  "tenancy-widget": "0.2.2",
  // 0.2.0 (sweep): line items after creation, atomic idempotent payments,
  // reversals, a status transition table and tenant-scoped reads — the emitted
  // admin page and router call addInvoiceItem/reversePayment/markInvoiceViewed
  // and the {tenantId} signatures, none of which exist in 0.1.x.
  // 0.3.0 (Tenancy 2a, D3): the ledger is the package's HTTP handlers
  // (createInvoicingAdminHandlers, createInvoicingHandlers) behind the widget,
  // token reads scoped to a company, the settings fragment, the invoice email
  // in ./comms. The 0.2 tRPC router is retired, so nothing older can serve it.
  // 0.4.0 (Tenancy 2b-1): `onEvent` (an invoice opened, an invoice paid),
  // the overdue sweep, the alert kinds and mappers, and the invoice as a file
  // record. The alerts and files glue imports all of them.
  // 0.5.0 (getting paid, part 1): Pay now — the `payments` seam, the pay route,
  // deposits, handleInvoiceCardEvent and invoice_checkouts. None exist in 0.4.x.
  // 0.6.0 (the customer list): `invoice.created` and the phone on an event —
  // the customers glue links a staff-made invoice to its customer from it.
  invoicing: "0.6.0",
  // First release (Tenancy 2a): the ledger, one invoice's editor and the
  // customer's invoice page, over invoicing 0.3's wire. 0.1.1 (Tenancy 2b-1):
  // its invoicing peer is ^0.4.0 — pinned for the same lockfile reason.
  // 0.2.0 (getting paid, part 1): Pay now on the customer's page, the deposit
  // and a payment's dispute/refund mark in the ledger, over invoicing 0.5's wire.
  // 0.2.1 (the customer list): its invoicing range moves to ^0.6.0 with invoicing 0.6.
  "invoicing-widget": "0.2.1",
  // 0.2.0 (sweep): SMS compliance is required with an SMS sender, the queue is
  // bounded and cancellable, and the emitted router calls setTemplateActive and
  // requireEmailSubject — none exist in 0.1.x.
  // 0.3.0 (Tenancy 2a): each company's emails go out under its own name and
  // reply-to (identity), the drain takes tenantIds, and the Messages console is
  // the package's createCommsAdminHandlers. The 0.2 tRPC console is retired.
  // 0.4.0 (Tenancy 2b-1): `onFailed` (a customer email that didn't go
  // becomes an alert), `deliverNow` (the office emails' outcomes),
  // `templateLabel` and the failed-email alert kind.
  // 0.5.0 (the customer list): `onSent` — each message that went lands on
  // its customer's timeline (src/server/comms-senders.ts).
  comms: "0.5.0",
  // First release (Tenancy 2a): the Messages console, over comms 0.3's wire.
  // 0.1.1 (Tenancy 2b-1): its comms peer is ^0.4.0, and it names the team
  // alert email — pinned for the same lockfile reason.
  // 0.1.2 (the customer list): its comms range moves to ^0.5.0 with comms 0.5.
  "comms-widget": "0.1.2",
  // 0.2.0 (Tenancy 2b-4b): AI mentions per company — the handlers and route
  // table, the metered runner, the Anthropic engine (./anthropic), the screen.
  aeo: "0.2.0",
  // Tenancy 2b-4a: each company's website numbers. 0.3.0 has the site
  // register, the company handlers and route tables, the drop-in screens
  // (./dashboard: WebsiteTraffic, WebsitesSettings) and the snippet's script,
  // none of which exist in 0.2.x.
  analytics: "0.3.0",
  // 0.2.0: one audience per company (createAudiences), its company handlers
  // and route table, and the drop-in "leave these people out" panel.
  audience: "0.2.0",
  // 0.2.0: a whole-segment * in the path list (a company's token pages,
  // /t/{web address}/quote/…) and a LocalBusiness without an address.
  seo: "0.2.0",
  // 0.2.0 (Tenancy 2b-4c): book a call per company — the admin and public
  // handlers and their route tables, the open/closed gate, the company caps,
  // reminders and the pinned calendar reader. 0.1 had none of these.
  booking: "0.2.0",
  // 0.2.0: the fetch adapter over booking 0.2's admin routes, the honeypot and
  // the "closed" sentence; pinned in step with the workspace.
  "booking-widget": "0.2.0",
  // First release (the customer list): one customer list per company —
  // find-or-create, the links every feature's glue writes, the timeline,
  // merge, CSV import and export, the directory seam, the backfill, the
  // handler and its route table, and the screens (./admin).
  customers: "0.1.0",
};

export class UnknownPackageVersionError extends Error {
  readonly name = "UnknownPackageVersionError";
  constructor(pkg: string) {
    super(
      `No version recorded for ${pkg}. Add it to PACKAGE_VERSIONS in ` +
        `versions.ts — guessing a range here is how a project silently ` +
        `installs the wrong one.`,
    );
  }
}

/** `@scope/name` -> the caret range a generated project should depend on. */
export function versionRangeFor(scopedName: string): string {
  const bare = scopedName.replace(/^@[^/]+\//, "");
  const version = PACKAGE_VERSIONS[bare];
  if (!version) throw new UnknownPackageVersionError(scopedName);
  return `^${version}`;
}

export function packageVersions(): Readonly<Record<string, string>> {
  return PACKAGE_VERSIONS;
}
