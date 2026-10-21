---
"@adminigloo/permissions": minor
---

A seal now takes effect over a key a shipped role already held. `seedPermissionCatalog` wrote a sealed key's deny row with `on conflict do nothing`, so a system template that held the key (an allow row from an earlier catalog) kept it for ever — a consumers project's owners kept the invite and hand-over keys the catalog had taken away. The seed now turns that allow row into deny, on system templates only (a customised template keeps what somebody chose), and reports it: `sealsApplied` (how many) and `withdrawn` ("tenant/owner/members.invite", …), beside `sealsLifted`, its mirror. A key merely dropped from `defaultFor` is still never revoked: the seed stays insert-only otherwise.
