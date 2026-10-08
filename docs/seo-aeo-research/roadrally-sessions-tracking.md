# Riddler Road Rally analytics work: commits, internal-account exclusion, and what to reuse

Everything here was read-only, from the MonoRepo at `origin/staging` a7a79cc3 (local `staging` is the same commit). Paths are relative to `C:\Users\dalli\riddler\MonoRepo\packages\` unless they name another repo.

## 0. Corrections to the brief

- **Data store.** These reports do not use DynamoDB or Athena. All analytics data is in PlanetScale MySQL through Drizzle (`backend-integrations/src/relationalDB/relationalDB.ts:1-2`), mainly the `session-data` table (`schema.ts:1205-1226`). That table's primary key is (id, timestamp), it has no other index, and it stores no IP column. DynamoDB holds only gameplay sessions.
- **Attribution window.** The commit message says touches are "kept for 7 days". In the code the browser keeps them for 90 days (`TOUCH_TTL_MS`, `web/src/util/attribution.ts:38`). The server only counts a stored touch from the 7 days before the sign-up (`STORED_TOUCH_MAX_AGE_MS = SIGNUP_LOOKBACK_MS`, `backend-api/src/api/admin/_signupSources.ts:40,52`).
- **analytics_admin gate.** 2cbc77d6 (2026-07-22) re-read the role from the DB on every request and let the role into `/reports` and `/sessions`. 5dfdd7d4 (2026-07-23, "touch ups") narrowed it to `/sessions` only. It also switched back to trusting the role inside the login token (JWT), which lasts 2 years (`(public).ts:2053,2105,2259`). So **a demoted analyst keeps Sessions access until they log out or the token expires.**
- **Two follow-up commits are part of the internal-account rule:**
  - a7a79cc3 (staging) / 5e5fb1f0 (master), 2026-10-06, "keep staff out of the per-event roster and every session card"
  - 34b61d3b / 0a199680, 2026-10-05, which dated the tracking changes as live in production on 2026-10-05
- **Plan document.** The full plan is in an untracked file, `MonoRepo\SIGNUP_ANALYTICS_PLAN.md` (949 lines). Its Phase 6 (a step-by-step funnel and a `funnel-step` table, §§772-949) is waiting on Rachel's decisions.

## 1. Commits, branches and remote state

Each change was committed twice, once on `staging` and once on `master`:

| Change | staging | master | Date |
|---|---|---|---|
| Sessions reports (Phases 1a-3) | 4de6d8e2 | be48fb38 | 2026-10-02 |
| Tracking 1.3.0 (Phases 4-5) | 756e03a8 | 3b9d50df | 2026-10-02 |
| Date the tracking changes (prod 2026-10-05) | 34b61d3b | 0a199680 | 2026-10-05 |
| Stage info box; one internal rule | cb6462c1 | 1dfab22c | 2026-10-06 |
| Staff out of roster and session cards | a7a79cc3 | 5e5fb1f0 | 2026-10-06 |
| analytics-only admin role | 2cbc77d6 (same commit on both) | | 2026-07-22 |

- `git branch -a --contains` puts the staging copies only in `staging`/`origin/staging` and the master copies only in `origin/master`.
- 2cbc77d6 is in `master`, `staging`, `admin-mobile-styles`, `smartWaver`, `remove-internal-docs` and `origin/combo-puzzle-upgrades`.
- Local `master` is stale (behind origin by 28). `origin/master` is at 5e5fb1f0.
- **Deployed:** CI deploys `master` to production and `staging` to staging (`.github/workflows/backend-prod.yml:8-9,57`, `backend-staging.yml:8-9,52`). `gh run list` shows success for 1dfab22c and 5e5fb1f0 on master and cb6462c1 and a7a79cc3 on staging (2026-10-06 UTC). So this work is live in production.

## 2. Sessions reports and metrics (be48fb38 / 4de6d8e2, plus follow-ups)

**Where it lives.** The UI is the Astro + SolidJS admin app in `web/`:
- Dashboard at `/admin/sessions` (`web/src/components/Admin/Sessions/index.tsx`)
- Per-event report at `/admin/session-reports/event/:id` (`EventSpecific.tsx`)

The backend routes are on `/api/admin/sessions` (`backend-api/src/api/admin/sessions.ts`):

| Route | Line |
|---|---|
| `/user-sessions` | :565 |
| `/event-registration-dropoff-report/:eventId` | :683 |
| `/qsp-report` | :856 |
| `/conversion-funnel/:eventId` | :963 |
| `/session-analytics` | :1008 |
| `/bounce-analysis` | :1059 |
| `/registration-report` (new) | :1122 |
| `/signup-sources` (new) | :1240 |

The logic is pure TypeScript run over explicit-column queries: `_registrationReport.ts`, `_signupSources.ts`, `_sessionsUtils.ts`.

**A. Registrations by Event and by Day**
- Source: `event-team` (live events) and `past-event-team` (Rally on Demand), joined to `team`, the event, and the owner's `user` row with a LEFT JOIN. A registration is one team entry, dated by `registeredAt` (`_registrationReport.ts:133-154,243-400`).
- Days are America/Denver calendar days, half-open ranges, DST-safe. An edge day covering 1 hour or less is dropped (`:24-82`).
- Each event row shows a status breakdown for live events only. Rally on Demand shows totals only.
- A deleted owner counts as an external customer, labelled "deleted account".

**B. Accounts → Registrations funnel** (`classifyAccountFunnel`, `:651-764`)
- Sign-ups started = verified users whose consent `signed-waiver.signedAt` is in the window, plus surviving `temp-user` rows with no matching user.
- Accounts created = `user.createdAt` in the window, one person per lower-cased email.
- Each account lands in exactly one group, in this order:
  - a: owner of a registered team
  - b: joined a registered team (approximate)
  - c-owner: created a team, never registered it (plus a "placeholder name" subset)
  - c-member: on a team that hasn't registered
  - d: no team yet
- Also reported: never verified, verification rate, median time to verify, median time to register.
- `reliableFrom` is detected automatically. It finds the burst of identical `created-at` values left by migration 0080 (≈2026-07-03) and clamps the window to after it (`:525-558`).
- Stage labels and definitions are in `_registrationFormat.ts:117-212`. cb6462c1 replaced the hover bubble with a tinted info box next to the table (`RegistrationCards.tsx`).

**C. Sign-ups by Source** (`_signupSources.ts`, `SignupSourcesCard.tsx`)
- Only loads when you click it. The window is capped at 31 days, the table at the newest 2,000 rows, and it returns 413 above 20,000 candidate sessions.
- The anchors are accounts, unverified sign-ups and registration owners.
- A browser tab is linked to a person by email through these events: `authorized`, `email-verified`, `signup`, `user-created`, and a `submit-email` resolved within 120 seconds.
- First touch = the earliest linked tab in the 7 days before the sign-up to 1 hour after, or the stored first/last touch from Tracking 1.3.0.
- Each row also carries the hear-about-us answer and the coupon code (masked).
- Classification follows D10 (`_classifySource.ts:104-118`): a paid `utm_medium` or a Google/Microsoft/TikTok/LinkedIn click id counts as Paid; `fbclid` alone counts as Social. This was applied retroactively, with a note (`SOURCE_RULES_NOTE`, `:13`).

**Per-event report (Phase 3)**
- The window is the event's registration period: at least 30 days and at most 31, with Earlier/Later paging.
- The funnel now counts ad deep links (people who open a registration link without viewing the event page).
- Event IDs are matched exactly (`eventId=1` no longer matches 12 or 100).
- The parameter chart shows the top 20 values plus "other".
- Rosters now come from the database, which fixed a broken team query.
- Registrations by Day and "Coupons used in registration" were added.

**Other additions**
- AI-ready report: aggregates only, never emails (`_buildAiReport.ts`).
- Dated "Tracking changes" note on both pages and in the AI report (`_trackingChanges.ts:14-43`, all dated 2026-10-05).

**Analyst privacy** (what analytics_admin cannot see)
- `canSeeFullPii` is true only for admin, so the rule fails closed (`_sessionsUtils.ts:169-170`).
- Emails are masked, e.g. `j***@gmail.com #tag`. The tag is a hash with a random per-response salt, so tags can't be linked across requests. Free-mail domains are kept; other domains are cut to the top-level domain (`:199-226`).
- User IDs become -1. Rosters show no IDs, last initials only, and no "UserID#" placeholder team names (`_registrationReport.ts:892`).
- Survey free text is scrubbed of emails and phone numbers (`:241`). Coupon codes are masked (`:259`).
- Referrers are cut to origin, path and ad parameters.
- The parameter chart only allows `utm_source`, `utm_medium` and `utm_campaign` (`:74`). Click IDs and credential keys get a 400.
- No revenue anywhere: the routes never read `Transaction`, entry fees or jackpots.
- Why: the analyst is an outside consultant (Christian), and the AI report is pasted into third-party tools.

