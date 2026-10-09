import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "@adminigloo/analytics/crawlers";
import { describe, expect, it } from "vitest";
import { botListFingerprint, ROBOTS_BOTS, ROBOTS_BOTS_SOURCE } from "../index.js";

/**
 * The bot list is compiled into this package from @adminigloo/analytics at
 * build time, and analytics is only a devDependency, so changesets never
 * releases this package because analytics changed. Without these guards
 * analytics 0.3 could add a crawler and the published @adminigloo/seo would
 * keep writing the old robots.txt until someone happened to release it.
 *
 *   1. The list analytics has NOW must be the one stamped in bots.lock.json,
 *      or a changeset for @adminigloo/seo must be pending (the release that
 *      ships the new list is queued). After that release, `stamp:bots`
 *      records it.
 *   2. A built dist must carry the list analytics has now (a stale dist is a
 *      stale release).
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const changesetDir = fileURLToPath(new URL("../../../../.changeset", import.meta.url));
const lock = JSON.parse(readFileSync(`${root}/bots.lock.json`, "utf8")) as { fingerprint: string; analytics: string; bots: string[] };
const live = botListFingerprint([...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS]);

/** The pending changesets that release @adminigloo/seo. */
function pendingSeoChangesets(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
    .filter((file) => {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(`${dir}/${file}`, "utf8"));
      return Boolean(front && /^\s*["']?@adminigloo\/seo["']?\s*:\s*(patch|minor|major)\s*$/m.test(front[1]!));
    });
}

/** Why the published list could fall behind analytics', or null when it cannot. */
function driftProblem(liveFingerprint: string, stamped: string, pending: readonly string[]): string | null {
  if (liveFingerprint === stamped || pending.length > 0) return null;
  return (
    `@adminigloo/analytics' crawler list changed (fingerprint ${liveFingerprint}; bots.lock.json has ${stamped}) and no ` +
    "@adminigloo/seo changeset is pending, so the published robots.txt would keep the old list. Add a changeset for " +
    "@adminigloo/seo; once it is released, run `pnpm --filter @adminigloo/seo stamp:bots`."
  );
}

describe("the published bot list cannot fall behind @adminigloo/analytics", () => {
  it("analytics' list is the one this package last shipped, or a release of this package is queued", () => {
    expect(driftProblem(live, lock.fingerprint, pendingSeoChangesets(changesetDir))).toBeNull();
  });

  it("the guard fails on a changed list with no queued release, and passes once one is queued", () => {
    expect(driftProblem("aaaa", "bbbb", [])).toMatch(/no @adminigloo\/seo changeset is pending/);
    expect(driftProblem("aaaa", "bbbb", ["seo-new-bots.md"])).toBeNull();
    expect(driftProblem("aaaa", "aaaa", [])).toBeNull();
  });

  it("reads a changeset's front matter, not its prose", () => {
    const front = (body: string) => /^\s*["']?@adminigloo\/seo["']?\s*:\s*(patch|minor|major)\s*$/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "");
    expect(front('---\n"@adminigloo/seo": patch\n---\n\nNew bots.\n')).toBe(true);
    expect(front('---\n"@adminigloo/analytics": minor\n---\n\n"@adminigloo/seo": patch is mentioned here only.\n')).toBe(false);
  });

  it("fingerprints what robots.txt is built from: a new bot, a new token or a new kind changes it; tokenless bots do not", () => {
    const list = [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS];
    expect(botListFingerprint(list)).toBe(botListFingerprint(ROBOTS_BOTS));
    expect(botListFingerprint([...list, { name: "NewBot", kind: "ai-training", robotsTokens: ["NewBot"] }])).not.toBe(live);
    expect(botListFingerprint(list.map((bot) => (bot.name === "GPTBot" ? { ...bot, kind: "ai-search" as const } : bot)))).not.toBe(live);
    expect(botListFingerprint([...list, { name: "Silent", kind: "other", robotsTokens: [] }])).toBe(live);
  });

  it("says which analytics list this build carries", () => {
    const analytics = JSON.parse(readFileSync(`${root}/node_modules/@adminigloo/analytics/package.json`, "utf8")) as { version: string };
    expect(ROBOTS_BOTS_SOURCE).toEqual({ analytics: analytics.version, fingerprint: live });
  });

  const dist = `${root}/dist/index.js`;
  it.runIf(existsSync(dist))("(after build) the built dist carries the list analytics has now, stamped with its version", async () => {
    const built = (await import(/* @vite-ignore */ new URL("../../dist/index.js", import.meta.url).href)) as typeof import("../index.js");
    expect(built.ROBOTS_BOTS_SOURCE.fingerprint).toBe(live);
    expect(built.botListFingerprint(built.ROBOTS_BOTS)).toBe(live);
    expect(built.ROBOTS_BOTS_SOURCE.analytics).toMatch(/^\d+\.\d+\.\d+/);
  });
});
