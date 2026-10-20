---
"@adminigloo/create-app": patch
---

The dashboard shows the business, even before setup is finished.

- **The numbers always show.** Today, New leads, Money owed and Paid this week render whether or not setup is done. An unfinished setup list is one compact card above them ("2 things left to set up", how far along, and a chevron) that opens into the list, and it's gone once everything is done or skipped, or the list is hidden. A brand-new company (nothing to count yet) gets the card open and its zeros come with one plain sentence on what fills them in.
- **Up to three short lists under the numbers**, for what's installed and what the person's role may open: Today's visits (time, customer, address, crew; opens the visit on the schedule), Newest leads (name, what they asked for, price range, how long ago; opens the estimate) and Overdue invoices (number, customer, amount owed, days overdue; opens the invoice). At most five lines each, "See all →", one quiet line when empty. Two columns at lg, one on a phone, in the stat cards' card.
- Read by `dashboardOverview` in the generated src/server/dashboard.ts through the packages' own reads (the calendar, the estimates queue's search, the ledger's overdue rule), company-scoped and permission-filtered, in the company's locale, currency and time zone ("today" is the company's day). `dashboardNumbers` still answers the numbers alone. Drawn by src/components/Dashboard.tsx.
- New leads now counts exactly what the Estimates page's Leads shows, and Money owed's "N overdue" follows the overdue list's rule (past due with money still owed), so a number and its list always agree.
- The project's isolation proof gains a dashboard pass: two companies each with a visit today, a lead and an overdue invoice; neither's dashboard shows the other's rows, each shows its own, and each list appears only with its page's permission.
