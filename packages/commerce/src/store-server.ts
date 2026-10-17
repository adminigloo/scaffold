/**
 * @adminigloo/commerce/store — A STORE OF ITS OWN (commerce 0.2): the server
 * half of a business selling its own products to its own customers. The
 * product functions, Check out, the webhook's rules, the owner's lists, the
 * two HTTP handler factories and the order emails.
 *
 * Its own entry, so the package root stays pure arithmetic a browser can
 * import (the root never pulls in the query builder). The route tables and
 * permission keys are in the root (`STORE_ADMIN_ROUTES`, `storePermissions`).
 */
export * from "./store.js";
export * from "./store-handlers.js";
export * from "./store-emails.js";
export type * from "./store-wire.js";
