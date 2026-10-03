/**
 * @adminigloo/analytics — first-party, cookieless traffic analytics for an
 * app's own site, and the reports to show for it. See README-level docs on
 * each module: sources (attribution), crawlers (who else is reading),
 * visitor (paths, devices, the daily visitor key), ingest (the beacon
 * endpoint + crawler logging + retention), reports (every query).
 *
 * Client pieces live in `@adminigloo/analytics/client` (the beacon) and
 * `@adminigloo/analytics/dashboard` (the report UI); tables in `./schema`.
 */
export * from "./sources.js";
export * from "./crawlers.js";
export * from "./visitor.js";
export * from "./vitals.js";
export * from "./periods.js";
export * from "./ingest.js";
export * from "./reports.js";
export * from "./verify.js";
