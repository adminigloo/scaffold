# @adminigloo/tenancy-widget

The screens for AdminIgloo companies: a new owner names their company and lands in
it, switches between the companies they belong to, works through a setup
checklist, runs their team (invite, change a role, remove, leave, hand over
ownership) and fills in the company's details, logo and colour. The platform's own
staff get an operator console: every company, its detail, suspend and reactivate,
and who on the team is staff at what level.

```
<Onboarding baseUrl="/api/tenancy" />                         "What's your company called?"
<CompanySwitcher baseUrl="/api/tenancy" session={s} />        the header switcher
<SetupChecklist baseUrl="/api/tenancy" tenantId={id} />       what's left to set up
<TeamManager baseUrl="/api/tenancy" tenantId={id} />          invite, roles, remove, leave, transfer
<CompanySettings baseUrl="/api/tenancy" tenantId={id} />      name, web address, logo, colour, details
<CompanySuspended companyName="…" />                          the plain "this company is suspended" screen
<AcceptInvitation baseUrl="/api/tenancy" token={t} … />       the page behind an invitation email
<CompanyBrandBar company={c} />                               a company's public face (logo, name, contact)
<CompanyUnavailable company={c} />                            "isn't taking requests online right now"

<CompaniesConsole baseUrl="/api/admin/tenancy" />                  every company        (./admin)
<CompanyDetail baseUrl="/api/admin/tenancy" tenantId={id} />       one company          (./admin)
<StaffPeople baseUrl="/api/admin/tenancy" />                       staff roles          (./admin)
```

React (18 or 19) is the only required peer; `@adminigloo/tenancy` ^0.5.0 is an
optional peer, so installing the widget beside an older server warns at install
time instead of failing on every call. Everything styles itself (no Tailwind, no
CSS import) and follows the host page's light or dark theme.

It talks to `@adminigloo/tenancy` 0.5's HTTP handlers (`createTenancyHandlers` for
the company screens, `createTenancyOperatorHandlers` for the console) over a small
JSON contract. The contract's types are declared in this package as well; it does
**not** import the server package at runtime, so a page that only renders the
header switcher installs nothing but this.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/tenancy-widget` | `<Onboarding>`, `<CompanySwitcher>`, `<SetupChecklist>`, `<TeamManager>`, `<CompanySettings>`, `<CompanySuspended>`, `<AcceptInvitation>`: a business owner signs up, names the company, invites the team and sets it up, with every rule (who may change whom, seats, the owner who can't leave) enforced by the server. | The pages that render them, and `@adminigloo/tenancy/server`'s `createTenancyHandlers` mounted at one route behind your sign-in. |
| `@adminigloo/tenancy-widget/admin` | `<CompaniesConsole>`, `<CompanyDetail>`, `<StaffPeople>`: search and page through every company, see one company's people and recent activity, suspend or reactivate it, and give or take staff roles. | Three admin pages, and `createTenancyOperatorHandlers` mounted at one route. |
| `@adminigloo/tenancy` (the server, required) | The tables, the lifecycle (create, join, roles, removal, transfer, suspension), the settings registry, the checklist registry and both handler factories. | The service construction (database, mode, catalog, audit sink). See its README. |

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

Then:

```sh
npm install @adminigloo/tenancy-widget @adminigloo/tenancy   # pnpm add / yarn add work the same
```

Without the `.npmrc` line npm looks on npmjs.org and answers 404.

## Quick start: a Next.js app

Mount the handlers (the service options are in `@adminigloo/tenancy`'s README):

```ts
// app/api/tenancy/[...path]/route.ts
import { createTenancyHandlers } from "@adminigloo/tenancy/server";
import { tenancy, requestPrincipal, verifiedEmails, invitationUrl } from "@/server/tenancy";

const { handle } = createTenancyHandlers({ tenancy, principal: requestPrincipal, verifiedEmails, invitationUrl });
export const GET = handle;
export const POST = handle;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