## 3. Tracking 1.3.0 (3b9d50df / 756e03a8, production 2026-10-05)

**The tracker** is first-party beacons to `/api/public/session-data` from `web/src/api/session.ts`, version `"1.3.0"` (`:21`).
- `logEvent` never throws, and a pixel failure can't cost the first-party row (`:101-110`).
- The session ID is per browser tab (`sessionStorage`). If storage is blocked it falls back to an in-memory ID.
- Timestamps are forced to increase (`monotonicClock.ts`), so two events in the same millisecond no longer collide on the primary key.
- URLs are scrubbed before sending (`:112-128`) and again at ingest (`toSessionDataRow`, `public/_utils.ts:257`):
  - `redactUrlLike` blanks the values of `jwt`, `token`, `pin`, `email`, `tempUserId`, `invitationCode`, `redirect`, `teamId` and `userId`, plus any value that holds an email (`backend-api/src/_utils/urlPrivacy.ts:13-78`).
  - url/referrer/qsps are capped at 512 characters and title at 256. Event data over 16,000 characters is dropped (`public/_utils.ts:184-217`).
  - A parity test checks the client and server copies agree (`tests/cross-package/urlPrivacy.parity.test.ts`).

**First/last touch**
- An inline head script runs on every v2 page (`firstTouch.ts:31-70`, injected at `layouts/v2/UserLayout.astro:169-170`).
- It writes `localStorage` keys `rrr-first-touch` and `rrr-last-touch` as `{v:1, ts, path, ref?, q?}`:
  - first touch is written once and replaced only after 90 days
  - last touch is overwritten by any landing with campaign parameters or an outside referrer
