import type { NeonDatabase } from "drizzle-orm/neon-serverless";

/**
 * Marks a handle as the not-configured stand-in.
 *
 * `Symbol.for`, not `Symbol()`: this package ships both ESM and CJS, and a
 * Next app can load one build in the server bundle and the other in an
 * instrumentation hook. A module-local symbol would differ between those two
 * copies and `isDbConfigured` would then report a stand-in handle as real.
 */
const UNCONFIGURED: unique symbol = Symbol.for("adminigloo.db.unconfigured");

export class DatabaseNotConfiguredError extends Error {
  readonly name = "DatabaseNotConfiguredError";
  /** The access that triggered it, e.g. `db.query.users.findFirst`. */
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} was used, but this process has no database: createDb() ran with ` +
        `connectionString undefined because DATABASE_URL is not set. ` +
        `Put DATABASE_URL (and DATABASE_URL_UNPOOLED, which migrations use) in ` +
        `.env.local — copy both from your Neon project's connection details — then ` +
        `restart the dev server. To keep a page working without a database, guard ` +
        `it with isDbConfigured(db) instead of querying.`,
    );
    this.path = path;
  }
}

/**
 * Node and test runners probe unknown values through well-known symbols
 * (inspection, coercion, iteration). Those probes must answer instead of
 * throwing, or `console.log(db)` and Vitest's own diff rendering blow up with a
 * DatabaseNotConfiguredError that points at the printer rather than at the
 * query that caused it.
 */
function probeAnswer(key: symbol): unknown {
  return key === Symbol.toStringTag ? "UnconfiguredDatabase" : undefined;
}

function unconfiguredNode(path: string): object {
  // The target is a function so every node on the path is callable. Drizzle
  // presents work as `db.query.users.findFirst()` and `db.select().from(...)`;
  // with an object target the call site would die on "findFirst is not a
  // function", which names neither the missing variable nor the file to set it
  // in.
  const target = function unconfiguredDatabase(): void {};

  return new Proxy(target, {
    get(_target, key) {
      if (key === UNCONFIGURED) return true;
      if (typeof key === "symbol") return probeAnswer(key);
      // Printing and serialising are how a value gets reported, not how work
      // gets done. A log line or a JSON.stringify of a props object must not
      // become a second failure that hides the query that actually broke.
      if (key === "toString" || key === "valueOf" || key === "toJSON") {
        return () => `[database not configured: ${path}]`;
      }
      // Navigation alone is deferred, deliberately. Throwing here would report
      // `db.query` — the namespace — while the caller wants to know that
      // `db.query.users.findFirst` is what could not run.
      return unconfiguredNode(`${path}.${key}`);
    },
    apply() {
      throw new DatabaseNotConfiguredError(path);
    },
    construct() {
      throw new DatabaseNotConfiguredError(path);
    },
  });
}

/**
 * A handle with the type of a real one that throws on first use.
 *
 * The alternative — returning null when DATABASE_URL is absent — pushes a null
 * check into every consumer and into the generated app's own db module, and the
 * check that gets forgotten fails with "cannot read property select of null",
 * which names nothing. This fails with the variable to set and the file to set
 * it in.
 */
export function createUnconfiguredDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(): NeonDatabase<TSchema> {
  // Sound: the proxy answers every property Drizzle's type surface declares.
  // TypeScript cannot express "structurally anything", and a union return would
  // force every consumer to narrow, which is the outcome this exists to avoid.
  return unconfiguredNode("db") as unknown as NeonDatabase<TSchema>;
}

/**
 * Does this handle talk to a real database?
 *
 * Answering does not trip the throw, so a page can ask before it queries and
 * render "connect a database" instead of crashing.
 */
export function isDbConfigured(db: unknown): boolean {
  if (db === null || (typeof db !== "object" && typeof db !== "function")) {
    return false;
  }
  return (db as { [UNCONFIGURED]?: boolean })[UNCONFIGURED] !== true;
}
