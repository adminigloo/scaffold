/**
 * @adminigloo/customers/admin — the customer screens (customers 0.1). A client
 * entry ("use client" is stamped on the bundle by tsup). React is its only
 * peer; the screens talk to the app only through the base URL each is given.
 *
 *   <CustomersAdmin baseUrl pageHref customerId recordHrefs canManage />
 */
export { CustomersActions, CustomersAdmin, CustomersStyles, ImportPanel, customerBody, importProgressWords, kindWords, recordHref, type CustomersActionsProps, type CustomersAdminProps } from "./admin/CustomersAdmin.js";
export { customersCss } from "./admin/styles.js";
export type * from "./wire.js";
