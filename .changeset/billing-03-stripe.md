---
"@adminigloo/stripe": minor
---

Change a company's plan on its existing subscription, never a second one. `previewPlanChange` asks Stripe what the switch costs today (prorated; a credit when moving to a cheaper plan), and `changePlan` makes exactly that change with the same proration date. The price is changed with `payment_behavior: "pending_if_incomplete"`, so a failed charge leaves the company on the plan it was paying for; the plan's name is stamped on the subscription only once the change went through.

`changePlan` refuses a proration date that isn't the preview's (in the future, or older than 30 minutes), so an upgrade can't be dated to cost almost nothing and a downgrade can't credit time already used. New `prepareCompanyCheckout`: before a company's first plan checkout it finds or makes the company's ONE Stripe customer, asks Stripe whether a subscription already exists (paid but not yet mirrored, or never finished), and closes the company's other open checkouts, so two tabs, or paying and coming straight back, can never end in two subscriptions.
