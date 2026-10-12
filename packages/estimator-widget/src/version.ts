/**
 * The wire contract's version segment: every route is `{base}/v1/...` (the
 * estimator 0.3 contract keeps 0.2's v1 routes and adds to them). Its own
 * module so both entries can export it without the admin bundle pulling in the
 * customer-facing components, or the other way round.
 */
export const ESTIMATOR_WIRE_VERSION = "v1";
