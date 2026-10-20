---
"@adminigloo/create-app": minor
---

The showroom: every generated project looks finished to the business owners who judge it.

- **One setup card per page.** A page's setup and missing-service notices collapse into one calm, dismissible "N things to finish" card (`<SetupNotices>` in src/components/ui, and the same card inside every package widget). The operator's jobs (email provider, photo storage, photo reading, Stripe keys) read as one plain sentence for owners; staff of the site also see the technical detail. No environment variable, file path or /setup link is shown to anyone else (src/server/operator.ts, `<OperatorOnly>`).
- **Plans in owner language.** Each plan's description is its one-line promise; the plans pages lead with "Everything included" and the 3–4 numbers in `HEADLINE_FEATURES` (src/plans.ts), with the rest under "What's included". "1 websites" reads "1 website". "This plan is not sold monthly in USD" is "Talk to us". The sample prices list USD first.
- **One page shape.** `WorkPage` / `WORK_MAIN`: max-w-6xl in the work area, the same header (title, one line, primary action on the right) on every company page; package widgets draw no second title (`title={false}`). One card radius and shadow, handed to the widgets too. Buttons are 44px.
- **Empty states that sell the screen**: estimates, schedule, invoices, customers, calls, store, payments, messages and files say what they do once in use, with one primary action.
- **A company's public page is a mini website** (/t/[slug]): name and logo, tagline, service area, phone, email and hours (new company settings: "Your public page" and "Dates and money"), a big "Get an instant estimate", services from the price book with "from $X" priced by the estimator's own pricing, booking and Shop, feedback as a footer link. The LocalBusiness JSON-LD carries the tagline, area served and opening hours.
- **The landing page is for business owners**: three outcomes, how it works in three steps, a plans teaser, product screenshot slots (public/screenshots/*.png, shown only when present), and "Go to your dashboard" when signed in. Every word is in src/marketing-copy.ts, the one file a project edits to speak its trade.
- **The dashboard** shows the compact setup checklist until setup is done, then Today, New leads, Money owed and Paid this week from the company's own rows (src/server/dashboard.ts) — no grid of links repeating the sidebar.
- **Dates and money use the company's locale**, en-US by default (CompanyGate hands `locale` to every widget).
- With no email provider set up, a company's emails no longer use up its sending allowance, so nothing is held, logged as failed or raised as an alert.
- The payments screen uses the theme's tokens (it used stock Tailwind colours the theme deletes).
