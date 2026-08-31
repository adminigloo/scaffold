import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `@adminigloo/observability/request` has to be importable from a root proxy.
 *
 * That runtime is the edge: no `node:crypto`, no `pino`, no filesystem, and a
 * build error rather than a runtime one when something reaches for them. The
 * subpath exists precisely so an application does not have to keep its own
 * dependency-free copy of the request id beside its proxy — and the moment
 * this module gains an import, the copy comes back, because the proxy will
 * stop building and the fastest fix in the room is to paste the file.
 *
 * Asserted against the SOURCE rather than the built bundle. A bundler happily
 * inlines `node:crypto` into `dist/request.js` and the import disappears from
 * the artefact while remaining perfectly fatal on the edge, so reading the
 * output would be a test that passes for the wrong reason.
 */
const REQUEST_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "request.ts",
);

/** `import …`, `export … from …`, `import(…)` and `require(…)`. */
const ANY_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s|(?:^|\n)\s*import\s+["']|\bimport\s*\(|\brequire\s*\(/;

describe("the edge-safe request subpath", () => {
  it("imports nothing at all", async () => {
    const source = await readFile(REQUEST_MODULE, "utf8");
    const offender = ANY_IMPORT.exec(source);
    expect(
      offender,
      `src/request.ts imports ${offender?.[0]?.trim() ?? ""}. This module is ` +
        `published as @adminigloo/observability/request so a proxy on the edge ` +
        `runtime can read the request id without pulling pino in behind it. ` +
        `Anything it imports has to be edge-safe too, and the only way to keep ` +
        `that true is to import nothing.`,
    ).toBeNull();
  });

  it("mints ids from the Web Crypto global, not node:crypto", async () => {
    const source = await readFile(REQUEST_MODULE, "utf8");
    expect(source).toContain("globalThis.crypto.randomUUID()");
    // The import form, not the bare string: the block comment above the
    // function names `node:crypto` to explain what it is avoiding, and a test
    // that forbade the word would forbid saying why.
    expect(source).not.toMatch(/from\s+["']node:crypto["']/);
  });

  it("is exported at its own subpath, built as its own entry", async () => {
    // Two halves that have to agree: a subpath in `exports` pointing at a file
    // tsup was never told to build resolves to nothing, and an entry with no
    // subpath is a file nobody can import.
    const pkg = JSON.parse(
      await readFile(join(dirname(REQUEST_MODULE), "..", "package.json"), "utf8"),
    ) as {
      exports: Record<string, { import?: string; types?: string }>;
      scripts: Record<string, string>;
    };
    expect(pkg.exports["./request"]?.import).toBe("./dist/request.js");
    expect(pkg.exports["./request"]?.types).toBe("./dist/request.d.ts");
    expect(pkg.scripts["build"]).toContain("src/request.ts");
  });
});
