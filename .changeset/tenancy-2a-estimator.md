---
"@adminigloo/estimator": minor
---

Company features (Tenancy 2a): one deployment quotes for many companies.

- **`company(tenantId)`**: the business's name, contact details, time zone,
  logo and colour come from the host's company profile;
  `resolveEstimatorSettings` overlays them and the settings screen shows them
  as managed in company settings.
- **`admit(tenantId, req)`** on both public paths, the web address AND the
  website embed key: a suspended company's estimate tool answers 409
  `estimates_closed` with how to reach the business.
- **A ceiling on photo-reading spend** (`aiBudgetCeilingCents`): each
  company's daily budget is the lower of its own setting and the site's
  ceiling, applied before any photo is read, so no company can spend the
  platform's AI budget.
- **Per-company links and inbox**: quote links may be async (built from the
  company's web address); new-estimate notices go to the company's own people.
- **Route tables** (`ESTIMATOR_ADMIN_ROUTES`, `ESTIMATOR_PUBLIC_ROUTES`) and
  **checklist items** (`estimatorChecklistItems`).
- Attaching a supply or adding an option to a product that isn't this
  company's now answers 404 instead of 400.
- With a company, the staff notice for a closed estimate page asks only for
  the tax rate in Estimate settings, not for a business name the screen shows
  read-only.
- The comms peer is now `^0.3.0`.

After review:

- **`invoiceAccess`**: "Turn into an invoice" asks the host's invoice
  permission as well as the estimator's, and an estimate's page shows the
  invoice it became only to someone who may see invoices.
- **The web address decides**: a keyed request under another company's web
  address is "not found" (`verifyClientKey(db, key, { tenantId })`).
- **`aiSiteBudgetCents`**: a daily ceiling on photo reading for the whole
  site, every business together, beside each business's own.
- **`siteNotices: "company"`**: the site's setup gaps (no AI key, no file
  storage) in a company's words, never a setting it can't change.
- **Sample price books by trade**: lawn care, cleaning or ramps
  (`SAMPLE_CATALOGS`, `loadSampleCatalog(db, tenantId, { trade })`, the
  route's `{ trade }` body).
- The accepted-quote email offers to "see or print" the quote, not to accept
  it again; a reply to an office notice reaches the customer; the tax notice
  no longer quotes a default the form doesn't show; the website checklist item
  is "Add an estimate button to your website", and says to dismiss it once
  the button is up (a pasted button leaves no key to tick it).
