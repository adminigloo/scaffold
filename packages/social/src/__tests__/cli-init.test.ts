import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAi, findDb, findSchema, importPath, planInit } from "../cli/init.js";
import { applyPlan, main } from "../cli/main.js";

/**
 * `npx adminigloo-social init` (../cli): on two apps laid out as Riddler Go
 * (app/, db/client.ts, an OpenAI key) and Trail Deck (src/app, src/server/db,
 * the AI SDK with Anthropic) are, it finds each app's pieces, writes the
 * glue, the routes and the page beside them, adds the table to the schema
 * and a card key to .env.local, never overwrites anything, and leaves the
 * screen closed until the app's staff check is wired.
 */
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function app(layout: "riddler" | "traildeck"): string {
  const root = mkdtempSync(join(tmpdir(), `social-init-${layout}-`));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  if (layout === "riddler") {
    put("package.json", JSON.stringify({ name: "riddler-go", dependencies: { next: "16.2.12", "drizzle-orm": "^0.45.2", react: "19.2.4" } }));
    put("app/admin/layout.tsx", "export default function L({ children }) { return children; }\n");
    put("db/client.ts", "export const db = {} as never;\n");
    put("db/schema/index.ts", 'export * from "./events";\n');
    put("drizzle.config.ts", 'export default { schema: "./db/schema/index.ts", out: "./db/migrations", dialect: "postgresql" };\n');
    put(".env.local", "OPENAI_API_KEY=sk-test\n");
  } else {
    put("package.json", JSON.stringify({ name: "trailcards", dependencies: { next: "16.1.1", "drizzle-orm": "^0.45.1", ai: "^6.0.0", "@ai-sdk/anthropic": "^3.0.0" } }));
    put("src/app/admin/layout.tsx", "export default function L({ children }) { return children; }\n");
    put("src/server/db/index.ts", "export const db = {} as never;\n");
    put("src/server/db/schema/index.ts", 'export * from "./orders";\n');
    put("drizzle.config.ts", 'export default { schema: "./src/server/db/schema/index.ts", out: "./src/server/db/migrations", dialect: "postgresql" };\n');
  }
  return root;
}

describe("init finds the app's own pieces", () => {
  it("in an app laid out like Riddler Go: app/, db/client.ts, the schema, and OpenAI from its key", () => {
    const root = app("riddler");
    expect(findDb(root)).toBe(join(root, "db/client.ts"));
    expect(findSchema(root)).toBe(join(root, "db/schema/index.ts"));
    expect(detectAi(root)).toBe("openai");
    const plan = planInit({ root, secret: "test-secret" });
    expect(plan.found).toEqual({ appDir: "app", db: join("db", "client.ts"), schema: join("db", "schema", "index.ts") });
    expect(plan.warnings).toEqual([]);
  });

  it("in an app laid out like Trail Deck: src/app, src/server/db, and the AI SDK with Anthropic", () => {
    const root = app("traildeck");
    expect(findDb(root)).toBe(join(root, "src/server/db/index.ts"));
    expect(detectAi(root)).toBe("ai-sdk-anthropic");
    expect(planInit({ root, secret: "s" }).found.appDir).toBe(join("src", "app"));
  });

  it("writes imports that resolve from each file to the next", () => {
    expect(importPath("/a/lib/social-posts.ts", "/a/db/client.ts")).toBe("../db/client");
    expect(importPath("/a/src/lib/social-posts.ts", "/a/src/server/db/index.ts")).toBe("../server/db");
    expect(importPath("/a/app/api/admin/posts/[...path]/route.ts", "/a/lib/social-posts.ts")).toBe("../../../../../lib/social-posts");
  });
});

