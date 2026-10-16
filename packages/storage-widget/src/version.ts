/**
 * The wire contract's version segment: every route is `{base}/v1/...`
 * (docs/tenancy-2b1-contract.md, 6.10). Its own module so both entries can
 * export it without one bundle pulling in the other's screens.
 */
export const STORAGE_WIRE_VERSION = "v1";
