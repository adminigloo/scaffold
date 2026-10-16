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
  // The settings registry (Tenancy 1): fragments are zod schemas, and the
  // company fragment validates a time zone and a contact email in the browser
  // and on the server with one definition. zod is isomorphic and already a
  // peer of every package that takes input.
  "zod",
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

describe("Tenancy 2a exports", () => {
  it("the root offers the role set, client-safe", async () => {
    const root = await import("../index.js");
    expect(typeof root.defineTenantRoles).toBe("function");
    expect(root.DEFAULT_TENANT_ROLES.keys).toEqual(["owner", "admin", "member", "viewer"]);
    expect(new root.InvalidTenantRoleError("x").name).toBe("InvalidTenantRoleError");
  });

  it("./server offers the seams, the cron walker and the public wire helper", async () => {
    const server = await import("../server.js");
    expect(typeof server.createCompanyRouteSeams).toBe("function");
    expect(typeof server.createPublicCompanySeams).toBe("function");
    expect(typeof server.runForEachCompany).toBe("function");
    expect(typeof server.publicCompanyToWire).toBe("function");
  });
});

describe("Tenancy 2b-1 exports (8.5)", () => {
  it("the root offers the team's alert kinds and the mapper, client-safe", async () => {
    const root = await import("../index.js");
    expect(root.tenancyAlertKinds.kinds.map((k) => k.key)).toEqual(["tenancy.member.joined", "tenancy.member.left"]);
    expect(typeof root.tenancyAlertsFor).toBe("function");
    expect(root.TENANCY_MEMBER_JOINED_KIND).toBe("tenancy.member.joined");
    expect(root.TENANCY_MEMBER_LEFT_KIND).toBe("tenancy.member.left");
  });

  it("TenancyEvent is declared in a root-safe module that imports nothing at runtime", () => {
    // Types only: `src/events.ts` and `src/alerts.ts` may import types, never a module.
    expect(specifiersIn(resolve(SRC, "events.ts"))).toEqual([]);
    expect(specifiersIn(resolve(SRC, "alerts.ts"))).toEqual([]);
  });

  it("./server keeps its names and adds the settle bound", async () => {
    const server = await import("../server.js");
    expect(typeof server.createTenancyService).toBe("function");
    expect(server.DEFAULT_SETTLE_EVENTS_MS).toBe(5000);
  });
});

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
