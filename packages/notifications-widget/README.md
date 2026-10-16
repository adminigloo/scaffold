# @adminigloo/notifications-widget

The alerts screens for AdminIgloo notifications: the bell in the header with
each person's unread alerts for the company they are working in, the full
alerts page, and Alert settings, where each person chooses how they hear about
each kind of alert and the owner chooses who in the company hears about new
work.

```
<AlertsBell baseUrl="/api/app/{companyId}/alerts" />      the bell, in the header           (./admin)
<AlertsInbox baseUrl="/api/app/{companyId}/alerts" />     the alerts page                   (./admin)
<AlertSettings baseUrl="/api/app/{companyId}/alerts" />   Alert settings                    (./admin)
```

React (18 or 19) is the only peer. Everything styles itself (no Tailwind, no
CSS import) and follows the host page's light or dark theme. Every control is
44 px on a phone and nothing scrolls sideways at 360 px.

It talks to [`@adminigloo/notifications`](../notifications/README.md)'s
`createNotificationHandlers` over a small JSON contract whose types are
declared in this package; it does not import the server package.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/notifications-widget` (entry `.`) | The wire types and `createAlertsClient`, the transport (never throws) | Nothing more: use it from your own components |
| `@adminigloo/notifications-widget/admin` | `<AlertsBell>`, `<AlertsInbox>`, `<AlertSettings>` | The bell in your header, two pages, and the server handlers mounted at one route |
| With `@adminigloo/create-app --notifications` | All of it, wired: the bell in the header, `/app/alerts` and `/app/alerts/settings` | Nothing |

## Install

The package is private, published to GitHub Packages. Add the scope to your
project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

and your token to your **user-level** `~/.npmrc`, never the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```sh
npm install @adminigloo/notifications-widget @adminigloo/notifications
```

## Quick start

Mount the handlers (see the server package's README), then:

```tsx
// in your header (a client or server component: the bundle carries "use client")
import { AlertsBell } from "@adminigloo/notifications-widget/admin";
<AlertsBell baseUrl={`/api/app/${company.id}/alerts`} />

// app/app/alerts/page.tsx
import { AlertsInbox } from "@adminigloo/notifications-widget/admin";
export default function Page() { return <AlertsInbox baseUrl={`/api/app/${companyId}/alerts`} />; }