describe("init writes the glue, and only once", () => {
  it("writes the glue, both routes and the page, the table into the schema and a card key into .env.local", () => {
    const root = app("riddler");
    const applied = applyPlan(planInit({ root, secret: "test-secret" }));
    expect(applied.kept).toEqual([]);
    const glue = readFileSync(join(root, "lib/social-posts.ts"), "utf8");
    expect(glue).toContain('import { db } from "../db/client";');
    expect(glue).toContain('import { createOpenAIComplete, openAIFetchClient } from "@adminigloo/social/openai";');
    expect(glue).toContain('export const SOCIAL_SITE_NAME = process.env.SOCIAL_SITE_NAME ?? "Riddler Go";');
    // Closed until the app wires its staff check.
    expect(glue).toMatch(/async function authorize\([^)]*\): Promise<SocialAuthorizeResult> \{\n {2}\/\/ Closed until you wire your own staff check here\.\n {2}return false;/);
    expect(glue).toContain("tagLinks: true");
    expect(glue).toContain("life: SOCIAL_LIFE");
    expect(readFileSync(join(root, "app/api/admin/posts/[...path]/route.ts"), "utf8")).toContain('from "../../../../../lib/social-posts"');
    expect(readFileSync(join(root, "app/api/social/card/route.tsx"), "utf8")).toContain("createCardRoute");
    expect(readFileSync(join(root, "app/admin/posts/page.tsx"), "utf8")).toContain('<PostsAdmin baseUrl="/api/admin/posts"');
    expect(readFileSync(join(root, "db/schema/index.ts"), "utf8")).toContain('export { socialPosts } from "@adminigloo/social/schema";');
    const env = readFileSync(join(root, ".env.local"), "utf8");
    expect(env).toContain("OPENAI_API_KEY=sk-test");
    expect(env).toContain("SOCIAL_CARD_SECRET=test-secret");
  });

  it("never overwrites: a second run keeps every file and adds no line twice", () => {
    const root = app("traildeck");
    applyPlan(planInit({ root, secret: "first" }));
    writeFileSync(join(root, "src/lib/social-posts.ts"), "// mine now\n");
    const again = applyPlan(planInit({ root, secret: "second" }));
    expect(again.written).toEqual([]);
    expect(readFileSync(join(root, "src/lib/social-posts.ts"), "utf8")).toBe("// mine now\n");
    expect(readFileSync(join(root, ".env.local"), "utf8").match(/SOCIAL_CARD_SECRET=/g)).toHaveLength(1);
    expect(readFileSync(join(root, "src/server/db/schema/index.ts"), "utf8").match(/@adminigloo\/social\/schema/g)).toHaveLength(1);
  });

  it("writes the Trail Deck glue on the AI SDK with Claude Haiku 4.5, or on no AI when asked", () => {
    const root = app("traildeck");
    applyPlan(planInit({ root, secret: "s" }));
    const glue = readFileSync(join(root, "src/lib/social-posts.ts"), "utf8");
    expect(glue).toContain('import { anthropic } from "@ai-sdk/anthropic";');
    expect(glue).toContain('anthropic(process.env.SOCIAL_AI_MODEL ?? "claude-haiku-4-5")');
    expect(glue).toContain('import { db } from "../server/db";');
    const none = app("riddler");
    applyPlan(planInit({ root: none, ai: "none", secret: "s" }));
    expect(readFileSync(join(none, "lib/social-posts.ts"), "utf8")).not.toContain("@adminigloo/social/openai");
  });
});

describe("the command", () => {
  it("says what it would write in a dry run, writes nothing, and never prints the card key", () => {
    const root = app("riddler");
    const lines: string[] = [];
    expect(main(["init", "--dry-run"], root, (l) => lines.push(l))).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("dry run: nothing written");
    expect(out).toContain("would write");
    expect(out).toContain("Wire authorize in");
    expect(out).not.toMatch(/SOCIAL_CARD_SECRET=\S/);
    expect(existsSync(join(root, "lib/social-posts.ts"))).toBe(false);
  });

  it("refuses an unknown AI, and helps without a command", () => {
    const lines: string[] = [];
    expect(main(["init", "--ai", "gemini"], app("riddler"), (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("--ai must be one of");
    expect(main([], "/", (l) => lines.push(l))).toBe(0);
  });
});
