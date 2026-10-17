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

  it("is versioned in the same release as invoicing: both minors (the changesets, or once versioned, the changelogs)", () => {
    const changesets = resolve(here, "../../../../.changeset");
    const pending = resolve(changesets, "getting-paid-invoicing-widget.md");
    if (existsSync(pending)) {
      expect(readFileSync(pending, "utf8")).toContain('"@adminigloo/invoicing-widget": minor');
      expect(readFileSync(resolve(changesets, "getting-paid-invoicing.md"), "utf8")).toContain('"@adminigloo/invoicing": minor');
      return;
    }
    // Versioned: the widget's 0.2.0 and the server's 0.5.0 are in their changelogs, released together.
    expect(manifest.version).toBe("0.2.0");
    expect(readFileSync(resolve(here, "../../CHANGELOG.md"), "utf8")).toContain("## 0.2.0");
    expect(readFileSync(resolve(here, "../../../invoicing/CHANGELOG.md"), "utf8")).toContain("## 0.5.0");
    expect(json("../../../invoicing/package.json").version).toBe("0.5.0");
  });
});
