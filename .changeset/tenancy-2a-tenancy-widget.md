---
"@adminigloo/tenancy-widget": minor
---

Company features (Tenancy 2a).

- **Any role the server offers.** The team page, the invite form and the role
  selects show a project's extra roles (Crew) with the name and description the
  server sends; a role the server names without a description reads as words
  ("field_lead" → "Field lead"), never a blank.
- **`<CompanyBrandBar company={…} />`**: a company's public face at the top of
  its booking, estimate and invoice pages: its logo (or initials in its colour),
  its name linking to its public home, and its email and phone as links, with a
  rule in its colour. Server-renderable.
- **`<CompanyUnavailable company={…} />`**: "{Name} isn't taking requests online
  right now. Please get in touch with them directly." with the company's
  contact links, for a suspended company's public pages. Nothing about why.
- The `PublicCompanyWire` type, and the peer is now `@adminigloo/tenancy`
  `^0.5.0` (still optional).