```ts
// app/api/admin/tenancy/[...path]/route.ts
import { createTenancyOperatorHandlers } from "@adminigloo/tenancy/server";
import { tenancy, requestPrincipal } from "@/server/tenancy";

const { handle } = createTenancyOperatorHandlers({ tenancy, principal: requestPrincipal });
export const GET = handle;
export const POST = handle;
```

Then the pages. The components are client components (the bundle carries
`"use client"`), so a server page renders them directly and hands them what it
already resolved, so the first paint is the real screen, not a spinner:

```tsx
// app/onboarding/page.tsx
import { Onboarding } from "@adminigloo/tenancy-widget";
import { sessionToWire } from "@adminigloo/tenancy/server";

export default async function Page() {
  const session = await tenancy.resolveSession({ userId, verifiedEmails: await verifiedEmails() });
  return <Onboarding initialSession={sessionToWire(session)} baseUrl="/api/tenancy" publicUrlPrefix="https://app.example.com/t/" />;
}
```

```tsx
// the header
<CompanySwitcher session={sessionToWire(session)} baseUrl="/api/tenancy" />

// app/dashboard/page.tsx: the active company's id comes from YOUR server page
<SetupChecklist baseUrl="/api/tenancy" tenantId={company.id} />

// app/settings/team/page.tsx
<TeamManager baseUrl="/api/tenancy" tenantId={company.id} />

// app/settings/company/page.tsx
<CompanySettings baseUrl="/api/tenancy" tenantId={company.id} publicUrlPrefix="https://app.example.com/t/" />

// app/invite/[token]/page.tsx (signed in)
<AcceptInvitation baseUrl="/api/tenancy" token={token} signedInAs={principal.email} />

// any company page, when the session says "suspended"
<CompanySuspended companyName={session.company.name} companies={session.companies} baseUrl="/api/tenancy" supportEmail="help@example.com" />

// app/admin/companies/page.tsx, …/[id]/page.tsx, app/admin/people/page.tsx
import { CompaniesConsole, CompanyDetail, StaffPeople } from "@adminigloo/tenancy-widget/admin";
<CompaniesConsole baseUrl="/api/admin/tenancy" detailHref="/admin/companies/{id}" />
<CompanyDetail baseUrl="/api/admin/tenancy" tenantId={id} />
<StaffPeople baseUrl="/api/admin/tenancy" />
```

**The company is named by your page, not guessed by the widget.** Every company
screen takes `tenantId`, and every request names that company in its path. A team
page left open in one tab keeps acting on the company it shows, even after the
owner switches company in another tab.

## Upgrading from 0.3

This is the first release of the widget; there is nothing of its own to upgrade.
The tables it relies on arrive with `@adminigloo/tenancy` 0.4 and
`@adminigloo/auth` 0.2 (their READMEs have the SQL for hosts not on drizzle-kit).
It replaces the template's own `AcceptInvitation` and `PendingInvitations`
components and the `invitations` tRPC router: the team page and the invitation
page now come from here.

## The components

