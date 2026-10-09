# @adminigloo/audience

Keep your own people out of your numbers, and clean up the numbers they already polluted.

Staff browsing the site, the client's consultant, test sign-ups, end-to-end runs, uptime monitors and preview deployments all count as visitors unless something stops them. This package decides **who does not count** and applies that decision to history:

- **Rules** name who is internal: a person (by user id or email), an email domain or pattern, an org, a test event or order, a device, an office network, a production host, an automation user agent. Your app's own rule in code (`isInternal(user)`) sits beside them.
- **Marks** record what does not count: a visitor, a user, an org, an event, an order or a single session. A report leaves marked rows out with a `NOT EXISTS` anti-join. **Your analytics rows are never rewritten or deleted.**
- That is why history can be cleaned. Adding a person excludes their past visits at once (on the devices they were signed in on, with a stable visitor id: see [Your visitor id must be stable](#your-visitor-id-must-be-stable)), and removing the rule restores the numbers exactly. Every report can say `Excluded: 312 sessions (staff 200, named person 100, automation 12)`.

It ships five entry points:

| Entry | What it is | Runs |
| --- | --- | --- |
| `@adminigloo/audience` | Everything in `./core`, plus the default Drizzle Postgres store, the anti-join as Drizzle `sql`, a schema for the add-rule form, and the license gate | Server |
| `@adminigloo/audience/core` | The rule model, the classifier, normalisation, masking, SQL text builders, in-memory read helpers, the `AudienceStore` interface and `createAudience` over any store. No peer dependency at all | Server (any database) |
| `@adminigloo/audience/schema` | `defineAudienceTables({ prefix })`: the four Drizzle tables to add to your schema and migrate | Server |
| `@adminigloo/audience/ui` | `IncludeInternalToggle`, `ExcludedNote`, `AudienceRulesPanel`, `MarkThisBrowserButton`, `UnfilteredSourcesNote`. React, `"use client"`, display only | Browser |
| `@adminigloo/audience/testing` | `assertCountedReads`: a test that fails the build when a file reads your analytics tables without the counted predicate | Test runner |

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/audience` + `./schema` (Drizzle + Postgres) | Rules, the classifier and defaults, the four tables, intake (`observe`, `classifyActor`), `preview` → `apply` → `remove`, `mark` / `unmark`, `backfill`, `maintain`, `excludedBreakdown`, `countedVisitorSql` / `countedSubjectSql`, device links, server-side masking (`viewModel`) | One additive migration (generate it with drizzle-kit, run it yourself); `AUDIENCE_SECRET`; a call to `observe()` in your beacon route (with the session id and the request headers) and `classifyActor()` in your server-side event writer; `countedVisitorSql(...)` with `time` and `session` added to each report query; `listUsers` over your users table (with each user's `orgIds` if you use org rules); a daily call to `maintain()` |
| `+ ./ui` | The five admin components, styled, accessible, themeable | A page (your auth decides `canEdit` and `canSeeEmails`), and the callbacks: server actions, tRPC or fetch handlers that call the server functions above and return `{ error }` for a refusal |
| `+ ./testing` | `assertCountedReads` | One test file naming your tables, the predicate and any exemptions, each with its reason |
| `./core` only (MySQL, no Drizzle, not React) | Everything that is not Postgres-specific: rules, classifier, `createAudience` over any store, SQL text with `?` placeholders, `indexMarks` / `excludedReasonOf` for sessions built in JavaScript | An `AudienceStore` over your own driver (11 methods, plus 2 optional ones whose queries come ready-made from `countRowsParts` / `breakdownParts`), and your own four tables. See [Not on Drizzle](#not-on-drizzle-road-rally) for the two rules a store must keep |

### Not included

Say these out loud before anyone assumes otherwise:

- **No analytics.** This package does not collect visits. It has no beacon, no sessions table and no reports of its own. It filters the analytics you already have. `@adminigloo/analytics` 0.1 does not use it yet and cannot be wired to it as it stands: its handler does not tell the app the visitor key or session id, and its reports have no place for the predicate. That needs analytics 0.1.1 or 0.2.
- **Numbers kept outside your app cannot be cleaned:** Google Search Console, AI answer engines (AEO citations), the Stripe and Clerk dashboards, Resend open rates, Vercel Analytics, digests already emailed, and ad-network conversions (Meta, Google Ads, Floodlight). `UnfilteredSourcesNote` labels them on screen. Ad pixels can only be prevented at the source, and 0.1 has no pixel-suppression helper.
- **Network, host and user-agent rules cannot reach back.** IP addresses, hosts and user agents are never stored, so these rules apply to new visits only. Preview says so.
- **Test event and test order rules do not change session counts.** They mark the event or order itself, for event and order counts. The package cannot tell which past visits touched one.
- **No drop-at-intake.** The package tags; it never stops your beacon from writing a row. Drop privacy opt-outs and (if you want) non-production traffic yourself, before you write.
- **No MySQL store.** `./core` defines the interface; Road Rally's store is a later release.
- **No auth or roles.** You decide who may edit (`canEdit`) and who sees emails (`viewModel({ canSeeEmails })`).
- **No routes, no cron, no migration files.** You call the functions from your own server actions, jobs and drizzle-kit setup.
- **No link retention.** Visitor-to-user links are kept until you delete them (`last_seen` tells you how old each is).
- **No browser-side device storage.** "Mark this browser" uses the visitor cookie your app already sets.

## Install

The package is private, published to GitHub Packages. Add the scope to your project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

Your token goes in your **user-level** `~/.npmrc`, never in the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
npm install @adminigloo/audience@0.1.0   # pin exactly
```

Every place that installs needs the token: on Vercel, an `NPM_RC` environment variable holding both lines; in GitHub Actions, `NODE_AUTH_TOKEN` through `actions/setup-node`. Without it the install fails with `401 Unauthorized`.

Peer dependencies: `drizzle-orm ^0.45` and `zod ^3.25 || ^4` for the root entry; `react ^18 || ^19` for `./ui`. `./core` needs none of them. The one dependency, `@adminigloo/license`, is small (it peers on zod). The schema's published type (`RuleDraftSchema`) names no zod type, so it reads the same on zod 3 and zod 4.

Environment: `AUDIENCE_SECRET`, at least 32 characters and not a placeholder (`openssl rand -base64 48`). It keys the visitor-to-user links, signs device links and derives the smoke-test header. To rotate it, set the new value and pass the old one in `previousSecrets: [old]`: links made under the old secret are still found, new ones use the new secret, and every outstanding device link stops working.

## How it decides

### Rule kinds

| Kind | Matches | Reaches back in time? |
| --- | --- | --- |
| `user` | One user id (Rachel's "list of people") | Yes, through the visitor→user links |
| `email` | An exact address, trimmed, Unicode-normalised and lower-cased. Gmail dots and `+tags` are folded (`J.Doe+x@gmail.com` = `jdoe@gmail.com`); other providers are left alone | Yes |
| `email_domain` | A domain and its subdomains (`riddlergo.com`, `mail.riddlergo.com`), never a lookalike. Unicode and punycode spellings match | Yes |
| `email_pattern` | Text inside the address (`+clerk_test`, `riddlerroadrally`), or a glob with `*` and `?` | Yes |
| `org` | An org id: a staff workspace, a demo org. Its **members** are internal | Yes, through members' devices, when `listUsers` returns each user's `orgIds` |
| `event` | A test event | The event itself (event counts); not sessions |
| `order` | A test order | The order itself (order counts); not sessions |
| `visitor` | One device ("Mark this browser", or a signed `?internal=<token>` link) | Yes, for that device |
| `network` | A CIDR range (IPv4 or IPv6) | **New visits only.** IPs are never stored |
| `host` | A host that **is** production. Once any exists, every other host counts as non-production. List the apex and `www` both | New visits only |
| `user_agent` | Text inside an automation user agent | New visits only |

Alongside the stored rules, your code rule `isInternal(user)` returns a label ("staff") for an internal user and `false` for everyone else. The panel shows it read-only (`codeRule`).

### What a verdict marks

Each reason marks what it is about, so one odd visit never wipes a customer's history:

| Reason | Marks | So |
| --- | --- | --- |
| `role`, `named_user`, `email`, `domain`, `pattern`, `org` (about the person) | The device (all its history) and the user | A staff member signed out on the same laptop stays excluded |
| `device` (a `visitor` rule) | The device | |
| `automation`, `bot`, `non_production`, `network` (about one request) | The **session** you pass as `sessionId` | A customer who loads the site once from the office network keeps the rest of their history. **Without `sessionId` these fall back to marking the whole device**, so always pass it |
| `event`, `order` (a test event or order acted on) | The session, when you pass one; never the device | A customer who touched a test event is still a customer |

A host-list miss belongs to the `host` rules that caused it, so removing a mistyped rule (`www.` listed, the apex forgotten) counts those visits again.

### Defaults (no configuration)

- **Test sign-ups:** addresses containing `+clerk_test@` or `+test@`.
- **Reserved domains:** `example.com`, `example.org`, `example.net`, and `*.test`, `*.invalid`, `*.localhost`.
- **Non-production:** `localhost`, `127.0.0.1`, `::1`, `*.localhost`, `*.vercel.app`, plus `nonProduction: true` from the app. Use `isNonProductionEnv()`, which **fails open**: only `VERCEL_ENV` set to something other than `production`, or `NODE_ENV=development`, says "not production". If your production site really is served from `*.vercel.app`, add it as a `host` rule or in `productionHosts`.
- **Automation:** HeadlessChrome, Playwright, Puppeteer, Selenium, PhantomJS, Cypress, Lighthouse and PageSpeed, GTmetrix, UptimeRobot, Checkly, Pingdom, StatusCake, Datadog and New Relic synthetics, Site24x7, Better Uptime, Vercel's screenshot bot; `navigator.webdriver` when the beacon reports it; and the smoke-test header `x-aig-audience`. Its value is **derived from `AUDIENCE_SECRET`**, not a public word: your smoke suite reads it from `audience.testHeader` (or `testHeaderValueFor(secret, tenantId)`). Set `testHeader: { value }` to choose your own, or `false` to turn it off.
- **Bots** are counted under their own reason, `bot`, and never as "internal".

Each group can be switched off: `defaults: { hosts: false }`, or `defaults: false` for all of them.

### Precedence

When several reasons apply, the first one wins, so each session is counted under exactly one reason and the per-reason numbers add up to the total:

`bot` > `automation` > `non_production` > `role` (your callback) > `named_user` > `email` > `domain` > `pattern` > `org` > `event` / `order` > `device` > `network` > `manual`

One exception in detection, not in ranking: a user agent on the automation list is never also called a bot. An uptime monitor (`UptimeRobot/2.0`) is `automation`. A crawler that also reports `navigator.webdriver` is `bot`.

### Your visitor id must be stable

Everything that "reaches back" works through the visitor id your app already stores on each session:

- **A first-party cookie** (Riddler Go's two-year `rg_visitor`): naming a person excludes their past visits on every device they signed in on, "Mark this browser" lasts as long as the cookie, and a staff member who signs out stays excluded on that device.
- **A cookieless key that changes daily** (`@adminigloo/analytics` 0.1: an HMAC of IP, user agent and a daily salt): a person rule reaches only the days that person was signed in; their anonymous visits on other days stay counted. A visitor mark also catches everyone sharing that key that day (coworkers behind one office address, same browser). Set `visitorIds: "rotating"`: `markVisitor` and device links then refuse (a browser cannot be marked for good) and preview says how far a rule reaches.

## Privacy: exactly what is stored

| Table (`aig_audience_…`) | Holds | Never holds |
| --- | --- | --- |
| `rules` | What an admin typed, normalised (a lower-cased email, a bare domain, a canonical CIDR), a label, a note, who and when | Anything about visitors |
| `marks` | A subject id (your visitor cookie value, user id, org/event/order id or session id), the reason, the rule, who, when, when cleared | IPs, user agents, hosts, emails |
| `links` | Your visitor id and `HMAC-SHA256(AUDIENCE_SECRET, tenant ‖ userId)`, first and last seen | The user id itself, an email, an IP |
| `runs` | Each apply, remove, backfill and hand mark: counts, date range, who, the summary sentence | Free-text labels and notes; email addresses, patterns and single IP addresses appear only masked |

**There is no IP column anywhere.** Network rules are matched in memory during `observe()`, then the address is dropped.

**Link modes.** A link is pseudonymous personal data, not anonymous: anyone holding the secret and your user list can recompute it (that is how a rule finds a person's devices).

- `"internal-only"` (the default) writes a link only while a signed-in user is internal. A person named later reaches only devices they used while already internal; their earlier anonymous visits stay counted. Preview says so.
- `"pseudonymous"` writes a link for every signed-in visitor: visitor id plus the HMAC, nothing else. This is what lets a person added later reach their anonymous past. Recommended for Riddler Go, which already keeps a two-year visitor cookie.
- A link that has stopped being true (someone left the staff, a rule was removed) is kept; links are never pruned by the package.

**Global Privacy Control and Do Not Track.** A link is written only when the call says the browser did not opt out: pass the request `headers` (or `privacyOptOut: false` from your own check) to `observe` and `classifyActor`. With neither, no link is written. Drop opted-out beacons entirely (`isPrivacyOptOut(headers)`). Expect that to lower your counts: Brave sends `Sec-GPC: 1` by default.

**Masking:** the analytics role should see `j***@gmail.com · 3f9a`, never an address. The tag is an HMAC under a salt made fresh per response, so it tells two people apart on one screen but cannot be joined across exports. Mask on the server with `audience.viewModel({ canSeeEmails: false })`: it also shortens user and device ids, email patterns (`rac••• · 3f9a`) and single-address networks (`73.12.•••/32`). The panel masks by default when `canEdit` is false; its `maskEmails` prop only changes what is drawn, and an address that reaches the browser is readable in devtools. `classifyActor()` and `explain()` return each match's `detail`, which can hold a rule's full value: mask it before you show it to anyone.

**Annotations** (the dated notes on your trend chart, which analysts and the digest read) never carry a rule's label or note: `Internal rule added (person (email) r***@gmail.com): 57 sessions excluded back to 2026-06-10`.

## Wiring it into an app (Riddler Go shape)

### 1. Tables and the instance

```ts
// db/schema/audience.ts — spread into your Drizzle schema, then `drizzle-kit generate`
export { audienceRules, audienceMarks, audienceLinks, audienceRuns } from "@adminigloo/audience/schema";
```

```ts
// lib/analytics/audience.ts
import "server-only";
import { eq } from "drizzle-orm";
import { createAudience, createDrizzleAudienceStore } from "@adminigloo/audience";
import { db } from "@/db/client";
import { organizationMembers, users } from "@/db/schema/auth";
import { analyticsAnnotations } from "@/db/schema/annotations";

type AppUser = { id: string; email: string | null; platformRole: string | null; orgIds?: string[] };

async function orgIdsByUser(): Promise<Map<string, string[]>> {
  const rows = await db.select({ userId: organizationMembers.userId, orgId: organizationMembers.organizationId }).from(organizationMembers);
  const out = new Map<string, string[]>();
  for (const { userId, orgId } of rows) out.set(userId, [...(out.get(userId) ?? []), orgId]);
  return out;
}

export const audience = createAudience<AppUser>({
  store: createDrizzleAudienceStore({ db }),
  secret: process.env.AUDIENCE_SECRET!,
  link: "pseudonymous",
  isInternal: (user) =>
    user.platformRole && ["super", "staff", "analytics"].includes(user.platformRole) ? `platform role: ${user.platformRole}` : false,
  codeRule: "Platform role is super, staff or analytics",
  // orgIds let an org rule reach its members, at intake and in history.
  listUsers: async () => {
    const orgs = await orgIdsByUser();
    const rows = await db.select({ id: users.id, email: users.email, platformRole: users.platformRole }).from(users);
    return rows.map((user) => ({ ...user, orgIds: orgs.get(user.id) ?? [] }));
  },
  getUser: async (id) => {
    const [user] = await db.select({ id: users.id, email: users.email, platformRole: users.platformRole }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return null;
    const memberships = await db.select({ orgId: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, id));
    return { ...user, orgIds: memberships.map((m) => m.orgId) };
  },
  sessions: { table: "analytics_sessions", visitor: "visitor_id", time: "created_at", id: "id" },
  annotate: ({ day, label }) => db.insert(analyticsAnnotations).values({ date: day, label, kind: "note" }),
  license: {
    key: process.env.ADMINIGLOO_LICENSE_KEY,
    publicKey: process.env.ADMINIGLOO_LICENSE_PUBLIC_KEY,
    mode: process.env.ADMINIGLOO_LICENSE_MODE as "off" | "warn" | "enforce" | undefined,
  },
});
```

`getUser` answers are cached per server instance for a minute (`userCacheMs`), so a staff member's 200 page views cost one lookup.

### 2. Intake

```ts
// app/api/beacon/route.ts
import { after } from "next/server";
import { isNonProductionEnv, isPrivacyOptOut } from "@adminigloo/audience";

if (isPrivacyOptOut(req.headers)) return new NextResponse(null, { status: 204 }); // drop, don't tag
// … resolveOrCreateAnalyticsSession(...) as today, then:
const { userId } = await auth();
after(() =>
  audience.observe({
    visitorId,
    sessionId: session.id,            // the analytics_sessions row just resolved: visit-only reasons mark it alone
    userId,                           // getUser() turns it into the user for isInternal, email and org rules
    url: req.headers.get("referer"),  // the page's host is checked
    headers: req.headers,             // user agent, x-forwarded-for (network rules), the smoke-test header, GPC/DNT
    nonProduction: isNonProductionEnv(),
  }),
);
```

```ts
// lib/tracking/server-events.ts — inside recordServerEvent, after reading the visitor cookie
const { userId } = await auth();
const requestHeaders = await headers();
after(() => audience.classifyActor({ userId, visitorId, headers: requestHeaders }));
// the event is still written; a staff member's visitor stops counting
```

`observe()` and `classifyActor()` never throw. A database failure degrades to "counted, defaults still apply" and is reported through `onError`.

### 3. Every report query

```ts
// lib/analytics/queries.ts
function inWindow(w: EffectiveWindow, includeInternal = false): SQLWrapper {
  return sql`s.created_at >= ${w.from} AND s.created_at < ${w.to}
    AND ${audience.countedVisitorSql("s.visitor_id", { time: "s.created_at", session: "s.id", includeInternal })}`;
}
```

- `time` and `session` are **required**. Without `time`, a rule's "only from" date would be ignored here while `excludedBreakdown` honours it, and "Excluded: N" would stop matching the report. Without `session`, visits marked on their own (automation, a network rule) would count. Pass `null` for either only when the read truly has no such column.
- Columns must be qualified with your alias (`s.visitor_id`, not `visitor_id`): inside the anti-join a bare `id` would resolve to the marks table's own column and silently turn exclusion off. The package refuses bare names.
- A read that is not on the sessions table joins through it. Web Vitals over `session_events e`: `countedVisitorSql(sql\`(SELECT s2.visitor_id FROM analytics_sessions s2 WHERE s2.id = e.analytics_session_id)\`, { time: "e.created_at", session: "e.analytics_session_id" })`.
- `includeInternal` comes from the URL (`readIncludeInternal(searchParams)`) and is never stored. With it on, the fragment is `(1 = 1)`.
- Platform counts use the subject form: `WHERE ${audience.countedSubjectSql("org", "o.id")}`. If your id column is a `uuid`, pass `castToText: true`.
- If your sessions table is shared by several tenants or environments, give `sessions.where` (`{ tenant_id: "site" }`) so preview and the breakdown count only yours.

### 4. The admin page

A thrown server-action error reaches the browser as Next's generic "An error occurred in the Server Components render" in production, so the admin would never read why a rule was refused. Catch `AudienceError` and **return** `{ error }`; every component shows it.

```tsx
// app/admin/analytics/audience/actions.ts
"use server";
import { isAudienceError, ruleDraftSchema } from "@adminigloo/audience";
import { requireStaff } from "@/lib/staff/auth";

async function attempt<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (isAudienceError(error)) return { error: error.message };
    throw error;
  }
}

export async function previewRule(input: unknown) {
  await requireStaff(); // super and staff only
  const parsed = ruleDraftSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the rule's fields." };
  return attempt(() => audience.preview(parsed.data));
}
export async function addRule(input: unknown) {
  const me = await requireStaff();
  const parsed = ruleDraftSchema.safeParse(input);
  if (!parsed.success) return { error: "Check the rule's fields." };
  return attempt(async () => {
    const { applied } = await audience.addRule(parsed.data, { by: me.email });
    revalidatePath("/admin/analytics/audience");
    return { annotation: applied?.annotation ?? null };
  });
}
export async function removeRule(ruleId: string) {
  const me = await requireStaff();
  return attempt(async () => {
    const { annotation } = await audience.remove(ruleId, { by: me.email });
    revalidatePath("/admin/analytics/audience");
    return { annotation };
  });
}
export async function markThisBrowser() {
  const me = await requireStaff(); // an edit: not the analytics role (their devices are marked by the code rule)
  const visitorId = (await cookies()).get("rg_visitor")?.value;
  return attempt(() => audience.markVisitor({ visitorId: visitorId ?? "", by: me.email }));
}
```

```tsx
// app/admin/analytics/audience/page.tsx (server component)
const me = await requireAnalyticsViewer(); // your guard for super, staff or analytics
const canEdit = me.platformRole !== "analytics";
const view = await audience.viewModel({ canSeeEmails: canEdit }); // masked on the server for analysts
return (
  <>
    <AudienceRulesPanel rules={view.rules} runs={view.runs} codeRule={view.codeRule} canEdit={canEdit}
      onPreview={previewRule} onAdd={addRule} onRemove={removeRule} />
    {canEdit ? <MarkThisBrowserButton onMark={markThisBrowser} /> : null}
    <UnfilteredSourcesNote />
  </>
);
```

On each report card:

```tsx
const excluded = await audience.excludedBreakdown({ from, to });
<ExcludedNote excluded={excluded} includeInternal={includeInternal} />
<IncludeInternalToggle value={includeInternal} href={includeInternalHref(currentUrl, !includeInternal)} />
```

The toggle is a real link and works as-is. For client-side navigation, wrap it in a small `"use client"` component that passes `onNavigate={router.push}` (a server component cannot pass a function). The toggle follows only a path, a query, a fragment or an http(s) URL.

The digest and the AI report use the same words on the server: `excludedSentence(excluded)` from the package root (not from `./ui` — a function exported from a `"use client"` module is not callable in server code).

### 5. The daily job

```ts
await audience.maintain();
```

It clears marks a removed rule left behind (see [Several server instances](#several-server-instances)), re-applies every rule (catching devices linked since), and marks everyone `isInternal` names, with their devices. Run it inside the existing `analytics-digest` cron or its own daily job.

People who leave the staff keep their marks by default: their browsing while on staff was internal, and clearing the mark would count it again. `maintain({ pruneRoleMarks: true })` clears the code rule's marks for anyone it no longer names (and their devices). Use that when "left the team" should mean "never internal"; otherwise restore one person by hand (below).

## Cleaning history

```ts
const preview = await audience.preview({ kind: "email", value: "rachel@gmail.com" });
// preview.windows: last 30 days / 90 days / all time — sessions now, would exclude, after. Writes nothing.
const { applied } = await audience.addRule({ kind: "email", value: "rachel@gmail.com", reasonLabel: "Client" }, { by: "dallin" });
// applied.annotation: "Internal rule added (person (email) r***@gmail.com): 57 sessions excluded back to 2026-06-10"
await audience.remove(applied.rule.id, { by: "dallin" }); // the numbers are back exactly
```

- `apply` is idempotent: a second run writes nothing, and a repeat that finds nothing new writes no second run row and no second annotation (`run: null`). It writes in batches, leaves a run row, and calls `annotate`.
- `remove` disables the rule and sets `cleared_at` on that rule's marks only. Marks made by your callback, a default, by hand or by another rule stay. The remaining rules are then re-applied to whatever lost a mark. If a remove fails half-way, running it again finishes the job. Nothing is ever deleted.
- `appliesFrom` keeps sessions before a date counted (someone who became staff in July).
- `backfill(adapter)` reaches history the links table cannot, through joins only your app knows. The adapter yields subjects plus the actor behind them, and the package judges each with the same rules and callback as intake. Run it with `{ dryRun: true }` first and review the counts: `subjectsChanged` (subjects newly excluded) means the same in the dry run and the real one; `marksWritten` is the row count.

```ts
await audience.backfill({
  name: "checkout_completed → orders.purchased_by",
  async *candidates() {
    for (const e of await checkoutEventsWithBuyers()) yield { subjectKind: "visitor", subjectId: e.visitorId, actor: { userId: e.purchasedBy } };
  },
}, { by: "dallin", dryRun: true });
```

- **Marking by hand:** `audience.mark({ subjectKind: "order", subjectId, by })`. A user's linked devices are marked with them.
- **Restoring a real customer** a default, the code rule or a visit-only fact wrongly excluded (a staffer signed in on their phone to help them, a false automation hit): `audience.unmark({ subjectKind: "user", subjectId, by, sources: "all" })` clears every mark on them and their linked devices, with a run row. By default `unmark` clears only hand marks. A rule that still names them marks them again: remove the rule for that.
- **Device links:** `audience.createDeviceLink({ by, baseUrl, maxDevices })` returns `https://site/?internal=<token>`, good for 30 days and at most `maxDevices` browsers (default 5). The maker's address is encrypted inside the token, not readable from it. Your route calls `audience.redeemDeviceLink(token, { visitorId })` for the browser that opens it, then **redirects at once to the same URL without `?internal=`** (and keeps that route out of your beacon and pixels), so the token does not end up in page-view URLs, Referer headers or history. A redemption adds a run row but no chart annotation. To revoke the browsers one link marked, remove the device rules whose note is `device link <linkId>`; to revoke every outstanding link, rotate the secret.

## Several server instances

Each instance caches the active rules for `rulesCacheMs` (default one minute). After a rule is added or removed, another instance can go on classifying with the old list for up to that long. It cannot leave anything behind: the store refuses a mark that names a removed rule (checked in the same statement, with the rule row locked), and `maintain()` clears any such mark a custom store let through. `invalidate()` drops one instance's caches at once.

## The guard test

An exclusion is only as good as the read that forgets it. This test fails the build when a file reads your analytics tables without the predicate, unless an exemption says why:

```ts
// lib/__tests__/internal-audience.test.ts
import { assertCountedReads } from "@adminigloo/audience/testing";

it("every analytics read leaves the internal audience out", () => {
  assertCountedReads({
    roots: ["app", "lib"],
    tables: ["analytics_sessions", "page_views", "session_events"], // also matches analyticsSessions, pageViews, …
    predicates: ["countedVisitorSql", "countedSubjectSql"],          // the package's own names only
    exempt: {
      "lib/tracking/analytics-session.ts": "the writer: buckets a visit into its own session",
      "app/api/beacon/route.ts": "the writer: records the visit the report later filters",
      "lib/tracking/server-events.ts": "the writer: records the funnel event the report later filters",
    },
    expectReaders: ["lib/analytics/queries.ts"], // proves the detector is not matching nothing
  });
});
```

- Name only the package's functions as predicates, never your own helper (`inWindow(`): the helper's own definition contains its name, so the file defining it would always pass even if the helper stopped calling the package.
- The check is **per file**. A file that uses the predicate once passes even if another query in it does not (Riddler Go's `getWebVitals` sits in `queries.ts` beside `inWindow`). Review each query in a reader file, or move unfiltered reads into their own file.
- It also fails on stale exemptions (the file is gone or no longer reads the tables) and on reasons too short to mean anything. Never filter AI spend and usage, capacity, audit and security logs, error monitoring or rate limits: exempt them, with the reason.

## Theming the components

The components inject one stylesheet (`<style data-href="aiu-styles">`, server-rendered on React 19). Every class is `aiu-` prefixed, and every colour is a custom property declared under `:where(.aiu-root)`, so any rule of yours wins:

```css
.aiu-root { --aiu-accent: #5b21b6; --aiu-accent-strong: #4c1d95; }
```

Tokens: `surface`, `surface-2`, `ink`, `ink-muted`, `edge`, `line`, `accent`, `accent-strong`, `accent-soft`, `on-accent`, `danger`, `danger-soft`, `warn-ink`, `warn-soft`. A unit test measures every text and control-edge pair at WCAG AA in both themes. `theme="light" | "dark" | "auto"` (the default follows the OS). Every control is a 44px target, forced-colours mode is supported, and a browser test runs axe on each component.

## Not on Drizzle (Road Rally)

Import `@adminigloo/audience/core`. Implement `AudienceStore` over your driver; the two queries that touch your sessions table come ready-made:

```ts
import { breakdownParts, countRowsParts, renderSql, countedVisitorClause } from "@adminigloo/audience/core";
const { sql, params } = renderSql(countRowsParts({ tenantId, rows, visitorIds, countedOnly: true, dialect: "mysql" }), { placeholder: "?" });
const counted = countedVisitorClause("s.visitor_id", { tenantId, dialect: "mysql", time: "s.created_at", session: "s.id" });
// { sql: "(NOT EXISTS (…) AND NOT EXISTS (…))", params }
```

A store must keep two rules the Postgres one keeps with a partial unique index and a locked check:

- **One active mark per (tenant, subject, rule or reason).** MySQL has no partial index: add a generated column, `active_key VARCHAR(512) AS (IF(cleared_at IS NULL, CONCAT_WS('|', tenant_id, subject_kind, subject_id, COALESCE(rule_id, reason)), NULL))`, with a `UNIQUE` index on it (NULLs never collide), and insert with `INSERT IGNORE`.
- **No active mark for a disabled rule:** `INSERT … SELECT … WHERE rule_id IS NULL OR EXISTS (SELECT 1 FROM rules WHERE id = rule_id AND disabled_at IS NULL)`. InnoDB's `INSERT … SELECT` already share-locks the rule rows it reads.

Identifiers use each dialect's own quoting: backticks for MySQL, double quotes for Postgres. User ids may be numbers; they are compared and stored as their digits.

If your sessions are built in JavaScript (Road Rally's `_sessionsUtils.ts`), skip the SQL and ask each row:

```ts
import { excludedReasonOf, indexMarks } from "@adminigloo/audience/core";
const index = indexMarks(await store.listMarks(tenantId, { active: true }));
const reason = excludedReasonOf(index, { at: session.startedAt, visitorId, sessionId, userId: account.id });
// null: counts. Otherwise the best reason by precedence, honouring "only from" dates.
```

## License gate

`license: { key, publicKey, mode }` checks feature `"audience"` with `@adminigloo/license`. It guards the cleaning work (`preview`, `addRule` and `markVisitor`, `apply`, `mark`, `backfill`, `maintain`), which throws `AudienceError` `unlicensed` (402). It never guards intake, reports, `remove` or `unmark`: a lapsed license must not start counting staff again or stop anyone undoing a rule. The default mode `"off"` never denies. The gate is wired by the root entry's `createAudience`; `./core`'s `createAudience` runs ungated unless you pass `licenseGate` yourself (the same opt-in as the other AdminIgloo packages).
