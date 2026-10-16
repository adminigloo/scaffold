import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * Released with `@adminigloo/invoicing` 0.4 (Tenancy 2b-1, 11.6): the widget
 * names the server as an OPTIONAL peer so installing it beside an older
 * server warns at install time, and the release that publishes the widget
 * publishes the server too (both changesets sit side by side). No screen or
 * wire change in this release, so the widget is a patch.
 */
describe("released together with the server (Tenancy 2b-1)", () => {
  const manifest = json("../../package.json");

  it("declares @adminigloo/invoicing ^0.4.0 as an optional peer", () => {
    expect(manifest.peerDependencies?.["@adminigloo/invoicing"]).toBe("^0.4.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/invoicing"]?.optional).toBe(true);
  });

  it("is versioned in the same changeset run as invoicing: the widget a patch, the server a minor", () => {
    const dir = resolve(here, "../../../../.changeset");
    const read = (name: string) => {
      const path = resolve(dir, name);
      expect(existsSync(path), `.changeset/${name} is missing`).toBe(true);
      return readFileSync(path, "utf8");
    };
    expect(read("tenancy-2b1-invoicing-widget.md")).toContain('"@adminigloo/invoicing-widget": patch');
    expect(read("tenancy-2b1-invoicing.md")).toContain('"@adminigloo/invoicing": minor');
  });
});
