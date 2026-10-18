/**
 * @adminigloo/customers — one customer list per company (customers 0.1).
 *
 * The root is pure (no query builder, safe in a browser): how two emails or
 * phones are "the same", the CSV reader and writer, the route table and the
 * permission keys. The tables are "@adminigloo/customers/schema", the rules
 * and the handler "@adminigloo/customers/server", the screens
 * "@adminigloo/customers/admin".
 */
export { addressMatchKey, emailMatchKey, isE164, normaliseEmail, normalisePhone, oneLine, phoneMatchKey, phoneSearchDigits, PHONE_COUNTRIES } from "./normalise.js";
export { CSV_COLUMNS, csvCell, decodeCsvBytes, hasReplacementCharacters, mapCsvHeader, parseCsv, toCsv, type CsvColumn } from "./csv.js";
export { customersPermissions, customersCompanyPermissions, type CustomersPermission } from "./permissions.js";
export { CUSTOMERS_ADMIN_ROUTES, CUSTOMERS_ADMIN_ROUTE_PERMISSIONS, type CustomersAdminRouteKind, type CustomersRoute } from "./routes.js";
export { CUSTOMER_LINK_KINDS } from "./wire.js";
export type * from "./wire.js";
export type { CustomerNoticeDetails, CustomerNoticeKind } from "./schema.js";
