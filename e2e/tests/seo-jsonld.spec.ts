import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @adminigloo/seo's JSON-LD escaping, through a real HTML parser.
 *
 * The page HTML is rendered in Node exactly as a Server Component would
 * render it (react-dom/server's renderToStaticMarkup of `<JsonLd/>` from the
 * package SOURCE, packages/seo/src/react.tsx), served to Chromium, and parsed
 * there. For each hostile value (a `</script>` breakout, a `<!--<script>`
 * that drags the parser into its double-escaped state, an upper-case
 * `</SCRIPT >`, U+2028/U+2029) the page must have exactly one ld+json block,
 * no injected script may run, the content after it must survive, and
 * `JSON.parse` of the block must equal the graph that was built.
 *
 * Negative control: the same payloads written the way trailcards, Riddler Go
 * and the AdminIgloo site wrote them (plain JSON.stringify) DO break out here,
 * so this spec can tell escaped from unescaped.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const seoSrc = join(e2eRoot, "..", "packages", "seo", "src");
const ORIGIN = "https://seo.test";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
// Single quotes only: JSON.stringify escapes a double quote, which would turn an
// injected script into a syntax error instead of running it (and hide a breakout).
const PAYLOADS: Record<string, string> = {
  "script breakout": "</script><script>window.__pwned = 'breakout'</script>",
  "comment then script": "<!--<script>window.__pwned = 'comment'</script>-->",
  "upper-case end tag": "</SCRIPT ><script>window.__pwned = 'upper'</script>",
  "image handler": "</script><img src=x onerror=window.__pwned='img'>",
  "line separators": `one${LS}two${PS}three</script><script>window.__pwned = 'ls'</script>`,
};

type Rendered = { data: unknown; html: string; naive: string };
let render: (name: string, answer: string) => Rendered;

test.beforeAll(async () => {
  // One file per worker: workers run beforeAll in parallel, and one importing
  // a file another is still writing reads half a bundle.
  const outfile = join(e2eRoot, "test-results", `seo-render-${process.pid}.cjs`);
  mkdirSync(dirname(outfile), { recursive: true });
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { createElement } from "react";
        import { JsonLd } from ${JSON.stringify(toPosix(join(seoSrc, "react.tsx")))};
        import { defineSite, graph, organization, webPage } from ${JSON.stringify(toPosix(join(seoSrc, "index.ts")))};
        const site = defineSite({ url: ${JSON.stringify(ORIGIN)}, name: "Test", indexable: true, description: "A test site." });
        export function render(name, answer) {
          // One page node carrying the FAQ (graph() refuses a webPage and a faqPage for one URL).
          const data = graph(
            organization(site, { name }),
            webPage(site, { path: "/", name, faq: [{ question: "What is it?", answer }] }),
          );
          return {
            data,
            html: renderToStaticMarkup(createElement(JsonLd, { data, id: "ld" })),
            naive: '<script type="application/ld+json" id="ld">' + JSON.stringify(data) + "</script>",
          };
        }
      `,
      resolveDir: e2eRoot,
      sourcefile: "seo-render.tsx",
      loader: "tsx",
    },
    bundle: true,
    // CommonJS: react-dom/server requires node builtins, which an ESM bundle cannot.
    format: "cjs",
    platform: "node",
    target: "node18",
    jsx: "automatic",
    outfile,
    alias: {
      react: join(e2eRoot, "node_modules", "react"),
      "react-dom": join(e2eRoot, "node_modules", "react-dom"),
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
  });
  const mod = (await import(pathToFileURL(outfile).href)) as { default: { render: typeof render } };
  render = mod.default.render;
});

function documentFor(head: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>JSON-LD</title>${head}</head><body><main><h1 id="after">Content after the block</h1></main></body></html>`;
}

async function serve(page: Page, html: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(`${ORIGIN}/`);
  return errors;
}

for (const [label, payload] of Object.entries(PAYLOADS)) {
  test(`escaped <JsonLd/> holds against: ${label}`, async ({ page }) => {
    const { data, html } = render(`Name ${payload}`, `Answer ${payload}`);
    const errors = await serve(page, documentFor(html));

    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
    expect(await page.locator('script[type="application/ld+json"]').count()).toBe(1);
    expect(await page.locator("head script, body script").count()).toBe(1);
    expect(await page.locator("img").count()).toBe(0);
    await expect(page.locator("#after")).toHaveText("Content after the block");
    const parsed = await page.evaluate(() => JSON.parse(document.getElementById("ld")!.textContent!));
    expect(parsed).toEqual(data);
    expect(errors).toEqual([]);
  });
}

test("negative control: the same payload, written with plain JSON.stringify, breaks out", async ({ page }) => {
  const { naive } = render(`Name ${PAYLOADS["script breakout"]}`, "Answer");
  await serve(page, documentFor(naive));
  expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBe("breakout");
  expect(await page.locator("head script, body script").count()).toBeGreaterThan(1);
  await expect
    .poll(async () => page.evaluate(() => {
      try {
        JSON.parse(document.getElementById("ld")!.textContent!);
        return "parsed";
      } catch {
        return "broken";
      }
    }))
    .toBe("broken");
});
