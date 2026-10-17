import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * Released with `@adminigloo/invoicing` 0.5 (getting paid, part 1): Pay now
 * and the deposit need the server's new routes and wire fields, so the widget
 * names the server ^0.5.0 as an OPTIONAL peer and both are versioned in the
 * same run, each a minor.
 */
describe("released together with the server (getting paid, part 1)", () => {
  const manifest = json("../../package.json");

  it("declares @adminigloo/invoicing ^0.5.0 as an optional peer", () => {
    expect(manifest.peerDependencies?.["@adminigloo/invoicing"]).toBe("^0.5.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/invoicing"]?.optional).toBe(true);
  });

  it("is versioned in the same changeset run as invoicing: both minors", () => {
    const dir = resolve(here, "../../../../.changeset");
    const read = (name: string) => {
      const path = resolve(dir, name);
      expect(existsSync(path), `.changeset/${name} is missing`).toBe(true);
      return readFileSync(path, "utf8");
    };
    expect(read("getting-paid-invoicing-widget.md")).toContain('"@adminigloo/invoicing-widget": minor');
    expect(read("getting-paid-invoicing.md")).toContain('"@adminigloo/invoicing": minor');
  });
});
