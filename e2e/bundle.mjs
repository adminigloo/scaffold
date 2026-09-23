// Bundle a package's browser-facing module into one IIFE the test injects with
// page.addScriptTag. We bundle from the package's SOURCE (esbuild resolves its
// deps — e.g. modern-screenshot — from that package's own node_modules), so a
// browser test always exercises the current source, not a stale dist.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ONE React for the whole host-app bundle. The widget's source would otherwise
// resolve react from packages/feedback-widget/node_modules and Radix from
// e2e/node_modules — two Reacts, and every hook throws.
const singleReact = {
  react: join(here, "node_modules", "react"),
  "react-dom": join(here, "node_modules", "react-dom"),
};

const targets = [
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
];

for (const t of targets) {
  await build({
    entryPoints: [t.entry],
    bundle: true,
    format: "iife",
    ...(t.globalName ? { globalName: t.globalName } : {}),
    outfile: t.outfile,
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: t.alias,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
  });
  console.log(`bundled ${t.globalName ?? t.entry} -> ${t.outfile}`);
}
