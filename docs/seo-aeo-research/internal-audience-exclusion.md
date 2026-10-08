# Internal and test traffic exclusion: what exists, what leaks, and requirements

Every repo was read only; nothing was changed.

## Bottom line

- **Riddler Go excludes almost no internal traffic from its analytics.** It only drops automated browsers and localhost, and that check runs in the browser (`lib/tracking/beacon.ts:43-47`, commit 44f5785). Signed-in staff, Rachel's analytics consultant, staff test events and staff purchases on production all count.
- **Riddler Go's history can be cleaned, partly.** Every report runs live against raw rows (there are no stored rollups), and visitors carry a 2-year cookie. The missing pieces are a link from visitor to user and an "internal" tag.
- **Road Rally has the best model to copy.** It has one internal rule, an "include internal" toggle, and a count of what was excluded for each reason. It still leaks staff browsing that never logs an email, staff on personal Gmail accounts, and ad pixels.
- **trailcards and the AdminIgloo package each cover one slice:**
  - trailcards: test orders and non-production deployments.
  - AdminIgloo: signed-in staff, opt-out and automation.
  - The AdminIgloo package only drops traffic at intake. It has no tag and cannot clean history.
- **Rachel's own wording was not found in any document.** The grep found only the Play Along "host is excluded" wording (`Host Dashboard Worksheet.md:275`, `LE View — Competitive Mode.md:49`, `RG Product Specification (1).txt:603`). The closest written record of her complaint is in Road Rally commit messages:
  - cb6462c1: "staff test teams were skewing the numbers"
  - a7a79cc3 (2026-10-06, not in your list, and the direct fix): "staff test teams like snowcat92 showed under 'Users who are registered'"

## 1. What exists in each codebase

### Riddler Go

**Where traffic gets dropped today**
- **In the browser** (`lib/tracking/beacon.ts:43-47`): `navigator.webdriver`, plus `localhost` and `127.0.0.1`.
- **By path** (`lib/tracking/BeaconClient.tsx:13-32`): `/admin`, `/dashboard`, `/events`, `/play`, `/staff`, `/event-builder` and similar. This is a path filter, not a person filter.
- **Nowhere on the server.** The beacon route `app/api/beacon/route.ts:51-147` has no role, user, user-agent, origin, environment or rate-limit check.

**How sessions are stored**
- `db/schema/analytics.ts:12-46`: there is no `user_id` and no `is_internal` column.
- `organizationId` (`:16`) is never written by any tracking code.
- Sessions are keyed on the `rg_visitor` cookie (`lib/tracking/analytics-session.ts:20-21`, 2 years).

**Funnel events written by the server**
- `lib/tracking/server-events.ts:62-85` writes them for anyone who has the cookie:
  - `sketch_claimed`: `lib/events/claim-sketch.ts:398`, with `{eventId, sketchId}`
  - `event_published`: `lib/events/actions.ts:276`, with `{eventId…}`
  - `checkout_completed`: `lib/billing/checkout.ts:517,705` and `app/(app)/settings/billing/return/page.tsx:62`, with `{orderId, productSlug}`
- End-to-end test runs are excluded only by accident. The browser never sends a beacon, so no cookie is set and the function returns at `:69`.

**Reports**
- `lib/analytics/queries.ts:215-217` defines `inWindow()`, one predicate shared by sessions/KPIs, sources, referrers, landing pages, campaigns, engagement, timing and the funnel (`:249,294,339,373,450,485,516,523,763`). That is a single place to add an exclusion.
- Web Vitals (`:650-690`) read `session_events` without joining sessions, so they would need their own filter.
- Weekly digest: `lib/analytics/digest-send.ts:129-134`.

**Platform counts**
- `app/admin/page.tsx:14-74` counts every organization, draft event and live event, including staff workspaces.
- `orders` (`db/schema/billing.ts:219-268`) has no `is_test`.
- The Product Spec's platform reporting list is customer growth, subscriptions, revenue, event creation and usage (`RG Product Specification (1).txt:650-655`). None of it is built with an exclusion.

**Who counts as staff**
- `users.platformRole` is `super | staff | analytics` (`db/schema/auth.ts:48`).
- The end-to-end test users are nine `*+clerk_test@example.com` accounts (`e2e/auth.setup.ts:67-153`). They only touch staging: local and staging share the staging database, and production is separate (`docs/plans/_conventions/environments.md:17-21`).

**Play Along (3411fe4): a pattern to reuse**
- One predicate: `lib/participants/counted.ts:28-32`.
- A test that fails the build when any read of the session or participant tables misses it: `lib/__tests__/host-play-exclusion.test.ts`.
- Event reports (b360d28, 2ecd5a8) use it (`lib/reports/queries/event-summary.ts:18`).
- Staff who join a customer's event through the public form are still counted, by design (`counted.ts:23-25`).

