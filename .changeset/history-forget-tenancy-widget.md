---
"@adminigloo/tenancy-widget": minor
---

`<CompanyDetail>`: "Delete this company" for staff who may (tenancy 0.8's `can.delete`). It says plainly what goes and that it can't be undone, names a plan the company is still paying for before anyone types, asks for the web address typed again, and — for a company still paying — "delete it anyway" with a reason. After it: what was removed, and the way back to the list (or your `onDeleted`). The admin transport gains `deleteCompany`; the wire gains `DeleteCompanyBody`, `DeletedCompanyWire` and the `still_paying` code.
