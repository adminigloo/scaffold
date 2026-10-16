import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTIFICATIONS_ADMIN_ROUTES } from "@adminigloo/notifications";

/**
 * Wire parity (Tenancy 2b-1, 4.8). The widget declares the wire types itself
 * (src/types.ts) so it never imports the server package at runtime; the
 * server declares the same region in packages/notifications/src/wire.ts. This
 * test reads BOTH files and requires the region between the WIRE markers to
 * be byte-identical (line endings aside). The devDependency on
 * @adminigloo/notifications is used ONLY here: the client's paths are checked
 * against the server's own route table.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function wireRegion(source: string): string | null {
  const text = source.replace(/\r\n/g, "\n");
  if (text.split("// WIRE:BEGIN").length !== 2 || text.split("// WIRE:END").length !== 2) return null;
  const from = text.indexOf("// WIRE:BEGIN");
  const to = text.indexOf("// WIRE:END");
  return to > from ? text.slice(from, to + "// WIRE:END".length) : null;
}

describe("wire parity with @adminigloo/notifications", () => {
  it("the WIRE regions are byte-identical", () => {
    const mine = wireRegion(readFileSync(resolve(here, "../types.ts"), "utf8"));
    const theirs = wireRegion(readFileSync(resolve(here, "../../../notifications/src/wire.ts"), "utf8"));
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(mine).toBe(theirs);
  });

  it("the client speaks every route the server's table lists, by method and path", () => {
    const client = readFileSync(resolve(here, "../client.ts"), "utf8");
    expect(NOTIFICATIONS_ADMIN_ROUTES.length).toBe(8);
    for (const route of NOTIFICATIONS_ADMIN_ROUTES) {
      const path = `/${route.path.replace("{alert}", "${segment(id)}")}`;
      const verb = route.method === "GET" ? "get" : "post";
      expect(client.includes(path), `${route.kind}: ${path}`).toBe(true);
      // The call that uses this path is made with the route's method.
      const pattern = new RegExp(`http\\.${verb}\\(\`?"?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      expect(pattern.test(client), `${route.kind}: http.${verb}(${path}`).toBe(true);
    }
  });
});