- What it keeps: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` (capped at 100 characters; email values become "redacted"). Click IDs (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`) are stored as presence only (`=1`). Plus the landing path and the cross-site referrer origin (`attribution.ts:17-39`).
- It skips `/admin` and `/verify-email`, and any URL carrying `pin`, `tempUserId` or `jwt` (`:35,41`).
- The touches ride only on the beacon for `signup`, `user-created`, `email-verified` and `registration-complete` (`:73-78`). They are never merged into the `data` the partner (MNI) pixel sends to Meta.
- The server re-validates them, because ingest is unauthenticated.
- UTMs are carried through the `/event-registration` → `/events` redirect (`carryAttributionParams`, `attribution.ts:157`).
- Limits: www and the bare domain have separate storage, and Safari caps script storage at 7 days.

**Verification link back to the wizard**
- `create-temp-user` now accepts `eventId`, `rodEventId` and `signupMode`. Bad values are dropped, never a 400 (`public/_utils.ts:290-297`).
- The server builds the email link to `/event-registration/?…` or `/rally-on-demand-registration/?…` instead of `/verify-email` (`buildVerifyEmailLink`, `:314-342`).
- Private events keep `/verify-email` so the invitation code never goes in an email (`(public).ts` diff around :1991).
- If the event can't load, the link falls back to `/verify-email` (`verifyLinkContext.ts:47-60`).
- After a successful verify, `email`, `pin` and `tempUserId` are stripped from the address bar (`:69-89`).
- New wizard step events: `team-created`, `team-later`, `team-rejected`, `register-clicked`, `payment-error {code}`, `payment-incomplete`.

