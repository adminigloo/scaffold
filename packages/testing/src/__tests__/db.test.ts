import { describe, expect, it } from "vitest";
import {
  assertNotProduction,
  ephemeralBranchName,
  ProductionTargetBlockedError,
  withRollback,
} from "../db.js";

const SHA = "4f9c1b2a8e7d6c5b4a39281706f5e4d3c2b1a098";

describe("ephemeralBranchName", () => {
  it("names the branch after the commit and the attempt", () => {
    expect(ephemeralBranchName({ sha: SHA, attempt: 1 })).toBe("ci-4f9c1b2-1");
  });

  it("computes the same name in the job that creates it and the one deleting it", () => {
    // The two run in different processes with no shared state. If this were not
    // a pure function of the environment, cleanup would have to be handed the
    // name through an artifact — and every failed job would leak a branch.
    const created = ephemeralBranchName({ sha: SHA, attempt: "2" });
    const cleanup = ephemeralBranchName({ sha: SHA, attempt: "2" });
    expect(cleanup).toBe(created);
  });

  it("gives a re-run its own branch", () => {
    // Re-running a failed job hits the same commit. Reusing its branch would
    // inherit the half-truncated tables the failure left behind.
    expect(ephemeralBranchName({ sha: SHA, attempt: 1 })).not.toBe(
      ephemeralBranchName({ sha: SHA, attempt: 2 }),
    );
  });

  it("treats an unset GITHUB_RUN_ATTEMPT as the first attempt, not as zero", () => {
    // `Number("")` is 0. That would name every first attempt `…-0` while the
    // cleanup step, which took the default, deletes `…-1`.
    expect(ephemeralBranchName({ sha: SHA, attempt: "" })).toBe("ci-4f9c1b2-1");
    expect(ephemeralBranchName({ sha: SHA })).toBe("ci-4f9c1b2-1");
    expect(ephemeralBranchName({ sha: SHA, attempt: "not a number" })).toBe("ci-4f9c1b2-1");
  });

  it("hashes a seed that is not a sha instead of truncating it", () => {
    // A workflow passing GITHUB_HEAD_REF here is a real mistake, and truncation
    // would give these two runs the same branch — one then drops the other's
    // database mid-suite.
    const a = ephemeralBranchName({ sha: "refactor-the-ledger-a" });
    const b = ephemeralBranchName({ sha: "refactor-the-ledger-b" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ci-[0-9a-f]{7}-1$/);
  });

  it("is stable for a non-hex seed across calls", () => {
    const name = ephemeralBranchName({ sha: "main" });
    expect(ephemeralBranchName({ sha: "main" })).toBe(name);
  });

  it("survives an uppercase sha", () => {
    expect(ephemeralBranchName({ sha: SHA.toUpperCase() })).toBe("ci-4f9c1b2-1");
  });

  it("slugifies the prefix, so a workflow name cannot break the branch name", () => {
    expect(ephemeralBranchName({ sha: SHA, prefix: "E2E Suite" })).toBe(
      "e2e-suite-4f9c1b2-1",
    );
  });

  it("keeps the sha and the attempt when the prefix is longer than the limit", () => {
    // The whole point of the name. Truncating the COMPOSED string drops the
    // tail, so a long workflow prefix gave every commit the same branch — the
    // second job then drops the first job's database mid-suite, which is the
    // exact collision this function exists to prevent.
    const prefix = "nightly-integration-suite-for-the-billing-and-invoicing-service";
    const a = ephemeralBranchName({ sha: SHA, prefix });
    const b = ephemeralBranchName({ sha: "aaaaaaa1111111111111111111111111111aaaa", prefix });

    expect(a).not.toBe(b);
    expect(a.endsWith("-4f9c1b2-1")).toBe(true);
    expect(b.endsWith("-aaaaaaa-1")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
  });

  it("keeps a re-run distinguishable under a long prefix too", () => {
    const prefix = "x".repeat(120);
    expect(ephemeralBranchName({ sha: SHA, prefix, attempt: 1 })).not.toBe(
      ephemeralBranchName({ sha: SHA, prefix, attempt: 2 }),
    );
  });

  it("drops the prefix entirely rather than the discriminator", () => {
    // Nothing about the prefix is load-bearing — it is a human-readable
    // namespace. The sha and the attempt are what cleanup matches on.
    const name = ephemeralBranchName({ sha: SHA, prefix: "y".repeat(200) });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toContain("4f9c1b2");
    expect(name).not.toMatch(/--/);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it("only ever emits characters a branch name and a URL both accept", () => {
    for (const seed of [SHA, "refs/heads/feature/x", "MAIN", "  spaced  "]) {
      const name = ephemeralBranchName({ sha: seed, prefix: "Weird/Prefix" });
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });
});

const NEON_CI = "postgres://u:pw@ep-late-frost-12345678.us-east-2.aws.neon.tech/neondb";
const NEON_PROD = "postgres://u:pw@ep-warm-river-87654321.us-east-2.aws.neon.tech/neondb";

describe("assertNotProduction", () => {
  it("allows a localhost target on a laptop", () => {
    expect(() =>
      assertNotProduction("postgres://postgres:postgres@localhost:5432/app", "local"),
    ).not.toThrow();
  });

  it("allows the host the CI job declared disposable", () => {
    expect(() =>
      assertNotProduction(NEON_CI, "staging", {
        disposableHosts: ["ep-late-frost-12345678"],
      }),
    ).not.toThrow();
  });

  it("allows a database whose name says it is throwaway", () => {
    expect(() =>
      assertNotProduction("postgres://u:pw@db.example.com/app_test", "local"),
    ).not.toThrow();
  });

  it("refuses production however innocent the URL looks", () => {
    // VERCEL_ENV is set by the platform and cannot be forged, so this beats
    // every other signal — including a connection string pointing at localhost.
    const localhost = "postgres://postgres:postgres@localhost:5432/app_test";
    expect(() => assertNotProduction(localhost, "production")).toThrow(
      ProductionTargetBlockedError,
    );
  });

  it("refuses a Neon branch nobody declared disposable", () => {
    // THE CASE THIS EXISTS FOR. A branch endpoint and the production endpoint
    // are the same shape of hostname with the same `neondb` database behind
    // them, so "it looks like a Neon URL" proves nothing at all.
    expect(() => assertNotProduction(NEON_PROD, "staging")).toThrow(
      /nothing about host .* says it is disposable/,
    );
  });

  it("refuses an unset variable rather than reading it as harmless", () => {
    const unset = ["", "undefined", "null", "https://console.neon.tech/projects/x"];
    for (const value of unset) {
      expect(() => assertNotProduction(value, "local")).toThrow(
        /is not a postgres:\/\/ URL/,
      );
    }
  });

  it("lets a production marker veto a disposable one", () => {
    // The evidence rules are OR'd, so without the veto `prod-ci` sails through
    // on the "ci" it happens to contain.
    expect(() =>
      assertNotProduction("postgres://u:pw@prod-ci.example.com/app_test", "staging"),
    ).toThrow(/carries "prod"/);
    expect(() =>
      assertNotProduction("postgres://u:pw@db.example.com/prod_test", "staging"),
    ).toThrow(/carries "prod"/);
  });

  it("vetoes even a host the caller declared disposable", () => {
    expect(() =>
      assertNotProduction("postgres://u:pw@ep-prod-1.neon.tech/neondb", "staging", {
        disposableHosts: ["ep-prod-1"],
      }),
    ).toThrow(/carries "prod"/);
  });

  it("never puts the password in the message", () => {
    // The message lands in a CI log, which is world-readable on a public repo.
    try {
      // Malformed on purpose: the value that reaches the redactor is the one
      // that failed to parse, so the masking cannot rely on a well-formed URL.
      assertNotProduction("postgres:/u:hunter2@db.example.com/app", "local");
      expect.unreachable("should have refused");
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("accepts a caller-supplied database marker list", () => {
    expect(() =>
      assertNotProduction("postgres://u:pw@db.example.com/sandbox", "local", {
        disposableDatabases: ["sandbox"],
      }),
    ).not.toThrow();
  });

  it("refuses a production database whose name merely contains a marker", () => {
    // "ci" is two characters and it lives inside ordinary words. A substring
    // match classified `invoicing` as disposable and ran a truncating suite
    // against it — the failure this check exists to make impossible.
    for (const database of ["invoicing", "precision", "pricing", "specifics"]) {
      expect(() =>
        assertNotProduction(`postgres://u:pw@db.example.com/${database}`, "staging"),
      ).toThrow(/nothing about host .* says it is disposable/);
    }
  });

  it("still accepts a marker that stands as a whole token", () => {
    for (const database of ["acme_test", "ci-run-42", "test", "app-shadow-1"]) {
      expect(() =>
        assertNotProduction(`postgres://u:pw@db.example.com/${database}`, "staging"),
      ).not.toThrow();
    }
  });

  it("matches a multi-word caller marker as a run of tokens", () => {
    // `{ disposableDatabases: ["pr-1234"] }` is the per-PR database case. One
    // opaque token would never match and the suite would be refused for a
    // target that really is disposable.
    expect(() =>
      assertNotProduction("postgres://u:pw@db.example.com/app_pr_1234", "staging", {
        disposableDatabases: ["pr-1234"],
      }),
    ).not.toThrow();
    expect(() =>
      assertNotProduction("postgres://u:pw@db.example.com/app_pr_9999", "staging", {
        disposableDatabases: ["pr-1234"],
      }),
    ).toThrow(ProductionTargetBlockedError);
  });

  it("does not accept neondb as evidence, because production uses that name too", () => {
    expect(() => assertNotProduction(NEON_CI, "local")).toThrow(
      ProductionTargetBlockedError,
    );
  });
});

describe("withRollback re-export", () => {
  it("is @adminigloo/db's sandbox, reached through this subpath", async () => {
    // The point of the re-export is that a project imports one testing package
    // instead of two. This asserts the thing that would break if someone
    // "helpfully" reimplemented it here: the value comes back even though the
    // transaction was escaped by a throw, and nothing commits.
    const committed: string[] = [];
    const db = {
      async transaction<T>(fn: (tx: { write(v: string): void }) => Promise<T>): Promise<T> {
        const staged: string[] = [];
        const value = await fn({ write: (row) => staged.push(row) });
        // Only reached when the callback returns normally — which, under
        // withRollback, it never does.
        committed.push(...staged);
        return value;
      },
    };

    const result = await withRollback(db, async (tx) => {
      tx.write("row");
      return "returned through the sentinel";
    });

    expect(result).toBe("returned through the sentinel");
    expect(committed).toEqual([]);
  });
});