**AI-crawler hits**
- These match on user agent only and are never verified (`lib/tracking/ai-crawler-capture.ts:37`), so a faked user agent counts.

### Road Rally (`C:\Users\dalli\riddler\MonoRepo`, branches staging and master)

**The rule** (`packages/backend-api/src/api/admin/_registrationReport.ts:88-98`)
- Someone is internal if their account type is not `user`, or their email contains `riddlerroadrally`.
- A deleted owner counts as external.

**Excluded counts by reason**
- `:197,224-231,249`: `exclusionOf` gives demo / inHouse / internalOwner, and `totals.excluded` counts each one, so the numbers can be explained.
- Exclusions run in JavaScript, never SQL, because `NOT(NULL)` would silently drop rows (`:11-13`).

**Sessions**
- `_sessionsUtils.ts:765-793`: `isInternalSession` checks the signed-in email, or any email the session logged, or the shared `"guest"` login.
- `sessions.ts:114-174`: there are `includeInternal` and `includeDev` options.
- The dev check reads only `events[0].referrer`, never the URL (`:116-125,158-162`). A direct localhost visit has no referrer, so it leaks (INFERRED; mostly a staging issue, because web dev points at staging-v2).

**Admin screen**
- `Sessions/index.tsx:656-669`: "Include internal accounts (staff, testers, demo)" and "Include dev / localhost traffic".
- Since a7a79cc3, the internal toggle is no longer remembered between visits.

**Leaks**
- **Anonymous staff tabs.** Sessions are per browser tab (SIGNUP_ANALYTICS_PLAN.md G5), so a tab that never logs an email is counted.
- **Staff on personal email.** The rule is hard-coded, and there is no list of named people.
- **Ad pixels fire for staff.** Meta Purchase, CompleteRegistration and Floodlight have no internal check (`packages/web/src/api/_utils.ts:250-348`, loaded on production only per `layouts/v2/UserLayout.astro:10,185`).
- The original rule is 79118e53 (2025-05-22).

### trailcards

**Commit 828485e**
- `orders.is_test` (migration 0017) is set when the order is created, for Stripe `livemode=false` or a non-production deployment.
- Admins can toggle it, and the toggle writes a timestamped note (`src/server/api/routers/orders.ts:391-430`).
- `reportableOrder()` (`src/server/utils/reportableOrders.ts`) means "paid and not test" and is used by every report.
- `isNonProductionDeployment()` (`src/server/utils/deployment.ts`) drops ingest outside production and fails open, so production never loses data.

**Other good patterns**
- Bots are tagged, not dropped: `sessions.is_bot`, then `eq(sessions.isBot,false)` in `analytics.ts:109,470,523,581,596`.
- The AI report states what it leaves out (`src/lib/analytics/aiReport.ts:96`).

**Leaks**
- Signed-in admins browsing production are counted. The event route never sets `sessions.userId` and has no role check.
- `setTestFlag` does not recompute `content_attribution_daily`. The rollup rebuilds one day per run (`contentAttributionRollup.ts:6,26`), so past days keep the test order until someone reruns them.

### AdminIgloo (`@adminigloo/analytics` 0.1.0 and the testbed)

**Package**
- Browser skips (`client.tsx:115-125`): Global Privacy Control, Do Not Track, `webdriver`, and an opt-out stored in localStorage under `adminigloo:analytics-off`.
- There is a `disabled` prop (`:30`).
- Ingest (`ingest.ts:229-245`) checks same-site origin and privacy signals, drops crawler user agents, and applies a per-network hourly budget.

**Testbed**
- `viewerIsStaff()` (`src/server/site-analytics.ts:111-122`) is passed in as `disabled` (`app/(site)/layout.tsx:51,81`). It only works while staff are signed in.

**Gaps**
- It drops traffic only; there is no internal flag on `analytics_sessions`.
- Visitor identity is cookieless (an HMAC with a daily salt, `schema.ts:24`), so a session can never be tied back to a person. Retroactive exclusion is impossible by design.
- No IP list, no list of people, and no "excluded N" counts.
- Its `analytics_sessions` table name clashes with Riddler Go's.

## 2. Where Riddler Go leaks, ranked

1. **Staff, Rachel and the analytics consultant browsing marketing pages on production.** The beacon is mounted globally (`app/layout.tsx:98`) with no check of who is signed in.
2. **Anonymous staff visits before sign-in or after sign-out.** The cookie lasts 2 years but is never linked to a user.
3. **Funnel stages fired by staff:**
   - publishing a test event (`event_published`)
   - claiming a sketch (`sketch_claimed`)
   - free claims or test purchases (`checkout_completed`)
