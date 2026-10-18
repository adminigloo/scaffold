# @adminigloo/customers

One customer list per company. Each customer once — their emails, phones,
addresses, notes and tags — with every quote, visit, invoice, call, order and
message that is theirs on one timeline.

## What you install, and what you get

| Install | You get |
| --- | --- |
| `@adminigloo/customers` | The tables (`./schema`), the rules and the HTTP handler (`./server`), the screens (`./admin`), the route table and permission keys (the root), and `sql/customers-0.1.0.sql`. |

A project made with `create-app` (0.35 or later) has it on whenever a field
feature is: the pages, the API route, the hooks on every installed feature and
`pnpm customers:backfill` are written for you.

## How it works

- **Find or create.** `findOrCreateCustomer(db, { tenantId, email, phone, name })`
  finds the company's customer by email, else by phone, else makes a new one.
  Emails are kept lower case; for matching only, Gmail's dots and `+tags` are
  folded (`M.Lee+quotes@gmail.com` is `mlee@gmail.com`). Phones are E.164,
  read in the business's own country when written without `+`. Never across
  companies: the same email in two companies is two customers. Two requests
  for the same new customer at once make one (unique partial indexes and a
  retry).
- **Links and the timeline.** `linkCustomer` puts one thing that happened to
  one record (`kind`: estimate, visit, invoice, booking, order, message) on the
  customer's timeline, once per record and action. `customerTimeline` pages it.
- **Your own customer table.** Features talk to a `CustomerDirectory`;
  `createDrizzleCustomerDirectory(db)` is this package's own. Implement the
  five calls over your table and hand that in instead.
- **The features' glue** calls `recordCustomerActivity(directory, activity)`:
  the customer the record is already linked to, else by email or phone, else
  a new one — then the link.
- **Search, edit, merge.** Search by name, company, email, phone or address.
  Merging moves the timeline, addresses, emails and phones; every merge is
  kept in `customer_merges`, and the merged customer is never matched again.
- **CSV.** Import previews first (at most 5,000 rows, deduped against the list
  and within the file, a plain-words reason for every row it can't take), then
  applies. Export is safe to open in a spreadsheet.
- **Backfill.** `backfillCustomers(directory, tenantId, records)` links what a
  company already has, in chunks; running it again changes nothing.

## Mounting the handler

```ts
import { createCustomersAdminHandlers } from "@adminigloo/customers/server";

const { handle } = createCustomersAdminHandlers({
  db,
  resolveTenant: (req) => companyIdFromPath(req), // or tenantId: "primary"
  authorize: (req, permission, tenantId) => can(req, permission, tenantId), // customers.view / customers.manage
});
export const GET = handle;
export const POST = handle;
```

```tsx
import { CustomersAdmin } from "@adminigloo/customers/admin";

<CustomersAdmin baseUrl="/api/app/{company id}/customers" pageHref="/app/customers" customerId={searchParams.customer ?? null} />
```

## Not in 0.1

- No customer portal: customers don't sign in to see their own timeline.
- No deleting a customer (merge a duplicate instead); no undo of a merge.
- No custom fields beyond notes and tags.
- Messages link only to customers who already exist (an office notice makes nobody a customer).
- Phones outside the listed countries are read only when written with `+`.
