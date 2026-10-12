/**
 * The wire contract's version segment: every route is `{base}/v1/...`. Its own
 * module so both entries can export it without the admin bundle pulling in
 * the customer-facing components (or the other way round).
 */
export const SCHEDULING_WIRE_VERSION = "v1";