4. **Platform counts** (organizations, events, live now) include staff workspaces and test events. There is no test flag at organization, event or order level.
5. **Weekly digests** already sent to staff contain polluted numbers and cannot be recalled.
6. **Bots that run JavaScript.** There is no server-side user-agent classification and no origin or rate check at the beacon. That Googlebot's renderer actually fires the beacon is INFERRED.
7. **Scripted POSTs to `/api/beacon`.** These can add made-up visits (no origin or rate check).
8. **Spoofed AI-crawler user agents.** These rows are never verified.
9. **Monitors that run a real browser without `webdriver` set, and Lighthouse or PageSpeed runs.** INFERRED.

These do not leak into production:
- **Preview, staging and end-to-end runs:** they use the staging database.
- **Play Along:** excluded, and `/play` is never beaconed.

## 3. Requirements for an "exclude internal audience" capability

### A. How to identify internal traffic

Each rule is stored data with a type, a value, a reason label, who created it, when, and an optional date it applies from.

1. **Role.** The host app passes an `isInternalUser(user)` callback. For Riddler Go that is `platformRole` in super, staff or analytics; for Road Rally it is type not equal to `user`.
2. **Named people by user id.** This covers Rachel's "list of people".
3. **Email rules:**
   - exact addresses
   - whole domains (`riddlergo.com`, `riddlerroadrally.com`, `adminigloo.com`)
   - patterns: `+clerk_test`, `+test`, `@example.com`, a substring marker as Road Rally uses
   - matching is trimmed and lower-cased, with optional Gmail dot and plus folding
4. **Organization and event flags:**
   - `organizations.is_internal` for staff workspaces and demo orgs
   - `events.is_test` that the host or staff can toggle, kept separate from staff-run real events such as the 2026-10-09 trial
   - Road Rally-style "demo" and "in-house" reasons
5. **Transactions.** `orders.is_test`, set automatically for Stripe `livemode=false`, simulated purchases, non-production deployments and orders placed by internal users or orgs, and toggleable with a note (the trailcards pattern).
6. **Device mark.**
   - A signed `?internal=1` link and an "exclude this browser" button set a long-lived first-party cookie (plus localStorage) that survives sign-out.
   - When an internal user signs in, the device is marked automatically.
7. **IP/CIDR list.** Office and home addresses, matched at intake only. Neither Riddler Go nor AdminIgloo stores raw IPs, so the screen must say IP rules are not retroactive.
8. **Environment and host.**
   - Not production, by `VERCEL_ENV` or `NODE_ENV`.
   - Request host not in the production allow-list (apex and www are both production; preview URLs, staging and localhost are not).
   - The page URL is checked, not just the referrer.
9. **Automation.**
   - Browser: `webdriver`.
   - Server user agent: HeadlessChrome, Playwright, Chrome-Lighthouse, UptimeRobot, Pingdom, Checkly and similar.
   - A secret header for end-to-end or smoke runs against production.
10. **Bots.** A separate "bot" tag, not "internal". Verify by IP range or reverse DNS where possible; the AdminIgloo package has `verify.ts`.
11. **Shared logins** (Road Rally `guest`) and host-play or preview sessions (keep `countedSession`).
12. **Reason precedence.** Rules are applied in a fixed order so the per-reason counts add up to the total excluded (Road Rally `exclusionOf`).

### B. Where to apply it: both at intake and at query time

**At intake: tag, don't drop.**
- Write `is_internal`, `internal_reason` and `rule_version` on the session.
- Upgrade a session that is already open when the visitor turns out to be internal mid-visit, for example on sign-in.
- Server-side funnel writers check the acting user and org directly; this is the most reliable signal.
- Drop only:
  - malformed or over-budget requests
  - non-production traffic writing into the production database
  - browsers that opted out for privacy (Global Privacy Control or Do Not Track)

**At query time**
- One `countedAudience()` predicate is used by every report, Web Vitals, the digest, the AI report, exports and platform counts.
- Add a test that fails the build when a query reads the analytics tables without it (copy `host-play-exclusion.test.ts`).
- In Riddler Go, add it to `inWindow()`, plus a separate join for Web Vitals.

**At the source, for data that leaves the app**
- Suppress third-party pixels (Meta, Google Ads, Floodlight) for flagged browsers and users, because that data cannot be cleaned afterwards.

### C. Cleaning numbers already polluted

1. **Store a visitor-to-internal link** (`analytics_internal_visitors`: visitor id, reason, rule id, marked at).
   - Flagging a visitor cleans all of their sessions, including the anonymous ones before sign-in, because the cookie lasts 2 years.
   - Store links only for internal people, not every customer, to keep data minimal.
