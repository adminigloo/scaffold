---
"@adminigloo/billing": minor
---

Plans for every package. `planStanding` says where a company stands with its plan (free trial, paying, ending, a failed payment's grace, ended, or trial over) from its newest subscription and its plan rows. `createPlanGate` turns that into the one answer every company checkpoint asks; `gatePermissionLoaders` trims a closed company's permissions to reading, billing, the team and company settings, so new work waits until there's a plan again and nothing is deleted. New `./server` entry: `loadCompanyPlan` (standing plus every limit in two queries), `liveStripeSubscription` and `companyStripeCustomer`, so a company that already pays is never sent through a second checkout.