**Pixel fixes** (`web/src/api/_pixelRules.ts` and `api/_utils.ts`). The pixels are Meta (`1509879429999696` and `1131694104232654`), Google Ads (AW-16660465100, AW-16900819816), GA4 (G-X64YZX0SYB) and Floodlight (DC-15289717). There is no TikTok pixel; `ttclid` is only used for classification.
- Every pixel call is guarded.
- Purchase value is now the real charged price, mirroring the server's price logic (`serverChargedPriceDollars`). Each registration gets its own transaction ID: `team_event`, or `team_rodN_sessionStart` for a Rally on Demand play.
- Floodlight `conve0` sends a real session ID instead of the literal `"[SessionID]"`.
- Meta `CompleteRegistration` fires when an account is verified, with no parameters (`_utils.ts:222,344`).
- Rally on Demand Register clicks now fire Meta "Register Button", Floodlight and AW-16900819816 (`:250-261`).
- `track00` now fires on `/events/<slug>` and Rally on Demand pages; `retar0` fires on the homepage by path.
- Paid Rally on Demand logs `registration-complete` only on success. Payments still needing 3-D Secure are no longer shown as complete.
- The partner (MNI) rule still matches "mni" anywhere. A stricter version (`isMniOriginStrict`) is written but not switched on and needs owner confirmation.

## 4. Internal accounts: how they're identified, where they're excluded, and the gaps

**How an account is identified as internal**
- `isInternalOwner` (`_registrationReport.ts:88-98`): any `user.type` other than `"user"`, or an email containing `"riddlerroadrally"`. The other types are admin, tester, manager, demo, analytics_admin and guest (enum at `schema.ts:351-361`).
- Owner ID 0 is the public guest login and is internal (`:112-116`). A deleted owner counts as external.
- A registration is also excluded if the event is a demo or the team is in-house (`exclusionOf`, `:225-232`).
- For sessions, `isInternalSession` (`_sessionsUtils.ts:779-793`) takes the tab's signed-in email (from the `authorized` event, which fires whenever a signed-in user loads a page: `session.ts:195-205`). Failing that, it uses any email the tab logged (sign-up form, verify, sign-in attempt). It counts as internal if that email belongs to an internal account, contains "riddlerroadrally", or is `"guest"`.
- The list of internal emails comes from `getInternalUsers(all users)`. Its cache key now includes the email, so the cached list refreshes when an email changes (a7a79cc3).

**Where they're excluded: when reports are read, not when data is stored.** Ingest has no staff filter.
- Session cards go through `partitionAndFilterSessions` (`sessions.ts:127-174`).
- Registrations, the accounts funnel and sign-up anchors use `exclusionOf`, `buildPeople().internal` and `buildSignupAnchors` (`_signupSources.ts:260`).
- The per-event roster uses `visibleEventRegistrants` (`_registrationReport.ts:851-869`); the bounce card's "Internal Users" row uses the same rule (`sessions.ts:~1108`).
- One toggle, "Include internal accounts", defaults to off and is deliberately no longer remembered between visits (`index.tsx:100-101`, `_savedFilters.ts`).
- Excluded counts are returned by reason: demo, in-house, internal owner, guest.
- **Before cb6462c1:** session cards dropped only admin and tester, and the per-event roster and registrations-by-day included internal teams on purpose. **After cb6462c1 and a7a79cc3:** one rule applies everywhere. (a7a79cc3 fixed the server ignoring `includeInternal` on the per-event roster, where staff test teams like snowcat92 showed under "Users who are registered".)

