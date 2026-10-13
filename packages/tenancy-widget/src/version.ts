/**
 * The wire contract's version segment: every route is `{base}/v1/...`
 * (docs/tenancy-1-contract.md, section 6). Its own module so both entries can
 * export it without the admin bundle pulling in the company screens (or the
 * other way round).
 */
export const TENANCY_WIRE_VERSION = "v1";
