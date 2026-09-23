// Bundle a package's browser-facing module into one IIFE the test injects with
// page.addScriptTag. We bundle from the package's SOURCE (esbuild resolves its
// deps — e.g. modern-screenshot — from that package's own node_modules), so a
// browser test always exercises the current source, not a stale dist.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const targets = [
  {
    // The feedback widget's screenshot capture — captureScreenshot,
    // captureOverlays, stitchOverlays — exposed as window.FeedbackCapture.
    entry: join(here, "..", "packages", "feedback-widget", "src", "screenshot.ts"),
    globalName: "FeedbackCapture",
    outfile: join(here, "fixtures", "feedback-capture.bundle.js"),
  },
];

for (const t of targets) {
  await build({
    entryPoints: [t.entry],
    bundle: true,
    format: "iife",
    globalName: t.globalName,
    outfile: t.outfile,
    platform: "browser",
    target: "es2020",
    logLevel: "info",
  });
  console.log(`bundled ${t.globalName} -> ${t.outfile}`);
}