**Cleaning historical data**
- Nothing is deleted or rewritten. Because exclusion is evaluated against the *current* user type and email at read time, it applies retroactively: change a person's type in Admin → Users, and every past report recomputes. The plan states this as a caveat: "Type changes apply retroactively" (§8).
- There is no cleanup job, no audit list of excluded sessions, and nothing can clean pixel conversions already sent to Meta or Google.

**Gaps that still let staff or test traffic skew the numbers**
1. **Anonymous staff tabs.** A tab with no email is never internal (`_sessionsUtils.ts:784-786`). Sessions are per tab, there's no device or visitor ID, and no IP is stored, so a staff member's signed-out tabs, incognito tabs and other devices count.
2. **No named list of people.** The only levers are `user.type` and the "riddlerroadrally" substring. Excluding a staff member who uses a personal gmail means changing their role, and roles have product side effects:
   - tester sees demo events and test sessions (`(public).ts:150-156`, `admin/users.ts:310`)
   - manager is treated as staff (`public/_utils.ts:74`)
3. **Never-verified sign-ups** are checked only by the email substring (`_registrationReport.ts:671`; `_signupSources.ts` unverified loop). Staff test sign-ups from gmail addresses count.
4. **Third-party pixels have no staff or `/admin` guard.** GA4, Meta, Google Ads, Floodlight, HubSpot and GTM load for everyone in production, including on admin pages (`pages/admin/[...path].astro` uses `v2/UserLayout`; the only guard at `UserLayout.astro:185-233` is `isProd`). GA4 and Meta numbers include staff, and there is no `traffic_type=internal`.
5. **Bots and forged rows.** Ingest is unauthenticated. The bot heuristic (`_sessionsUtils.ts:2197-2243`) is only reported in the Bounce card, never excluded, and it checks a browser name the client classifies itself, not the raw user agent.
6. **Dev traffic.** The dev filter only checks whether the first row's referrer is localhost (`sessions.ts:62-73,152-156`). Local dev writes to the staging database, so production should be clean (INFERRED).
7. **Mobile app.** It writes no session data. Staff registrations made in the app are excluded only through the team owner's account type.

## 5. The analytics-only admin role (2cbc77d6, narrowed by 5dfdd7d4 and later)

- Added `analytics_admin` to the user type enum (migration `0082_chief_warbound.sql`), to the token and core types, and to the type picker in Admin → Users (shown as a purple "ANALYTICS" badge).
- Backend gate (`(admin).ts:39-54`): admin or analytics_admin may use `/admin/sessions/*`; every other admin route requires admin. It trusts the role in the 2-year login token (gap in §0).
- Web side: the sidebar shows only the Analytics group (`AdminSidebar`). A route guard allows only `/admin`, `/admin/sessions` and `/admin/session-reports/event/:id` (`web/src/util/adminAccess.ts:4-15`, used by `Admin/index.tsx:40` and `AdminRedirect.tsx:27-29`).
- Login sets `isAdmin` true for this role. Christian is user #2472 (plan D1).

## 6. What could become AdminIgloo package features

**Generic, worth building** (for `@adminigloo/analytics`, plus `@adminigloo/permissions` for viewer rules):

1. **Internal-traffic exclusion as one shared rule.** Applied to every report at read time, an "Include internal" toggle that defaults off and isn't remembered, and excluded counts shown by reason. Improve on Road Rally in three ways:
   - Keep the exclusion list separate from product roles: a table of user IDs, emails, email domains and visitor IDs (optionally IP ranges), editable in the admin UI.
   - Set a "this browser is internal" cookie when staff sign in. That covers their anonymous sessions and can suppress third-party pixels or tag GA4 traffic as internal.
   - Drop traffic at ingest from automated browsers (webdriver), localhost and non-production deployments, and support a test flag on orders (trailcards 828485e: `orders.is_test` and `reportableOrder()`).
   - Because the rule runs at read time, cleanup is retroactive: add someone to the list and all history is cleaned. That is exactly Rachel's request.
