---
"@adminigloo/stripe": patch
"@adminigloo/create-app": patch
---

Fixes from the 2026-11-16 audit of Almanac and Hinderstap:

- stripe 0.7.1: `STRIPE_SECRET_KEY` takes a restricted key (`rk_…`) as well as a secret one (`sk_…`). Stripe recommends restricted keys for live accounts, and 0.7.0's `sk_`-only check stopped Hinderstap's production build. The mode check is unchanged: an `rk_live_…` key still can't run outside production.
- create-app 0.44.1: checkout won't take a payment it can't record. With `STRIPE_SECRET_KEY` set and no `STRIPE_WEBHOOK_SECRET`, `checkoutMode()` is `unavailable` and says why, and `checkout.createIntent`, `billing.subscribeToPlan`, `changePlan` and `addLine` refuse the same way. Before, the card was charged and the webhook refused every delivery, so the order or plan was never written.
- create-app 0.44.1: `.github/workflows/ci.yml` runs on pull requests and by hand only. A push to `staging` or `main` is checked once, by `deploy.yml`'s `verify` job, instead of twice (about 40% of a month's Actions minutes on Hinderstap).
