---
"@adminigloo/trpc": minor
---

The procedure ladder learns four things for companies.

- `PermissionLoaders.explainTenantDenial` (optional): when it says the company is
  suspended, the tenant rung refuses with "Access to this account is suspended.
  Contact support to restore it." instead of "not a member". `companySuspended`
  is exported beside `notAMember` and `notStaff`.
- `inventoryOf(router)`: every procedure of a built router, flattened, ready for
  `auditBuiltProcedures`, so a generated project's scope audit runs as a test.
- `auditBuiltProcedures` accepts a full dotted path in the expected map, and the
  path wins over the router name, so a mixed router declares its exceptions
  (`invoicing: "staff"` beside `"invoicing.byToken": "public"`).
- `inputFieldsOf(procedure)`: every leaf a procedure's input parsers declare —
  required, optional, nested, inside arrays, through unions and pipes (zod 3
  and 4) — with the path to set each, and `looksLikeAnId(key)`. The generated
  isolation test uses them so an optional id can't pass as "tenant-only".
