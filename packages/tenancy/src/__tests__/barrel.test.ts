import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the package root is allowed to drag in.
 *
 * `TENANT_ROLE_TEMPLATES` and `canManageTemplateKey` are imported by client
 * components — the invitations panel is one — so everything reachable from
 * `src/index.ts` ends up in a browser bundle. Two specifiers in particular must
 * never appear there:
 *
 *   - `@adminigloo/db`, whose entry point assigns `neonConfig.webSocketConstructor`
 *     at module load and therefore pulls `ws` and `@neondatabase/serverless`
 *     behind it. That does not bloat a client bundle, it fails to build.
 *   - `drizzle-orm/pg-core`, directly or through `@adminigloo/permissions`,
 *     which is why the tables live on `./schema` and the firm-wide sentinel is
 *     copied rather than imported.
 *
 * Neither failure is visible from this package: both surface as a build error
 * in somebody's application, naming a module nobody here wrote. So the rule is
 * asserted rather than commented, over the source graph rather than over
 * `dist/`, which means it holds whether or not anything has been built.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

const ALLOWED = new Set([
  // Hashing an invitation token. Already reachable before the service existed,
  // and bundlers cope: the binding is unused on any client path.
  "node:crypto",
  // The root entry only. Isomorphic — no driver, no query builder.
  "drizzle-orm",
  // A UUID v7 in pure JavaScript. Deliberately not `newId` from
  // @adminigloo/db, which would bring the Neon driver with it.
  "uuidv7",
]);

/**
 * `import type` and `export type` are skipped, and the rest are not.
 *
 * The distinction is the whole reason `export type { TenantJson } from
 * "./schema.js"` is allowed to sit in the barrel: it erases at compile time and
 * emits no `require`. With `verbatimModuleSyntax` on, an inline `{ type X }`
 * does NOT erase the statement — the module is still imported at runtime — so
 * only the two leading forms count as free.
 */
const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(import|export)(\s+type\b)?[\s\S]*?from\s+["']([^"']+)["']/g;

function specifiersIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT_SPECIFIER)].flatMap((match) =>
    match[2] === undefined && match[3] !== undefined ? [match[3]] : [],
  );
}

/** Every bare specifier reachable from `src/index.ts` by local imports. */
function externalsFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersIn(file)) {
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      // Source is written with `.js` extensions, as ESM requires.
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }

  return externals;
}

describe("the package root", () => {
  it("imports nothing that cannot go into a browser bundle", () => {
    const externals = externalsFrom(resolve(SRC, "index.ts"));

    expect([...externals].sort()).toEqual([...ALLOWED].sort());
  });

  it("reaches no table definition, directly or through a barrel", () => {
    const externals = externalsFrom(resolve(SRC, "index.ts"));

    // The tables are on "@adminigloo/tenancy/schema" and nowhere else. tsup
    // does not code-split CJS, so a `require()` consumer that reached them both
    // ways would hold two distinct objects for one physical table, and
    // Drizzle's reference equality would quietly stop working.
    expect(externals.has("drizzle-orm/pg-core")).toBe(false);
    expect(externals.has("@adminigloo/permissions")).toBe(false);
    expect(externals.has("@adminigloo/db")).toBe(false);
  });
});