Every component also takes `baseUrl` **or** `transport` (with both, `transport`
wins; with neither it shows one plain sentence, "This page isn't connected to its
server yet.", and never crashes), plus `theme`, `nonce`, `className`, `style`,
`locale` (default `"en-US"`, used for dates) and `noun` (default
`{ singular: "company", plural: "companies" }`: what your project calls a
tenant, used in every sentence).

### `<Onboarding>`

| Prop | Default | What it does |
| --- | --- | --- |
| `purpose` | `"onboarding"` | `"additional"` reads "Create another company". |
| `afterHref` | `"/dashboard"` | Where to go once the company is created or an invitation joined (a full page load). |
| `publicUrlPrefix` | `"/t/"` | Shown before the web address. |
| `initialSession` | — | The server's session, so there is no loading flash. Without it the component asks for it. |
| `onDone` | — | Called with `{ status, company }` instead of navigating. |
| `staffConsoleHref` | `null` | For the platform's own staff: a "Go to the admin console" link and a note that they don't need a company of their own. |

One question, "What's your company called?". The web address is suggested from
the name as it's typed and checked after 350 ms of quiet; "Change" makes it
editable, and from then on the name no longer drives it. A taken or reserved
address says why in a sentence and offers a free one in one click; the whole
public address is shown as text, with a line saying what it is for. The form sends
the same request key with every attempt at the same name and address, so a double
click or a retry after a lost answer creates one company, never two — and a
corrected name gets a new key, so a retry never brings back the typo. Someone
removed from their only company is told which one ("You're no longer part of
Summit Window Co."). Invitations waiting for one of the
person's verified addresses are listed first ("Acme Plumbing invited you to join as
Member.") and join only when "Join Acme Plumbing" is pressed. In single-business
mode it says "This site doesn't use companies." and shows no form.

### `<CompanySwitcher>`

| Prop | Default | What it does |
| --- | --- | --- |
| `session` | — | The server's session; renders with no fetch. Without it the component asks for it. |
| `reloadHref` | `"/dashboard"` | Where to go after switching (a full reload, so every server screen re-resolves). |
| `createHref` | `"/onboarding?another=1"` | "Create another company"; `null` hides it. |
| `settingsHref` | `"/settings/company"` | "Company settings"; `null` hides it. |
| `teamHref` | `"/settings/team"` | "Team"; `null` hides it. |

The button shows the logo (or initials) and the name, cut at 24 characters with
the full name in its tooltip; its spoken name is "Summit Window Co., switch
company". The menu is an ARIA menu: every company a `menuitemradio`, the active one
checked, a suspended one labelled "Suspended" (still choosable: the page it lands
on explains). Enter, Space or ArrowDown opens it; the arrows, Home and End move;
Escape closes it and returns focus; Tab or a click outside closes it. Someone with
no company gets "Set up your company". In single-business mode it renders nothing
for one workspace, and the menu (without "Create another") for two or more. It
never shows an error in your header: no session renders an empty slot.

### `<SetupChecklist>`

`tenantId` (required), `initial` (the server's checklist), `title` (default "Finish
setting up"). "1 of 3 done" as words and as a native progress bar; each item with
its link ("Add details") until it's done; "Not needed" skips one ("Skipped"). Once
everything is done or skipped: "You're all set." and "Hide this list"; before that,
"Hide this list" waits behind "More". It renders nothing when hidden, or for someone
who can do none of the items, and asks again whenever the tab comes back into view.

### `<TeamManager>`

`tenantId` (required), `initial` (the server's team), `afterLeaveHref` (default
`"/dashboard"`).

- **Invite**: email and role (Admin, Member or Viewer, as the server allows this
  person to give), "Send invitation". "Invitation sent to sam@…", or, when the
  email couldn't go, "We couldn't email it, so copy this link and send it yourself."
  with the link and "Copy link". A full plan says so, with an "Upgrade" link when
  your seat source gives one, and "3 of 5 places used (including invitations)."
- **Members**: a table from 640px, cards below. Name and email, "(you)", an
  "Owner" badge; a role select where the server allows a change (saved at once,
  reverted with the reason on a refusal); "Active" or "Account closed"; joined;
  "Remove" behind "Remove Sam from Summit Window Co.? They lose access straight
  away. Anything they made stays."
- **Pending invitations**: "Expires Oct 19, 2026" or "Expired", Resend, Revoke
  (after "Withdraw the invitation to …? The link they have will stop working.").
- **Leave or hand over**: "Leave Summit Window Co." for anyone but the owner (the
  owner reads why instead); "Transfer ownership" picks the new owner and stays
  disabled until the company's name is typed (any case), then explains "Sam becomes
  the owner and can manage billing and the team. You'll become an Admin."

What may be done to each row comes from the server, computed from the signed-in
person's own role: the widget never works out a rank. A page left open across a
removal or a demotion is replaced by the server's plain sentence ("You're not part
of this company.").

### `<CompanySettings>`

`tenantId` (required), `initialCompany`, `initialSettings`, `publicUrlPrefix`
(default `"/t/"`). Each area saves on its own, says "Unsaved changes" until it
does, and the page asks before leaving while anything is unsaved.

- **Name and web address** (`#profile`): the address is checked live, with "Changing
  this changes your public web address. The old address keeps pointing here."
  Read-only, with "Only an owner or admin can change these.", for anyone else.
- **Logo and colour** (`#branding`): upload a PNG, JPG or WebP under 1 MB (checked
  before it's sent, and again by the server), or remove it. The brand colour has a
  colour picker and a hex box kept in step, and a live preview: a sample button in
  the colour with the text colour that reads on it, a sample link on a white page,
  and "Text on this colour: 5.47 to 1 (easy to read)." A colour is never refused; a
  hard-to-read or very light one gets a sentence saying how it will look.
- **Every settings section the project registered** (tenancy's "Business details"
  is `#details`): drawn from its field specs. Time zones offer the US by name first
  ("Mountain Time (Denver)"), then every other zone.

Opening the page at `#details` or `#branding` (the checklist's links) scrolls to
that section and puts focus on its heading.

### `<CompanySuspended>`

`companyName` (required), `companies` (the person's others), `supportEmail`
(makes "Contact support" a mail link), `reloadHref`. "Summit Window Co. is
suspended. You can't use it right now. Contact support to restore it." Never the
reason (that's for staff). Someone in other active companies gets a button for
each.

### `<AcceptInvitation>`

`token` and `signedInAs` (required), `afterHref` (default `"/dashboard"`),
`signOutHref` (default none: a link that signs out and comes back, shown when the
invitation is for another address), `preview` (the server's preview, to skip the
request). First it asks the server what the link is for and says so — "Summit
Window Co. invited you to join as a Member." — without accepting anything.
Nothing happens until "Accept invitation" is pressed (link scanners open every
link in an email). It says "You're signed in as sam@…", so the wrong account
explains itself, and every outcome is a sentence: "You're in Summit Window Co.",
"This invitation has expired. Ask whoever invited you to send a new one.", "This
invitation is for a different email address. Sign out and sign in with the
address it was sent to.", and so on. Once in, it moves on after a moment, with
"Go to Summit Window Co." for anyone who'd rather click.

### `<CompanyBrandBar>` (Tenancy 2a)

`company` (required: a `PublicCompanyWire`, from the server's
`publicCompanyToWire(await tenancy.resolvePublicCompany(slug))`), `homeHref`
(where the name links; default the company's public home, `null` for no link),
`showContact` (default true). The company's public face at the top of its
booking, estimate and invoice pages: its logo (at most 40 px high) or its
initials in its colour, its name, and its email and phone as `mailto:` and
`tel:` links, over a 3 px rule in its colour. The name is a link, not a heading:
the page owns its `h1`. Here, unlike the company's own screens, the company's
colour is the point; the initials are drawn in the text colour the server
worked out for it (white or near-black, whichever reads). Server-renderable:
no state, no fetch.

```tsx
const found = await tenancy.resolvePublicCompany(slug);
if (!found) notFound();
const company = publicCompanyToWire(found);
return (
  <>
    <CompanyBrandBar company={company} />
    {company.status === "suspended" ? <CompanyUnavailable company={company} /> : <VisitPicker … accentColor={company.brandColor} />}
  </>
);
```

### `<CompanyUnavailable>` (Tenancy 2a)

`company` (required). What a CUSTOMER sees on a suspended company's public
page: "Summit Window Co. isn't taking requests online right now" (an `h1`),
"Please get in touch with them directly.", then "Email …" and "Call …" links
when the company has them. Nothing about why, and no other actions. (The
company's own people see `<CompanySuspended>`.)

### Roles the project adds (Tenancy 2a)

`<TeamManager>` shows every role the server offers: a project with Crew gets a
Crew row, Crew in the invite form and in each member's role select, with the
name and description the server sends. A role the server names without a row
reads as words ("field_lead" → "Field lead"), never a blank. `roleKeyOrNull`
accepts any lowercase role key; `ROLE_KEYS` is still the core four.

### `<CompaniesConsole>` (admin)

`detailHref` (default `"/admin/companies/{id}"`; a pattern with `{id}`, or a function from a client component: a Next.js server page can't pass a function to a client component), `defaultKind` (default `"org"`: personal workspaces
hidden; single-business projects pass `"all"`), `pageSize` (default 25). Search by
name, web address, owner's email or a member's email (after 300 ms of quiet), "Show" and "Status"
filters, and "Showing 1–25 of 230" with Previous and Next. The view lives in the
address bar, so a refresh or a shared link reopens it.

### `<CompanyDetail>` (admin)

`tenantId` (required), `backHref` (default `"/admin/companies"`). The name, status
and web address; created (and by whom), the owner (and "(account closed).
Ownership needs handing over" when it was), time zone, contact details, who is
invited (address, role, sender); the members; recent activity ("Activity isn't connected on this
site." when your handler has no `recentAudit`). "Suspend company" asks why (only
staff see the reason) and says what happens; a suspended company shows "Suspended
Oct 12, 2026 by Ava: …" and "Reactivate". Releasing a suspended company's web
addresses frees its current one too (it moves to a neutral `co-…` address).

### `<StaffPeople>` (admin)

`pageSize` (default 25), `companiesHref` (default `"/admin/companies"`: each
person's company count links there, searched by their email; `null` for plain
text), and `noun` for the companies column. Search by name or
email, "Staff only", and a "Staff role" select per person: "No staff role" plus
every role, highest first, with the roles you can't give disabled. A locked select
says why in words ("You can't change your own role.", "Only someone above them can
change this."). Giving a role asks first ("Give … the Customer service agent staff
role? They'll be able to use the staff screens that role allows."); removing the
last administrator is refused with the server's sentence on the row.

## Theme

Every component takes `theme`: `"auto"` (default), `"light"` or `"dark"`. **Auto
follows the host page**, in this order: `data-theme` on the nearest parent, then
`<body>`, then `<html>`; a `dark` or `light` class on `<body>` or `<html>`;
`color-scheme` on `<html>` when it names one scheme; the background the widget
sits on; and only then the visitor's system setting, where the page lets the
browser go dark. It follows changes live. On the server there's no `data-theme`,
so the system setting decides until hydration: no flash.

Every colour is a CSS custom property on `.aitw-root`, declared at zero
specificity, so one ordinary rule re-themes every component, the console
included:

```css
.aitw-root {
  --aitw-accent: #7c3aed;           /* buttons, the selected company */
  --aitw-accent-strong: #6d28d9;    /* hover */
  --aitw-accent-soft: #ede9fe;      /* selected tints */
  --aitw-on-accent: #ffffff;        /* text on buttons */
  --aitw-font: "Inter", sans-serif; /* default: your page's font */
}
```

Tokens (all `--aitw-`): `ground surface ink muted faint line line-strong accent
accent-strong accent-soft on-accent ok ok-soft warn warn-soft danger danger-soft
on-danger focus radius radius-sm shadow font`, plus `scrim shadow-lg` for dialogs.
Every pair the widget prints text with passes WCAG AA in light and dark (a test
checks each one).

**The accent is yours, not the company's.** A company's own brand colour appears
only as its logo, initials and the settings preview; the screens are never
re-skinned with it, so an owner who picks a pale yellow can still read their own
team page.

**Styles** are added once as `<style id="aitw-styles">` (and `aitw-admin-styles`
for the console) when the first component mounts. Pass `nonce` for a strict
Content-Security-Policy. `tenancyWidgetCss()` and `tenancyAdminCss()` return the
text if you render it yourself. `--aitw-scroll-margin` (default 96px) keeps a
section's heading clear of a sticky header on a deep link.

## Transports

Every component takes `baseUrl` **or** `transport`. `createTenancyClient({ baseUrl,
fetch?, headers? })` and `createTenancyAdminClient(...)` are what `baseUrl` builds
for you. Each method returns `{ ok: true, data }` or `{ ok: false, error }` and
never throws: a fetch that fails is `network`, a proxy's HTML error page is
`bad_response`, a 401 (or a redirect to a login page) is "You've been signed out.
Sign in again to keep working.", and the server's own refusals keep their code,
their sentence, and their `suggestion` (a free web address) or `upgradeHref`.

**Backing the screens with tRPC or server actions.** Implement `TenancyTransport`
(or `TenancyAdminTransport`) over the same service methods the handlers call,
answering in the wire types, with refusals as `{ ok: false, error: { code,
message, status } }`:

```ts
import type { TenancyTransport } from "@adminigloo/tenancy-widget";

const transport: TenancyTransport = {
  team: async (tenantId) => {
    try {
      return { ok: true, data: await trpc.tenancy.team.query({ tenantId }) };
    } catch (error) {
      return { ok: false, error: toClientErrorFromYourRouter(error) };
    }
  },
  // …every other method the same way
} as TenancyTransport;
```

The simpler path is to keep the HTTP handlers and pass `createTenancyClient({
baseUrl, fetch })` with your own `fetch` (an extra header, a request forwarded
through a server action): the handlers own the wire shapes, the authorisation and
the refusal codes, so a fix to who may remove whom reaches you by `npm update`.

## Pure helpers

Exported for tests and for anyone building their own screens on the same rules:
`suggestSlug`, `validateSlug`, `slugProblemMessage`, `companyNameProblem`,
`brandColorReport`, `contrastRatio`, `normaliseHexColor`, `US_TIME_ZONES`,
`nounTitle`, `resolveHostTheme`, `TENANCY_WIRE_VERSION` (`"v1"`), and every wire
type. The slug and colour rules are copies of `@adminigloo/tenancy`'s, checked
against it on 500 generated inputs; the server checks everything again.

## Accessibility

Real buttons, links, selects and labels throughout; every input has a visible
label, and errors are linked to their fields. Each component has one polite status
line for outcomes and an alert only for a failed write. Dialogs trap focus, close
with Escape, and put focus back where it was. The switcher's menu is a keyboard
menu. Colour is never the only signal: "Suspended", "Expired" and "Owner" are
words. Every touch target is at least 44px, tables become label-and-value cards
on a phone, and everything works at 390px wide.

## Not included

- **Per-company boards and widgets for feedback, notifications, files, the
  assistant, analytics, SEO/AEO and book-a-call (booking)** — **Tenancy 2b**.
  (Scheduling, the estimator, invoicing and messages are per company since
  2a; `<CompanyBrandBar>` heads their public pages.)
- **Payments to companies** (paying a company's invoice by card).
- **Search indexing of company pages**, and per-company SEO.
- **Logo and colour inside emails.**
- **Plans, billing and entitlements.** The seat hook exists. The billing chunk
  wires it to plans.
- Viewing as a customer (impersonation). `staff.tenants.impersonate` is declared
  and sealed, and nothing implements it.
- A custom role editor for companies, and per-person permission changes for
  company members. The roles are the project's set; Crew is a fixed role
  scheduling adds.
- Custom domains and subdomains.
- Company deletion, data export, operator notes, and comping a plan.
- Suspending a single member. You remove them instead. The `suspended` member
  status exists only for closed accounts.
- Moving billing ownership in Stripe when ownership is transferred.
- Emails to removed members or to a new owner. `onEvent` is the seam.
- Converting a legacy personal workspace into a company. In companies mode,
  personal workspaces are ignored.
- Identity providers other than Clerk.
- Table prefixes, or a dedicated Postgres schema.
