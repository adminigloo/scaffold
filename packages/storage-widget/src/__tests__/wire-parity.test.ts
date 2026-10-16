import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STORAGE_ADMIN_ROUTES } from "@adminigloo/storage";

/**
 * Wire parity (section 6.10). The widget declares the wire types itself
 * (src/types.ts) so it never imports the server package at runtime; the
 * server declares the same region in packages/storage/src/wire.ts. This test
 * reads BOTH files and requires the region between the WIRE markers to be
 * byte-identical (line endings aside). The devDependency on
 * @adminigloo/storage is used ONLY here: the client's paths are checked
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

describe("wire parity with @adminigloo/storage", () => {
  it("the WIRE regions are byte-identical", () => {
    const mine = wireRegion(readFileSync(resolve(here, "../types.ts"), "utf8"));
    const theirs = wireRegion(readFileSync(resolve(here, "../../../storage/src/wire.ts"), "utf8"));
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(mine).toBe(theirs);
  });

  it("the client speaks every route the server's table lists, by method and path", () => {
    const client = readFileSync(resolve(here, "../client.ts"), "utf8");
    for (const route of STORAGE_ADMIN_ROUTES) {
      const path = `/${route.path.replace("{file}", "${segment(id)}")}`;
      expect(client.includes(path), `${route.kind}: ${path}`).toBe(true);
      const call = route.body && typeof route.body === "object" && (route.body as { multipart?: string }).multipart ? "http.upload(" : route.method === "GET" ? "http.get(" : "http.post(";
      expect(client.includes(call), route.kind).toBe(true);
    }
  });
});
