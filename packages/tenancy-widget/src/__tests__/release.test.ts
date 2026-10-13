import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(resolve(here, path), "utf8")) as Record<string, any>;

/**
 * The widget can't ship ahead of the server it talks to (review T1-14,
 * TB-DEPLOY-12). Released alone, every call would 404 and read "That isn't
 * here any more." So it names the server as a peer (optional: a header-only
 * install needs nothing else), and the release that publishes it also
 * publishes tenancy 0.4 — the server changeset sits beside the widget's.
 */
describe("released together with the server", () => {
  const manifest = json("../../package.json");

  it("declares @adminigloo/tenancy ^0.4.0 as an optional peer", () => {
    expect(manifest.peerDependencies?.["@adminigloo/tenancy"]).toBe("^0.4.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/tenancy"]?.optional).toBe(true);
  });

  it("is versioned in the same changeset run as tenancy, permissions, auth and trpc", () => {
    const dir = resolve(here, "../../../../.changeset");
    const read = (name: string) => readFileSync(resolve(dir, name), "utf8");
    expect(read("tenancy-1-tenancy-widget.md")).toContain('"@adminigloo/tenancy-widget": minor');
    expect(read("tenancy-1-tenancy.md")).toContain('"@adminigloo/tenancy": minor');
    expect(read("tenancy-1-permissions.md")).toContain('"@adminigloo/permissions": minor');
    expect(read("tenancy-1-auth.md")).toContain('"@adminigloo/auth": minor');
    expect(read("tenancy-1-trpc.md")).toContain('"@adminigloo/trpc": minor');
  });
});
