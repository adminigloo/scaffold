import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * The widget can't ship ahead of the server it talks to (review T1-14,
 * TB-DEPLOY-12). Released alone, a Crew row or a company's brand bar would
 * meet a server that doesn't send them. So it names the server as a peer
 * (optional: a header-only install needs nothing else), and the release that
 * publishes it also publishes tenancy 0.5: the server changeset sits beside
 * the widget's.
 *
 * Tenancy 2a's changesets (Tenancy 1's were consumed by `changeset version`).
 */
describe("released together with the server (Tenancy 2a)", () => {
  const manifest = json("../../package.json");

  it("declares @adminigloo/tenancy ^0.5.0 as an optional peer", () => {
    expect(manifest.peerDependencies?.["@adminigloo/tenancy"]).toBe("^0.5.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/tenancy"]?.optional).toBe(true);
  });

  it("is versioned in the same changeset run as tenancy, each a minor", () => {
    const dir = resolve(here, "../../../../.changeset");
    const read = (name: string) => {
      const path = resolve(dir, name);
      expect(existsSync(path), `.changeset/${name} is missing`).toBe(true);
      return readFileSync(path, "utf8");
    };
    expect(read("tenancy-2a-tenancy-widget.md")).toContain('"@adminigloo/tenancy-widget": minor');
    expect(read("tenancy-2a-tenancy.md")).toContain('"@adminigloo/tenancy": minor');
  });
});
