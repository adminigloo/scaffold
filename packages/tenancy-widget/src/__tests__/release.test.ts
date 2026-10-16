import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * The widget can't ship ahead of the server it talks to (review T1-14,
 * TB-DEPLOY-12). So it names the server as a peer (optional: a header-only
 * install needs nothing else), and the release that publishes it also
 * publishes the server: the server's changeset sits beside the widget's.
 *
 * Tenancy 2b-1's changesets (2a's were consumed by `changeset version`, which
 * is why this test is rewritten each chunk: it pins the release in flight).
 * The widget is a patch (no component or wire change, the peer moves); the
 * server is a minor (event ids and people, settled events, members holding a
 * permission, the logo store told the company, the team's alert kinds).
 */
describe("released together with the server (Tenancy 2b-1)", () => {
  const manifest = json("../../package.json");

  it("declares @adminigloo/tenancy ^0.6.0 as an optional peer", () => {
    expect(manifest.peerDependencies?.["@adminigloo/tenancy"]).toBe("^0.6.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/tenancy"]?.optional).toBe(true);
  });

  it("is versioned in the same changeset run as tenancy: the widget a patch, the server a minor", () => {
    const dir = resolve(here, "../../../../.changeset");
    const read = (name: string) => {
      const path = resolve(dir, name);
      expect(existsSync(path), `.changeset/${name} is missing`).toBe(true);
      return readFileSync(path, "utf8");
    };
    expect(read("tenancy-2b1-tenancy-widget.md")).toContain('"@adminigloo/tenancy-widget": patch');
    expect(read("tenancy-2b1-tenancy.md")).toContain('"@adminigloo/tenancy": minor');
  });
});
