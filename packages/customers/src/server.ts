/**
 * @adminigloo/customers/server — the customer list's rules (customers 0.1):
 * find-or-create, links and the timeline, search, merge, import and export,
 * the CustomerDirectory seam with its drizzle default, the backfill and the
 * admin handler. Every function is inside one company.
 */
export * from "./customers.js";
export * from "./directory.js";
export * from "./backfill.js";
export * from "./import.js";
export * from "./admin-handlers.js";
export type * from "./wire.js";
