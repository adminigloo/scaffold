import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../client.js";
import { DatabaseNotConfiguredError, isDbConfigured } from "../unconfigured.js";

const POOLED = "postgresql://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/db";

afterEach(() => {
  // The pool is cached on globalThis so it survives Next's hot reloads, which
  // also means it survives between tests.
  globalThis.__adminiglooPool = undefined;
});

/** The call forms a generated app actually uses, as untyped probes. */
function asRecord(db: Db): Record<string, never> {
  return db as unknown as Record<string, never>;
}

describe("createDb without a connection string", () => {
  it("constructs without throwing and without opening a pool", () => {
    // The whole point: `pnpm dev` on a laptop with no Neon account must boot.
    expect(() => createDb({ connectionString: undefined })).not.toThrow();
    expect(globalThis.__adminiglooPool).toBeUndefined();
  });

  it("treats an empty string as absent rather than dialling localhost", () => {
    const db = createDb({ connectionString: "" });
    expect(isDbConfigured(db)).toBe(false);
    expect(globalThis.__adminiglooPool).toBeUndefined();
  });

  it("does not cache a stand-in as the reusable pool", () => {
    // reuseAcrossReloads is on in dev, which is exactly where the string is
    // missing; caching here would poison the pool slot for the reload that
    // finally has a real string.
    createDb({ connectionString: undefined, reuseAcrossReloads: true });
    expect(globalThis.__adminiglooPool).toBeUndefined();
  });

  it("throws the typed error when a query is actually issued", () => {
    const db = createDb({ connectionString: undefined });
    expect(() => db.select()).toThrow(DatabaseNotConfiguredError);
  });

  it("names DATABASE_URL and .env.local so the message is an instruction", () => {
    const db = createDb({ connectionString: undefined });
    let caught: unknown;
    try {
      db.select();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatabaseNotConfiguredError);
    const message = (caught as Error).message;
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain(".env.local");
    expect(message).toContain("isDbConfigured");
  });

  it("survives nested access and throws at the call, naming the whole path", () => {
    // `db.query.users.findFirst()` is the most common form in the generated
    // app. An object-backed stand-in would die on "findFirst is not a
    // function", which names neither the variable nor the file.
    const db = asRecord(createDb({ connectionString: undefined }));
    const query = db.query as unknown as Record<string, Record<string, () => unknown>>;
    const users = query.users;
    expect(users).toBeDefined();
    const findFirst = users?.findFirst;
    expect(typeof findFirst).toBe("function");

    let caught: unknown;
    try {
      findFirst?.();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatabaseNotConfiguredError);
    expect((caught as DatabaseNotConfiguredError).path).toBe("db.query.users.findFirst");
  });

  it("throws on a builder chain, not only on the first call", () => {
    const db = asRecord(createDb({ connectionString: undefined })) as unknown as {
      insert: (t: unknown) => { values: (v: unknown) => unknown };
    };
    expect(() => db.insert({}).values({})).toThrow(DatabaseNotConfiguredError);
  });

  it("rejects rather than resolving when awaited", async () => {
    const db = asRecord(createDb({ connectionString: undefined })) as unknown as {
      execute: (q: string) => Promise<unknown>;
    };
    // A thenable that quietly resolved to the stand-in would let a page render
    // rows-shaped nonsense instead of reporting the missing variable.
    await expect(Promise.resolve().then(() => db.execute("select 1"))).rejects.toBeInstanceOf(
      DatabaseNotConfiguredError,
    );
  });

  it("can be inspected and stringified without throwing a second error", () => {
    // Vitest formats values when an assertion fails; if inspection threw, every
    // failing test in the app would report the printer instead of the query.
    const db = createDb({ connectionString: undefined });
    expect(() => String(db)).not.toThrow();
    expect(() => JSON.stringify({ db })).not.toThrow();
    expect(Object.prototype.toString.call(db)).toContain("UnconfiguredDatabase");
  });
});

describe("createDb with a connection string", () => {
  it("still builds a real pooled handle and changes nothing", () => {
    const db = createDb({ connectionString: POOLED });
    expect(isDbConfigured(db)).toBe(true);
    expect(typeof db.select).toBe("function");
    expect(typeof db.transaction).toBe("function");
    // Building a query must not throw and must not need a live server.
    expect(() => db.select()).not.toThrow();
  });

  it("still reuses one pool across reloads", () => {
    createDb({ connectionString: POOLED, reuseAcrossReloads: true });
    const first = globalThis.__adminiglooPool;
    expect(first).toBeDefined();
    createDb({ connectionString: POOLED, reuseAcrossReloads: true });
    expect(globalThis.__adminiglooPool).toBe(first);
  });

  it("still leaves the shared pool alone when reuse is off", () => {
    createDb({ connectionString: POOLED });
    expect(globalThis.__adminiglooPool).toBeUndefined();
  });

  it("still exposes the schema's relational query namespace", () => {
    const db = createDb({ connectionString: POOLED, schema: {} });
    expect(db.query).toBeDefined();
  });
});

describe("isDbConfigured", () => {
  it("answers false for a stand-in without triggering the throw", () => {
    const db = createDb({ connectionString: undefined });
    expect(() => isDbConfigured(db)).not.toThrow();
    expect(isDbConfigured(db)).toBe(false);
  });

  it("answers true for a real handle", () => {
    expect(isDbConfigured(createDb({ connectionString: POOLED }))).toBe(true);
  });

  it("answers false for a missing handle instead of throwing", () => {
    expect(isDbConfigured(undefined)).toBe(false);
    expect(isDbConfigured(null)).toBe(false);
  });
});
