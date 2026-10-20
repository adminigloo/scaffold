import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * The widget can't ship ahead of the server it talks to (review T1-14, TB-DEPLOY-12). It names the server as an optional peer (a header-only install needs nothing else).
 *
 * THE INVARIANT, NOT THE RELEASE IN FLIGHT. This test used to pin one release
 * (a version and the changeset files of that chunk), so it went red on main
 * the moment the next release moved the server or consumed the changesets.
 * What must always hold: the widget names the server's CURRENT minor as an
 * optional peer, so the two are never published out of step.
 */
describe("released with its server", () => {
  it("names @adminigloo/tenancy at the server's current minor, as an optional peer", () => {
    const manifest = json("../../package.json");
    const [major, minor] = String(json("../../../tenancy/package.json").version).split(".");
    expect(manifest.peerDependencies?.["@adminigloo/tenancy"]).toBe(`^${major}.${minor}.0`);
    expect(manifest.peerDependenciesMeta?.["@adminigloo/tenancy"]?.optional).toBe(true);
  });
});
