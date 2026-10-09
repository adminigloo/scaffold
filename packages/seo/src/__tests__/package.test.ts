import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const README = readFileSync(`${root}/README.md`, "utf8");

describe("tree-shaking (after build)", () => {
  const dist = `${root}/dist/index.js`;
  it.runIf(existsSync(dist))("a proxy that imports only robotsHeader does not carry the bot list", async () => {
    // esbuild through tsup, the bundler this repo already builds with.
    type Build = (options: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }> }>;
    const esbuild = createRequire(createRequire(`${root}/package.json`).resolve("tsup"))("esbuild") as { build: Build };
    const bundle = async (contents: string) =>
      (
        await esbuild.build({
          stdin: { contents, resolveDir: root, loader: "js" },
          bundle: true,
          write: false,
          minify: true,
          format: "esm",
          platform: "neutral",
          logLevel: "silent",
        })
      ).outputFiles[0]!.text;
    const proxy = await bundle(`import { robotsHeader } from "./dist/index.js"; export const tag = robotsHeader;`);
    expect(proxy).not.toContain("OAI-SearchBot");
    expect(proxy).not.toContain("GPTBot");
    expect(proxy.length).toBeLessThan(8_000);
    const robots = await bundle(`import { robotsPolicy } from "./dist/index.js"; export const r = robotsPolicy;`);
    expect(robots).toContain("OAI-SearchBot");
  });
});

describe("package.json", () => {
  it("gives `require` the CommonJS types (.d.cts) and `import` the ESM types (.d.ts), for every entry", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./og", "./react"]);
    for (const [entry, conditions] of Object.entries(pkg.exports)) {
      const base = entry === "." ? "index" : entry.slice(2);
      expect([entry, conditions]).toEqual([
        entry,
        {
          import: { types: `./dist/${base}.d.ts`, default: `./dist/${base}.js` },
          require: { types: `./dist/${base}.d.cts`, default: `./dist/${base}.cjs` },
        },
      ]);
    }
  });

  it("has no runtime dependencies, and only optional peers (vendorable as a tarball)", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["next", "react"]);
    for (const peer of Object.keys(pkg.peerDependencies)) expect(pkg.peerDependenciesMeta[peer]).toEqual({ optional: true });
    expect(pkg.files).toEqual(["dist", "README.md", "CHANGELOG.md"]);
    expect(pkg.publishConfig).toEqual({ registry: "https://npm.pkg.github.com", access: "public" });
    expect(pkg.version).toBe("0.1.0");
  });
});

describe("the core entry stays pure", () => {
  it("imports no React, no Next and no Node API from any core source file", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const core = readdirSync(src).filter((file) => /\.ts$/.test(file));
    expect(core).toContain("index.ts");
    for (const file of core) {
      const source = readFileSync(`${src}/${file}`, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const target of imports) {
        expect([file, target, /^(react|react-dom|next)(\/|$)|^node:/.test(target)]).toEqual([file, target, false]);
      }
    }
  });

  it("builds the bot list from @adminigloo/analytics' crawlers, never a copy", () => {
    const bots = readFileSync(fileURLToPath(new URL("../bots.ts", import.meta.url)), "utf8");
    expect(bots).toContain('from "@adminigloo/analytics/crawlers"');
    expect(bots).not.toMatch(/"GPTBot"|"ClaudeBot"/);
  });

  const dist = `${root}/dist`;
  it.runIf(existsSync(`${dist}/index.js`))("(after build) bundles the crawler list, references no analytics type, and stamps no 'use client'", () => {
    for (const file of ["index.js", "index.cjs"]) {
      const code = readFileSync(`${dist}/${file}`, "utf8");
      expect(code).not.toMatch(/from ["']@adminigloo\/analytics|require\(["']@adminigloo\/analytics/);
      expect(code).toContain("OAI-SearchBot");
    }
    for (const file of ["index.d.ts", "index.d.cts"]) {
      const types = readFileSync(`${dist}/${file}`, "utf8");
      expect(types).not.toMatch(/from ["']@adminigloo\/analytics/);
      // `ShareImage` is ./og's component; the core's image type is ShareImageMeta, so one name never means two things.
      expect(types).toMatch(/\bShareImageMeta\b/);
      expect(types).not.toMatch(/(?:interface|type)\s+ShareImage\b(?!Meta|Input)|[{,]\s*(?:type\s+)?ShareImage\s*[,}]/);
    }
    for (const file of ["index.js", "react.js", "og.js", "react.cjs"]) {
      expect(readFileSync(`${dist}/${file}`, "utf8").trimStart()).not.toMatch(/^["']use client["']/);
    }
    expect(readFileSync(`${dist}/og.js`, "utf8")).toMatch(/from ["']next\/og["']/);
  });
});

describe("README", () => {
  it("has the install-recipe table and the not-included list", () => {
    expect(README).toContain("| You install / import | You get | You wire yourself |");
    const notIncluded = README.split("### Not included")[1]!.split("\n## ")[0]!;
    for (const item of ["@adminigloo/seo-reports", "@adminigloo/search-console", "@adminigloo/aeo", "Content writing"]) expect(notIncluded).toContain(item);
  });

  it("names every function the core entry exports", () => {
    const functions = Object.entries(api)
      .filter(([, value]) => typeof value === "function" && !/^[A-Z]/.test((value as { name: string }).name))
      .map(([name]) => name);
    const missing = functions.filter((name) => !README.includes(`\`${name}`) && !README.includes(`${name}(`));
    expect(missing).toEqual([]);
  });

  it("says how Riddler Go replaces its schemas, JsonLd, robots builder and llms content", () => {
    for (const file of ["components/seo/schemas.ts", "components/seo/JsonLd.tsx", "app/robots.ts", "lib/seo/llms-content.ts"]) expect(README).toContain(file);
  });

  it("carries no legal or policy commentary", () => {
    expect(README).not.toMatch(/privacy|legal advice|terms of service|gdpr|cookie/i);
  });

  it("states the limits a site owner decides by: dual-use training bots, advisory user fetchers, the retired search box, the off-production trade-off", () => {
    expect(README).toMatch(/Google-Extended also controls grounding in Gemini Apps, Meta-ExternalAgent also indexes for Meta AI, and Amazonbot also feeds Alexa/);
    expect(README).toMatch(/A deny here is mostly a request/);
    expect(README).toMatch(/Google retired the sitelinks search box/);
    expect(README).toMatch(/a staging host that is already in an index cannot drop out while it is disallowed/);
    expect(README).toMatch(/@adminigloo\/search-console` \(planned, not built yet\)/);
  });

  it("shows the database-row sitemap with onInvalid, and the CI-safe site URL", () => {
    const sitemap = README.split("### 4. The sitemap")[1]!.split("###")[0]!;
    expect(sitemap).toContain("onInvalid");
    expect(README).toContain('url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"');
    expect(README).not.toMatch(/`\/sitemaps\/\{?id/);
  });
});