2. **Session-to-person stitching.** An `identify(userId/email)` call, with tabs linked by email.
3. **First/last-touch capture.** Allowlisted UTMs, click IDs stored as presence only, path only, outside referrer origin only, PII redaction, server re-validation, a 7-day attribution window, and UTMs carried through redirects.
4. **URL privacy scrubber** at both ingest and read (`redactUrlLike` + `holdsEmail`), with the client/server parity test.
5. **Analyst viewer rules.** Salted email masks, free-text scrub, code masking, referrer trimming, a parameter allowlist and no revenue.
6. **Tracker hygiene.** Never throws, works when storage is blocked, forced-increasing timestamps.
7. Dated tracking-change notes and an aggregates-only AI report.
8. The D10 source classifier, including AI-assistant referrers.
9. Business-time-zone day buckets: DST-safe, half-open ranges, edge days dropped.
10. A sign-up funnel skeleton (form submitted → verified → onboarding steps → converted) with backfill-cutoff detection, exposed as a plug-in point for each app.

**Road Rally-specific:** the team owner/teammate groups (a/b/c/d), event-team vs Rally on Demand tables, waiver-based "sign-up started", the migration-0080 cutoff, in-house teams and demo events, guest user 0, the MNI partner rule, the specific Floodlight and Google Ads IDs, the mobile `jwt` hand-off, and the verify-link-to-wizard routing (the idea generalizes, the code doesn't).

## 7. What Riddler Go lacks (`C:\Users\dalli\riddler-go`)

- **No exclusion of internal staff or test users at all.**
  - `analytics_sessions` stores a visitor cookie, source, UTMs, referrer and user agent, but no user ID (`db/schema/analytics.ts:12-33`). Its `organizationId` column is never written (no writer found by grep).
  - The beacon skips only automated browsers and localhost (`lib/tracking/beacon.ts:43-47`) and private paths like `/admin`, `/dashboard`, `/events`, `/play` and `/e/` (`lib/tracking/BeaconClient.tsx:13-30`).
  - So Rachel, staff and the consultant browsing marketing pages count. Server-side funnel events from staff test organizations count too (`checkout_completed` at `lib/billing/checkout.ts:517,705`; `sketch_claimed` and `event_published` likewise).
  - There is no include-internal toggle, no exclusion list, no cleanup, and no test flag on users, organizations or orders (grep of `db/schema` found none).
- **No conversion attribution.** UTMs are kept per 30-minute session only, with nothing stitched to accounts or orders. A first-touch-per-visitor could be computed from the 2-year `rg_visitor` cookie (INFERRED), but it isn't built.
- **No database-backed account → organization → published → paid funnel.** The funnel counts `session_events` within one session (`lib/analytics/queries.ts:733-770`), so it splits whenever a session expires.
- **Already in Riddler Go:**
  - an analytics-only role (`platformRole: "analytics"`, `db/schema/auth.ts:41-48`; `requireStaff({allow:["analytics"]})` at `app/admin/analytics/page.tsx:101`)
  - change annotations stored in the database (`analytics_annotations`), which beats Road Rally's hard-coded notes
  - an AI report, an AI-crawler log and web vitals
  - the automated-browser and localhost ingest guard, which Road Rally lacks
  - PII masking matters less because the analytics tables hold no emails (INFERRED from the schema)
- **A pattern to copy:** 3411fe4 (Play Along, 2026-10-08) already solved the same problem for event participants. It uses one `countedParticipant` / `countedSession` rule (`lib/participants/counted.ts`) plus a test that scans every read. Analytics exclusion should copy that: one rule plus a test that fails if any report query skips it.