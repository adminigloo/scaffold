# @adminigloo/dashboard

The staff dashboard at `/admin`: a card for each part of your app, each showing that part's small version. Every card has:

- what needs you, in one sentence;
- a few counts, each opening the list behind it;
- a short list;
- the way to the full page.

Each person chooses their cards, stars the one they check first and drags the rest into order. That's kept for them on the server, so it follows them to any computer.

## What you get

| Install | You get |
|---|---|
| `@adminigloo/dashboard` | `createDashboardHandlers` (the routes), `<Dashboard />` from `/ui` (the page), the `dashboard_layouts` table from `/schema`, and a ready-made card for each AdminIgloo feature from `/glances/<package>` |

**What it is not:**
- It doesn't decide who may see what. Your app's own sign-in and staff permissions do: a card is offered only to people holding the key that opens its page, and its glance never runs for anyone else.
- It isn't a reporting tool. Every number is a count of your own rows, and no figure is estimated.

## The cards

| Import | Card | Reads |
|---|---|---|
| `glances/feedback` | `feedbackGlance` | Feedback board: waiting on a reply, open, new |
| `glances/analytics` | `visitsGlance` | Website visits, from AI assistants and search |
| `glances/booking` | `callsGlance` | Calls today, this week, the next ones |
| `glances/seo-reports` | `searchCheckGlance` | The latest search check's problems |
| `glances/aeo` | `aiMentionsGlance` | Whether AI assistants name you |
| `glances/assistant` | `assistantGlance` | Your AI assistant's use and changes |
| `glances/tenancy` | `companiesGlance`, `peopleGlance` | Companies, invitations, people, staff |
| `glances/commerce` | `shopGlance` | Orders, takings, despatch, products |
| `glances/billing` | `plansGlance` | Trials ending, payments due |
| `glances/observability` | `errorsGlance`, `auditGlance` | Unresolved errors, the audit log |

Import only the ones for features you have; each needs only its own package installed.

## Set up

1. Add the table to your schema, then generate and run the migration:

```ts
// src/db/schema.ts
import * as dashboardSchema from "@adminigloo/dashboard/schema";
export * from "@adminigloo/dashboard/schema";
// ...and spread dashboardSchema into the `schema` object.
```

2. List your cards and mount the routes:

```ts
// src/server/staff-dashboard.ts
import { createDashboardHandlers } from "@adminigloo/dashboard";
import { errorsGlance } from "@adminigloo/dashboard/glances/observability";

export const { handle } = createDashboardHandlers({
  db,
  authorize: async (req) => {
    // Your gate: return { userId, can(key) }, or a Response (401 / 403).
  },
  widgets: [
    {
      key: "governance.errors",
      title: "Errors",
      section: "Governance",
      description: "Problems nobody has marked fixed.",
      icon: "alert",
      href: "/admin/errors",
      permission: "staff.audit.view",
      defaultOn: true,
      glance: ({ now }) => errorsGlance({ db, now }),
    },
  ],
});
```

```ts
// app/api/admin/dashboard/[...path]/route.ts
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
```

3. Put the page up:

```tsx
// app/admin/page.tsx
import { Dashboard } from "@adminigloo/dashboard/ui";

export default function Page() {
  return <Dashboard api="/api/admin/dashboard" />;
}
```

## Your own cards

A card is any function that returns a `Glance`. The shape is plain data (`status`, `attention`, `tiles`, `spark`, `list`, `note`, `link`, `setup`), so a part of your app that isn't an AdminIgloo package gets a card the same way. The dashboard trims what a glance sends to what a card can show: four tiles, six rows, and only links within your site.

## Colours

The cards use your app's theme tokens (`--color-surface`, `--color-ink`, `--color-accent`, …) in light and dark. Set any `--aid-*` property on `.aid-root` to override one.

## Before the migration runs

The dashboard still works: everyone sees the default cards. A notice says changes won't be kept until the table exists.
