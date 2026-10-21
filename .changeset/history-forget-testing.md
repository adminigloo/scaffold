---
"@adminigloo/testing": minor
---

`@adminigloo/testing/forget`: prove that forgetting one company takes its rows from EVERY table and nobody else's. `plantCompanyRows(db, [a, b], { links })` reads the database itself (pg_catalog) and plants one row per company in every table with `tenant_id` and every table hanging off one (an estimate's lines, an order's items — `links` names children with no foreign key); `companyRowCounts` and `forgetReport(db, planted, { forgotten, kept, before })` then name the tables still holding the forgotten company's rows (`left`) and the ones that lost another company's (`lost`). A table a package adds later is planted and checked without anyone listing it.
