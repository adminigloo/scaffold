---
"@adminigloo/tenancy": minor
---

`createCompanyRouteSeams` and `createPublicCompanySeams` take an optional `plan` gate (billing 0.3's `createPlanGate`, or the host's own). A member who holds the permission is refused with the gate's plain sentence while the company's plan is closed, except for what stays open (reading, billing, the team); a closed company's public pages say it isn't taking requests online, in the same words as a suspended one. The plan is asked only after membership and permission pass, so a stranger learns nothing about whether a company has paid.

While a company's plan is closed, the links it already sent its customers stay open (`keptOpenWhilePlanClosed`: `/quote/…`, `/visit/…`, `/invoice/…`), so they can still see, accept, reschedule and pay; only new requests close. Pass `keepsOpen` to change it.