2. **Riddler Go backfill that works today.** Join the `session_events.properties` fields `eventId` and `orderId` (from `sketch_claimed`, `event_published` and `checkout_completed`) to events, orgs and orders owned by internal users. Mark those sessions, then mark every session from the same visitor. Historical browsing by staff who never converted cannot be found; say so on screen.
3. **When a rule is added or changed:**
   - Re-classify history in batches, idempotently, with a progress indicator.
   - Recompute any stored rollups for the affected days (trailcards `content_attribution_daily`; Riddler Go has none).
   - Add a dated annotation automatically: "Internal rule added: N sessions excluded back to <date>".
   - Note the revision on the next digest.
4. **Removing a rule restores the data.** Never hard-delete tagged rows.
5. **Every card, the digest and the AI report show an exclusion line**, for example "Excluded: N sessions (staff X, test events Y, automation Z, dev W)" (Road Rally `totals.excluded`; trailcards `aiReport.ts:96`).

### D. Admin screens

- **An "Internal audience" settings page** that lists rules by type and supports add, edit and delete.
- **Preview before saving:** sessions, visitors, events and orders affected over 30 days, 90 days and all time, plus before/after KPIs.
- **Audit log:** who, when, which rule, and its impact count.
- **An "Include internal" toggle on each report.**
  - It is not remembered between visits (Road Rally a7a79cc3).
  - A banner shows while it is on.
- **Quick actions:**
  - mark this session or visitor as internal
  - mark this event as a test (host and staff)
  - mark this order as a test, with a note
  - copy the "mark my device" link
- **Permissions.**
  - Super and staff edit rules.
  - The `analytics` consultant role can view and toggle, but not edit, and sees emails masked (the Road Rally analyst-privacy pattern).

### E. Privacy

- Never store visitor IPs. IP rules are checked at intake and the IP is discarded.
- Rule emails and the email/domain lists are stored normalized and shown masked to the analytics role. Optionally store an HMAC with an app secret for people outside staff.
- Store visitor links only for flagged visitors.
- The device-mark cookie is functional and first-party. That it needs no consent is INFERRED; confirm with legal.
- Honor Global Privacy Control and Do Not Track separately. Riddler Go does not today.
- Re-check Riddler Go's privacy page if visitor ids are ever linked to users more broadly (INFERRED).

### F. Which metrics it must cover

**Must exclude internal traffic by default:**
- visits, sessions, unique visitors, page views
- sources, referrers, campaigns, landing pages
- engagement and timing
- every funnel stage
- sign-ups and account creation
- sign-up sources and first/last touch
- conversions, orders, revenue, average order value, recurring revenue
- platform counts: organizations, events created, live events, subscription metrics
- platform-wide participation totals
- the weekly digest, AI report, exports and annotations

**Exclude by default, with a setting:**
- Web Vitals. Staff hardware skews the 75th percentile.

**Host-owned event reports:**
- keep Play Along
- add "test event" and "test participant" marks
- per-event numbers stay the host's call

**Must never exclude** (real costs or operations):
- AI spend and usage (`app/admin/ai-usage`)
- capacity and entitlements
- audit and security logs
- email deliverability
- error monitoring
- rate limits

AI-crawler hits are bots, not people, so they need verification, not internal exclusion.

### G. Numbers it cannot clean (outside data)

| Source | Why it can't be cleaned |
|---|---|
| Google Search Console | Staff brand searches and clicks are counted at Google |
| AEO citations | External engines' answers; our own probe queries are internal by definition |
| Meta, Google Ads, Floodlight conversions (Road Rally) | Can only be prevented at the source |
| Stripe dashboard, Clerk user counts, Resend open rates, backlink tools, Vercel Analytics if enabled | Kept outside the app |
| Digests already emailed | Already delivered |

The screen should label these as unfiltered.

### H. Changes Riddler Go needs (all additive)

**Schema**
- `analytics_sessions.is_internal` and `internal_reason`
- new tables `analytics_internal_visitors`, `analytics_internal_rules` and an audit table
- `organizations.is_internal`
- `events.is_test`
- `orders.is_test`

**Code**
- Tag in the beacon route and in `resolveOrCreateAnalyticsSession`; they read Clerk `auth()`, the device cookie, the host and the user agent.
- Tag in `recordServerEvent` from the acting user's org.
- Add the predicate in `queries.ts` (`inWindow()` plus Web Vitals) and to the admin home counts.
- Add the build-failing test.

**Package naming**
- Make the package's table prefix configurable, because `analytics_sessions` clashes with Riddler Go's table.