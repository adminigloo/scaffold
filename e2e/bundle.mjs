// Bundle a package's browser-facing module into one IIFE the test injects with
// page.addScriptTag. We bundle from the package's SOURCE (esbuild resolves its
// deps — e.g. modern-screenshot — from that package's own node_modules), so a
// browser test always exercises the current source, not a stale dist.
//
// Run as a script (`pnpm bundle`, and `pnpm test` through `pretest`) it writes
// every target below to fixtures/*.bundle.js. Imported (by a fixture server)
// it builds nothing on its own: the fixture calls `buildTarget` for the one
// target it serves, in memory, so a spec run straight through
// `playwright test` still gets the current source.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "packages");

// ONE React for the whole host-app bundle. The widget's source would otherwise
// resolve react from packages/feedback-widget/node_modules and Radix from
// e2e/node_modules — two Reacts, and every hook throws.
const singleReact = {
  react: join(here, "node_modules", "react"),
  "react-dom": join(here, "node_modules", "react-dom"),
};

/**
 * The widgets a companies project mounts (Tenancy 2a), each bundled on its
 * own from SOURCE — its customer entry (`.`) and its staff entry (`./admin`)
 * together, as one global per package.
 *
 * WHY EACH ONE ALONE, beside the host below that mounts them all: a widget is
 * a browser package, and the first sign one has picked up a server-only import
 * (a node builtin, a database driver, its own server package by value instead
 * of by type) is that it stops bundling for `platform: "browser"`. The host
 * would show the same failure, but only as "the Tenancy 2a scenario fixture
 * didn't start"; this names the package.
 */
const WIDGETS = [
  { name: "tenancy-widget", globalName: "TenancyWidget" },
  { name: "scheduling-widget", globalName: "SchedulingWidget" },
  { name: "estimator-widget", globalName: "EstimatorWidget" },
  { name: "invoicing-widget", globalName: "InvoicingWidget" },
  { name: "comms-widget", globalName: "CommsWidget" },
];

/** A widget package's two entries, re-exported as one module esbuild can bundle. */
function widgetEntry(name) {
  const src = join(packages, name, "src").replace(/\\/g, "/");
  return {
    contents: `export * as site from "${src}/index.ts";\nexport * as admin from "${src}/admin/index.ts";\n`,
    resolveDir: here,
    sourcefile: `${name}-entry.ts`,
    loader: "ts",
  };
}

/**
 * The host page of the Tenancy 2a scenario (contract 14): every screen
 * a companies project shows — the tenancy widget's onboarding, dashboard,
 * settings and team pages, and the scheduling, estimator, invoicing and
 * messages widgets in the company area (/app/…) and on each company's public
 * pages (/t/{web address}/…) — in one bundle, one React.
 * fixtures/tenancy-2a-scenario-server.ts serves it as /widgets.js.
 */
export const tenancy2aScenarioTarget = {
  entry: join(here, "fixtures", "tenancy-2a-scenario-host.tsx"),
  outfile: join(here, "fixtures", "tenancy-2a-scenario.bundle.js"),
  alias: singleReact,
  // Development React under StrictMode: effects run twice, as in every buyer's `next dev`.
  nodeEnv: "development",
};

export const targets = [
  {
    // The feedback widget's screenshot capture — captureScreenshot,
    // captureOverlays, stitchOverlays — exposed as window.FeedbackCapture.
    entry: join(here, "..", "packages", "feedback-widget", "src", "screenshot.ts"),
    globalName: "FeedbackCapture",
    outfile: join(here, "fixtures", "feedback-capture.bundle.js"),
  },
  {
    // A buyer-shaped host app: React + a Radix Dialog + a chat panel + the
    // whole widget (button, modal, provider), driven like a person would.
    entry: join(here, "fixtures", "host-app.tsx"),
    outfile: join(here, "fixtures", "host-app.bundle.js"),
    alias: singleReact,
  },
  {
    // The same host app on a DEVELOPMENT React build, where StrictMode really
    // double-runs effects — the shape of every buyer's `next dev`.
    entry: join(here, "fixtures", "host-app.tsx"),
    outfile: join(here, "fixtures", "host-app.dev.bundle.js"),
    alias: singleReact,
    nodeEnv: "development",
  },
  ...WIDGETS.map((widget) => ({
    stdin: widgetEntry(widget.name),
    globalName: widget.globalName,
    outfile: join(here, "fixtures", `${widget.name}.bundle.js`),
    alias: singleReact,
  })),
  tenancy2aScenarioTarget,
];

/**
 * Build one target. `write: false` returns the bundle's text instead of
 * writing its outfile (what a fixture server serves).
 */
export async function buildTarget(t, { write = true } = {}) {
  const result = await build({
    ...(t.stdin ? { stdin: t.stdin } : { entryPoints: [t.entry] }),
    bundle: true,
    format: "iife",
    ...(t.globalName ? { globalName: t.globalName } : {}),
    ...(write ? { outfile: t.outfile } : { write: false }),
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: t.alias,
    define: { "process.env.NODE_ENV": JSON.stringify(t.nodeEnv ?? "production") },
    logLevel: write ? "info" : "silent",
  });
  return write ? null : result.outputFiles[0].text;
}

// Only when run as a script — never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const t of targets) {
    await buildTarget(t);
    console.log(`bundled ${t.globalName ?? t.entry} -> ${t.outfile}`);
  }
}
