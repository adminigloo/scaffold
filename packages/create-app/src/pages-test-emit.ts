/**
 * THE PUBLIC PAGES, AS A CRAWLER READS THEM (create-app 0.39): a generated
 * test that boots the BUILT site (`next start`) and asks, the way a search
 * engine or an AI crawler does, for every page this project lists in its
 * sitemap — and checks the two things a group-wide `loading.tsx` broke:
 *
 *   - real status codes: 200 for a public page, 404 for a page that isn't
 *     there, a 307 for a signed-in page asked for signed out — never a 200
 *     with a "Loading" shell and a meta refresh;
 *   - the page's <h1> in the first HTML the server sends, before any
 *     streamed (Suspense) content: a crawler that reads only the shell must
 *     read the page.
 *
 *   pnpm build && pnpm test:pages
 *
 * Its own vitest config (vitest.pages.config.ts) so `pnpm test` never needs a
 * build; CI runs it after the build. PAGES_BASE_URL points it at a site
 * that's already running instead.
 */
import type { Answers } from "./answers.js";

export interface PagesTestInput {
  /** Every public path the sitemap lists. */
  readonly pages: readonly string[];
  /** A signed-in page asked for signed out, and where its 307 must point. */
  readonly redirects: readonly { readonly path: string; readonly to: string }[];
}

export function renderPagesTestConfig(): string {
  return `import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * THE PUBLIC-PAGES TEST'S OWN CONFIG (create-app 0.39): \`pnpm test:pages\`,
 * after \`pnpm build\`. Kept out of \`pnpm test\` (vitest.config.ts) because it
 * boots the built site.
 */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/pages/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
`;
}

export function renderPagesTest(answers: Answers, input: PagesTestInput): string {
  return `import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE PUBLIC PAGES, AS A CRAWLER READS THEM (create-app 0.39), against the
 * BUILT site: \`pnpm build && pnpm test:pages\`. Each page this project lists
 * in its sitemap answers a real 200 with its <h1> in the shell — the HTML sent
 * before anything streams in — and a missing page a real 404; a signed-in page
 * asked for signed out a real 307.
 *
 * WHY. A \`loading.tsx\` over the public pages wraps them in a Suspense
 * boundary: the response starts (as a 200) before the page has rendered, the
 * content arrives later in hidden blocks, a redirect becomes a 200 with a meta
 * refresh, and a not-found becomes a 200 a search engine indexes. Crawlers
 * reading the first chunk saw "Loading". This test fails if that comes back.
 *
 * Asked as a crawler (GPTBot's user agent), because that is who it is for.
 * PAGES_BASE_URL points it at a site already running instead of starting one.
 * Generated with the pages ${answers.projectName} had; add yours to PAGES.
 */
const PAGES: readonly string[] = ${JSON.stringify(input.pages)};

/** Signed-in pages asked for signed out: a real 307, to where. */
const REDIRECTS: readonly { readonly path: string; readonly to: string }[] = ${JSON.stringify(input.redirects)};

const CRAWLER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

let base = process.env.PAGES_BASE_URL?.replace(/\\/$/, "") ?? "";
let server: ChildProcess | null = null;
let serverLog = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(\`The site didn't start at \${url} within \${timeoutMs / 1000}s:\\n\${serverLog.slice(-2000)}\`);
}

beforeAll(async () => {
  if (base) return;
  if (!existsSync(".next/BUILD_ID")) {
    throw new Error("There's no build to test. Run pnpm build first, or set PAGES_BASE_URL to a site that's running.");
  }
  const port = await freePort();
  base = \`http://127.0.0.1:\${port}\`;
  // Node runs Next's own bin directly: no shell, the same on every platform.
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  // NODE_ENV is "production", not the "test" Vitest runs under: under "test"
  // Next doesn't read .env.local, so the site starts without its Clerk key and
  // every page answers 500 ("Missing secretKey").
  //
  // No \`-H 127.0.0.1\`. Bound to that address alone, Next 16.2 hands each page
  // request back to itself at http://localhost:<port> ("Failed to proxy"):
  // ::1 refuses, 127.0.0.1 loops, and in seconds the machine has tens of
  // thousands of sockets waiting and every page answers 500 after 25 s.
  server = spawn(process.execPath, [next, "start", "-p", String(port)], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));
  await waitForServer(base, 90_000);
});

afterAll(() => {
  server?.kill();
});

/**
 * No \`Accept: text/html\`. On a Clerk DEVELOPMENT key (every machine but
 * production) Clerk sends any request that asks for a document and has no
 * dev-browser cookie to its handshake (a 307 to *.clerk.accounts.dev), so
 * every page would answer 307 and nothing else be tested. Next serves the
 * same HTML without it.
 */
async function get(path: string): Promise<Response> {
  return fetch(\`\${base}\${path}\`, { redirect: "manual", headers: { "user-agent": CRAWLER } });
}

/**
 * Where the shell ends: the first streamed (Suspense) boundary in the HTML,
 * or the end. A pending boundary is \`<!--$?-->\`; its content arrives later
 * in \`<div hidden id="S:…">\`.
 */
function shellEnd(html: string): number {
  const marks = ["<!--$?-->", '<div hidden id="S:', '<template id="B:'].map((mark) => html.indexOf(mark)).filter((at) => at >= 0);
  return marks.length === 0 ? html.length : Math.min(...marks);
}

describe("the public pages, as a crawler reads them", () => {
  it.each(PAGES)("%s answers 200 with its <h1> in the first HTML", async (path) => {
    const response = await get(path);
    expect(response.status, \`\${path} answered \${response.status}\`).toBe(200);
    const html = await response.text();
    const h1 = html.search(/<h1[\\s>]/);
    expect(h1, \`\${path} has no <h1> at all\`).toBeGreaterThanOrEqual(0);
    expect(h1, \`\${path}'s <h1> only arrives after the shell (a Suspense or loading.tsx boundary hides it from crawlers)\`).toBeLessThan(shellEnd(html));
    expect(html.slice(0, shellEnd(html)), \`\${path} sends a meta refresh, a redirect dressed as a 200\`).not.toMatch(/http-equiv="refresh"/i);
  });

  it("a page that isn't there is a real 404, not a 200 that says so", async () => {
    const response = await get(\`/no-such-page-\${Date.now()}\`);
    expect(response.status).toBe(404);
  });

  for (const { path, to } of REDIRECTS) {
    it(\`\${path}, signed out, is a real 307 to \${to}\`, async () => {
      const response = await get(path);
      expect(response.status, \`\${path} answered \${response.status}\`).toBe(307);
      expect(response.headers.get("location") ?? "").toContain(to);
    });
  }
});
`;
}
