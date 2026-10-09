import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAnalytics } from "../instance.js";
import { DEFAULT_LIMITS, type AnalyticsDb } from "../context.js";
import { AI_ENGINES } from "../sources.js";
import { DEFAULT_CRAWLER_RANGE_SOURCES } from "../verify.js";
import { classifyCrawler } from "../crawlers.js";

/**
 * "Exact behaviour documented": the README's tables and code are pinned to
 * the code they describe, so a change to one without the other fails here.
 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/** The cells of the table row whose first cell starts with `first`. */
function row(first: string): string[] {
  const line = README.split("\n").find((text) => text.startsWith(`| ${first}`));
  if (!line) throw new Error(`no README row starting with ${first}`);
  return line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const list = (cell: string) => cell.split(",").map((item) => item.trim());

describe("the README", () => {
  it("names only methods the instance has", () => {
    const instance = createAnalytics({ db: {} as AnalyticsDb });
    const called = new Set([...README.matchAll(/\b(?:analytics|aig)\.(\w+)\(/g)].map((match) => match[1]!));
    expect(called.size).toBeGreaterThan(10);
    expect([...called].filter((name) => !(name in instance))).toEqual([]);
    expect(called).toContain("markVisitorInternal");
  });

  it("states every limit's default as DEFAULT_LIMITS has it", () => {
    for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
      const [, documented] = row(`\`${name}\``);
      expect([name, Number(documented!.replace(/\s/g, ""))]).toEqual([name, value]);
    }
  });

  it("lists exactly the AI engines' hosts", () => {
    for (const engine of AI_ENGINES.slice(0, 5)) {
      const [, hosts] = row(`\`${engine.id}\``);
      expect([engine.id, list(hosts!)]).toEqual([engine.id, [...engine.hosts]]);
    }
    const rest = AI_ENGINES.slice(5);
    const [ids, hosts] = row(rest.map((engine) => `\`${engine.id}\``).join(", "));
    expect(ids).toBe(rest.map((engine) => `\`${engine.id}\``).join(", "));
    expect(list(hosts!)).toEqual(rest.flatMap((engine) => [...engine.hosts]));
  });

  it("names exactly the crawlers that can be verified, and only unverifiable ones as unverifiable", () => {
    const bullet = README.split("\n").find((line) => line.startsWith("- **Crawler verification only where"))!;
    const [verifiable, unverifiable] = bullet.split("Every other bot");
    const named = [...verifiable!.matchAll(/\(([^)]+)\)/g)].flatMap((match) => list(match[1]!));
    expect(named.sort()).toEqual(Object.keys(DEFAULT_CRAWLER_RANGE_SOURCES).sort());
    const never = list(unverifiable!.split(":")[1]!.replace(/ and the rest\..*$/, "").replace(/\band\b/g, ","))
      .map((name) => name.replace(/\.$/, ""))
      .filter(Boolean);
    expect(never.length).toBeGreaterThan(4);
    for (const name of never) {
      expect([name, name in DEFAULT_CRAWLER_RANGE_SOURCES]).toEqual([name, false]);
      expect([name, classifyCrawler(`Mozilla/5.0 (compatible; ${name}/1.0)`)?.name]).toEqual([name, name]);
    }
  });
});
