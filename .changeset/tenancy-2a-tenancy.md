---
"@adminigloo/tenancy": minor
---

Company features (Tenancy 2a): what the feature packages need to serve many
companies from one site.

- **Roles a project composes.** `defineTenantRoles([...])` adds roles below
  admin to the core four (scheduling adds Crew: someone who opens their own
  route on a phone and sees nothing else). Pass it as `roles` to
  `createTenancyService`; invitations, role changes, the team page's options
  and the first-company seed all use it. A bad role (a core key, a rank that
  ties a core role, a missing name) fails at boot with
  `InvalidTenantRoleError`. An unknown role key over HTTP is refused with
  "Pick one of the roles listed." `RoleKey` on the wire now takes any
  lowercase key. Without `roles`, nothing changes.
- **A public lookup that knows about suspension.** `resolvePublicCompany(slug)`
  returns a suspended company with `status: "suspended"` (through its current
  or an old address), so its public pages can say it isn't taking requests
  instead of a 404. `resolveCompanyBySlug` still hides it, as before.
  `PublicCompany` gains `timeZone`; `publicCompanyToWire` (no id) feeds the
  widget's brand bar.
- **The company profile.** `companyProfile(id)`: name, web address, status,
  time zone, contact details, address, logo and colour, where customer replies
  go (the contact email, else the owner's), where its own notices go, and every
  settings section's values. One query, no permission check (for server code
  that has already decided whom it serves). `listMemberPeople(id)`: a
  company's active people, for "who opens this crew's route".
- **Every company, for crons.** `activeCompanyIds()` and
  `runForEachCompany(tenancy, work, { concurrency, timeBudgetMs, onError })`:
  one company's failure is reported and the next one runs; the start rotates by
  the hour so a cut-short run doesn't skip the same companies every time.
- **Route seams.** `createCompanyRouteSeams({ tenancy, principal })` gives the
  feature packages' staff routes `resolveTenant` and `authorize` (signed out
  401, not a member 403, suspended 403, missing permission `false`; one
  permission lookup per request). `createPublicCompanySeams({ tenancy })`
  gives their public routes `resolveTenant` (by web address) and `admit`
  (closed for a suspended company, with how to reach it).
- **Three events** after commit: `company.settings.updated` (with the changed
  fields), `company.profile.updated` (name and/or web address) and
  `company.branding.updated`.
- The time zone field's help now says visits already booked keep their clock
  times.

After review: `runForEachCompany` starts at a different company every run
(`rotationStart`), so a daily cron that runs out of time never leaves out the
same companies day after day; `CompanyProfile.createdAt`; and the activity
log describes a settings change in words ("Business details: time zone,
phone"), not field keys.