// app/app/alerts/settings/page.tsx
import { AlertSettings } from "@adminigloo/notifications-widget/admin";
export default function Page() { return <AlertSettings baseUrl={`/api/app/${companyId}/alerts`} />; }
```

## What the screens do

**`<AlertsBell>`**
- A 44 px button with the unread count as a badge (hidden at 0, "99+" past 99).
  Its name says the count: "Alerts, 3 unread".
- The count is fetched on mount, every minute while the page is visible, and
  at once on focus and on coming back to the tab. After 15 minutes with no
  pointer or keyboard input it asks every 10 minutes instead; the first input
  asks at once. An office PC left open all day costs six requests an hour.
- Someone the server refuses (401 or 403) sees no bell at all. A network blip
  keeps the last count.
- Open: the latest 10, "Mark all as read", "See all alerts" and "Alert
  settings". A popover from 640 px; a sheet across the top of a phone (focus
  stays inside, Escape and Close close it).
- Choosing an alert marks it read and opens its page, only if that page is on
  this site. What a customer typed is shown as text, never as a link.
- Two tabs: reading an alert in one tab updates the badge in the other.

**`<AlertsInbox>`**: All / Unread, grouped by day ("Today", "Yesterday",
"Mon, Nov 2"), "Load more", "Mark all as read", a link to Alert settings. The
header's bell follows what is read here.

**`<AlertSettings>`**
1. *How you get each alert*: per kind, "In the app" or "In the app and by
   email". The second is greyed out with the reason when it can't go (no email
   on the site, no address on the account, an alert that is only shown in the
   app, or the email switched off in Messages, with a link there). Changes
   save at once ("Saved."). Alerts the person isn't on the list for are listed
   under "Not on your list". When the owner's emails about new work go to the
   business email in company settings (or the page you name with
   `businessEmailSettings`), the top line and each of those alerts say so.
2. *Who hears about new work* (the owner and admins): per group, "The owner"
   (and where the owner's emails go when that is the business email) or
   "These people", ticked from the company's people, plus up to five
   addresses. When the owner picked "In the app" for one of the group's
   alerts, the card says no email goes out for it, and where that is set. A
   list with nobody ticked says the owner gets those, and where their emails
   go.

Anything the screens can't read (a platform timeout page, a crash) is one
plain sentence, "That didn't go through. Please try again in a minute.", with
"Try again". The status code stays in the `status` of the transport's error,
for logs, never on screen.

## Props

All three take `baseUrl` (where the handlers are mounted) or `transport` (your
own object of the `AlertsTransport` shape), and `theme` (`"auto"` default,
`"light"`, `"dark"`), `nonce` (for a strict CSP), `className`, `style`,
`locale` (for dates). The bell also takes `pollMs` (default 60000; 0 turns
the background poll off).

`<AlertsInbox hideTitle />` and `<AlertSettings hideTitle />` leave their own
heading out, for a page whose header already shows it. On the inbox that also
leaves out its "Alert settings" link (the page header has one); "Mark all as
read" stays.

```tsx
<PageHeader title="Alerts" actions={<Link href="/app/alerts/settings">Alert settings</Link>} />
<AlertsInbox baseUrl={`/api/app/${company.id}/alerts`} hideTitle />
```

`<AlertSettings businessEmailSettings="…" />` names where YOUR app sets the
business email, in a few words, for the three sentences that say the owner's
emails go there. Absent, they say "company settings" (the template's page):

```tsx
<AlertSettings baseUrl={`/api/app/${company.id}/alerts`} businessEmailSettings="Settings → Business profile" />
// "Emails go to office@greenacres.test, the business email in Settings → Business profile."
```

## Theme

Tokens are CSS custom properties prefixed `--ainw-`, declared at zero
specificity, so one rule re-themes the screens:

```css
.ainw-root { --ainw-accent: #7c3aed; --ainw-badge: #b42318; }
```

Every colour pair passes WCAG AA in light and dark. `alertsWidgetCss()` gives
the stylesheet text for a host that renders it itself.

## The transport

```ts
import { createAlertsClient } from "@adminigloo/notifications-widget";
const alerts = createAlertsClient({ baseUrl: "/api/app/c1/alerts" });
const answer = await alerts.count();       // { ok: true, data: { unread, reachable } } | { ok: false, error }
```

`count`, `list`, `markRead`, `markAllRead`, `preferences`, `setPreference`,
`routing`, `setRouting`: one per route. Every call returns its failure
(`network`, `bad_response`, the server's code) instead of throwing.

## Not included (Tenancy 2b-1)

- **Text (SMS) and push alerts.** Alerts come in the app and by email — S9.
- **Turning a kind of alert off.** Each kind comes in the app, or in the app
  and by email; who gets the work alerts is the owner's choice.
- **Alerts from your other companies in the bell.** The bell shows the
  company you're working in.
- **A daily or weekly digest of alerts.**
- **Editing the wording of the team alert email** beyond the Messages screen
  (it is the `team_alert` message there).
- **Carrying 2a's per-feature alert address lists over.** With alerts
  installed, the people (and extra addresses) are chosen again in Alert
  settings; the old lists are no longer read.
- **Alert settings in a single-business project without an admin shell.** Its
  staff get the bell; the office emails keep 2a's lists.
- **Crew alerts when the office moves, reassigns or cancels their visit.**
  Only a customer's change alerts the crew.
- **An alert when a customer opens a quote** (invoices only).
- **Alerts for the platform owner** (a new company, a company out of
  storage). A company's storage refusal is reported in `/admin/errors` once a
  day.
- **Checking an address before it gets a company's alert emails.** The owner
  adds up to five per group; the company's team sending allowance bounds what
  they get.
- **The feedback board per company, and the complete board** — Tenancy 2b-2.
  It will keep screenshots as these private files and send its alerts through
  these notifications. Until then, feedback screenshots stay on the public
  Blob store as in 2a.
- **The AI assistant per company** — Tenancy 2b-3.
- **Website analytics, SEO/AEO and book-a-call (booking) per company** —
  Tenancy 2b-4.
