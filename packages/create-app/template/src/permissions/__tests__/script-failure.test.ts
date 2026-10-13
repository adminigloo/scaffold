import { describe, expect, it } from "vitest";
import { describeScriptFailure } from "../seed";

/**
 * What a failed `db:seed:deploy` or `admin:grant` prints, which in GitHub
 * Actions is the only line a buyer reads (review R2 TB2-09).
 */

/** A Node system error, as a socket or DNS lookup raises it. */
function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno: -1, syscall: "connect" });
}

/** What Neon's driver rejects with when its WebSocket can't connect: an ErrorEvent, the socket's error inside. */
function wsEvent(code: string, message: string): Record<string, unknown> {
  return { type: "error", message, error: systemError(code, message), target: {} };
}

/** What drizzle throws when a statement fails: the statement, its parameters, and the driver's failure as the cause. */
function drizzleQueryError(query: string, params: unknown[], cause: unknown): Error {
  return Object.assign(new Error(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause }), { query, params });
}

/** A reachable Postgres answering a statement with an error: pg's DatabaseError, its stack through pg's own files. */
function postgresError(message: string, code: string): Error {
  const error = Object.assign(new Error(message), { code, severity: "ERROR" });
  error.stack =
    `error: ${message}\n` +
    "    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:283:98)\n" +
    "    at Parser.handlePacket (/app/node_modules/pg-protocol/dist/parser.js:122:29)\n" +
    "    at Socket.<anonymous> (/app/node_modules/pg/lib/connection.js:117:12)";
  return error;
}

describe("describeScriptFailure", () => {
  it("an unreachable database (the driver's ErrorEvent, not an Error) is named, never '[object Object]'", () => {
    const text = describeScriptFailure(wsEvent("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9"), "127.0.0.1:9/db");
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("Could not reach the database at 127.0.0.1:9/db");
    expect(text).toContain("ECONNREFUSED");
  });

  it("…and so is one drizzle wrapped in 'Failed query' — admin:grant's first lookup (review R3 TB2-09)", () => {
    const wrapped = drizzleQueryError(
      "select id, external_id, created_at from users where lower(email) = $1",
      ["owner@example.com"],
      wsEvent("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"),
    );
    const text = describeScriptFailure(wrapped, "127.0.0.1:9/appdb");
    expect(text.startsWith("Could not reach the database at 127.0.0.1:9/appdb.")).toBe(true);
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("owner@example.com");
  });

  it("'could not reach' comes from the network error's CODE, at any depth and in any driver's shape (review R4 TB2-09)", () => {
    const codes = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"];
    for (const code of codes) {
      const shapes: [string, unknown][] = [
        ["a Node socket error (pg)", systemError(code, "the socket gave up")],
        ["Neon's WebSocket ErrorEvent", wsEvent(code, "the socket gave up")],
        ["drizzle over Neon's event", drizzleQueryError("select 1", [], wsEvent(code, "the socket gave up"))],
        ["an AggregateError (every address tried)", new AggregateError([systemError(code, "a"), systemError(code, "b")], "all attempts failed")],
        [
          "Neon's HTTP driver: fetch failed, undici's cause",
          Object.assign(new Error("Error connecting to database: fetch failed"), {
            sourceError: new TypeError("fetch failed", { cause: systemError(code, "the socket gave up") }),
          }),
        ],
      ];
      for (const [label, error] of shapes) {
        expect(describeScriptFailure(error, "db.acme.test/appdb"), `${code}: ${label}`).toContain("Could not reach the database at db.acme.test/appdb.");
      }
    }
    // undici's own connect timeout, and Postgres saying the connection itself failed or the server isn't up yet.
    for (const code of ["UND_ERR_CONNECT_TIMEOUT", "08001", "08006", "57P03"]) {
      const error = new TypeError("fetch failed", { cause: Object.assign(new Error("it did not connect"), { code }) });
      expect(describeScriptFailure(error, "db.acme.test/appdb"), code).toContain("Could not reach the database at db.acme.test/appdb.");
    }
  });

  it("a reachable database whose query fails is a QUERY failure — even for connect@acme.test, or a stack through pg/lib/connection.js — and the query and address aren't echoed", () => {
    const missingTable = drizzleQueryError(
      "select id, external_id, created_at from users where lower(email) = $1",
      ["connect@acme.test"],
      postgresError('relation "users" does not exist', "42P01"),
    );
    const text = describeScriptFailure(missingTable, "db.acme.test/appdb");
    expect(text).not.toContain("Could not reach");
    expect(text.startsWith("A query on the database at db.acme.test/appdb failed")).toBe(true);
    expect(text).toContain('relation "users" does not exist');
    expect(text).toContain("42P01");
    for (const echoed of ["connect@acme.test", "Failed query", "select id", "params:", "lower(email)"]) expect(text).not.toContain(echoed);

    // A driver error straight from pg (no drizzle), whose words happen to say "connect".
    const denied = describeScriptFailure(postgresError("permission denied for table connect_tokens", "42501"), "db.acme.test/appdb");
    expect(denied).not.toContain("Could not reach");
    expect(denied).toContain("permission denied for table connect_tokens");

    // An event whose words say "connect ECONNREFUSED" but that carries no code
    // is not taken at its word: it is reported as it is, not as "could not reach".
    const wordsOnly = describeScriptFailure({ type: "error", message: "connect ECONNREFUSED in a WebSocket" }, "db.acme.test/appdb");
    expect(wordsOnly).not.toContain("Could not reach");
    expect(wordsOnly).toContain("error event");
  });

  it("an Error keeps its stack, with what caused it underneath; anything else is still readable", () => {
    expect(describeScriptFailure(new Error("role template missing"))).toContain("role template missing");
    const caused = describeScriptFailure(new Error("seeding stopped", { cause: new Error("the catalog is empty") }));
    expect(caused).toContain("seeding stopped");
    expect(caused).toContain("Caused by: Error: the catalog is empty");
    // drizzle's wrapper names the statement; the database's reason is what's printed.
    const query = describeScriptFailure(new Error("Failed query: insert …", { cause: new Error('relation "role_template" does not exist') }));
    expect(query).toContain('A query on the database failed: relation "role_template" does not exist');
    expect(query).not.toContain("Failed query");
    expect(describeScriptFailure({ type: "error" }, null)).toContain("error event");
    expect(describeScriptFailure("plain")).toBe("plain");
  });
});
