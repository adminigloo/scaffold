---
"@adminigloo/audience": minor
---

One audience per company (0.2.0).

- **`createAudiences({ store, secret, …, forTenant })`**: one store and one secret, one instance per company (`audiences.for(id)`, the same instance every time, up to 500 kept). `forTenant` gives each company's own facts — who its team is, its people, its sessions. `createAudienceRegistry` is the same over any factory.
- **`createAudienceAdminHandlers`**: a company's rules over HTTP — `GET v1/rules`, `POST v1/rules/preview`, `POST v1/rules`, `POST v1/rules/{rule}/remove` — with `AUDIENCE_ADMIN_ROUTES`, the permission fragment `audiencePermissions` (`audience.manage`: owner, admin) and `COMPANY_RULE_KINDS`. Another company's rule is "not found". Plain-word errors.
- **`<AudienceSettings>`** and `createAudienceTransport` on `./ui`: the rules panel, drop-in, loaded and refreshed through the routes.
- A row source's `where` may carry `null` (`IS NULL`), for analytics 0.3's "a company's own pages here".
- Ships `sql/audience-0.2.0.sql`. No table changes from 0.1.
- **A preview never says whether an address has an account**: for a one-person rule (`email`, `user`) the handlers report the visits it would leave out, with no people count. `listUsers` must return only the tenant's own people (README).
- **An owner's words**: `COMPANY_RULE_KINDS` is a team member's email, everyone at an email domain, an office or home internet connection, a monitoring tool; the labels, hints and messages say so ("An office or home internet connection", not "Network (IP range)"); the code-only rule is tagged "Set by your developer".
- Move to 0.2 together with `@adminigloo/analytics` 0.3.
