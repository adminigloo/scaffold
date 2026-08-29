import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINGERPRINT_FRAMES,
  FINGERPRINT_LENGTH,
  errorFingerprint,
  fingerprintSource,
} from "../fingerprint.js";

/**
 * Errors are hand-built with literal stacks.
 *
 * The property under test is "the same bug on two different machines produces
 * the same value", and a real `new Error()` can only ever produce the stack of
 * the machine running the test — which is the one environment where the answer
 * is trivially yes.
 */
function errorWith(name: string, message: string, stack: string): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

// The same bug, on a developer's Windows laptop and on a Vercel Linux
// function, after a refactor moved every line.
const ON_LAPTOP = errorWith(
  "TypeError",
  "Cannot read properties of undefined (reading 'tenantId')",
  [
    "TypeError: Cannot read properties of undefined (reading 'tenantId')",
    "    at resolveTenant (C:\\Users\\dev\\scaffold\\src\\tenancy.ts:112:24)",
    "    at handler (C:\\Users\\dev\\scaffold\\src\\route.ts:41:9)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n"),
);

const ON_VERCEL = errorWith(
  "TypeError",
  "Cannot read properties of undefined (reading 'tenantId')",
  [
    "TypeError: Cannot read properties of undefined (reading 'tenantId')",
    "    at resolveTenant (/var/task/.next/server/app/src/tenancy.ts:207:11)",
    "    at handler (/var/task/.next/server/app/src/route.ts:88:3)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:97:5)",
  ].join("\n"),
);

describe("errorFingerprint — the same bug is one row", () => {
  it("survives a different absolute path, OS and line number", () => {
    // This is the entire value of the unique index. If it fails, one bad
    // deploy writes a row per occurrence and the counter means nothing.
    expect(errorFingerprint(ON_LAPTOP)).toBe(errorFingerprint(ON_VERCEL));
  });

  it("is deterministic across calls", () => {
    expect(errorFingerprint(ON_LAPTOP)).toBe(errorFingerprint(ON_LAPTOP));
  });

  it("survives an id in the message", () => {
    const a = errorWith(
      "NotFoundError",
      "Tenant 0192f7c1-3a4b-7def-8123-4567890abcde was not found",
      "NotFoundError: ...\n    at load (/app/src/tenant.ts:10:1)",
    );
    const b = errorWith(
      "NotFoundError",
      "Tenant 0192f7c1-9999-7def-8123-000000000000 was not found",
      "NotFoundError: ...\n    at load (/app/src/tenant.ts:10:1)",
    );
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("survives a heap address in the message", () => {
    const a = errorWith("Error", "segfault at 0x7ffee3b04c10", "");
    const b = errorWith("Error", "segfault at 0x7ffd11220000", "");
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("survives a build-hash chunk name in the frame", () => {
    // Next.js renames chunks on every build. Without normalisation the whole
    // error table turns over at each deploy and every trend line resets.
    const a = errorWith(
      "Error",
      "boom",
      "Error: boom\n    at h (/var/task/.next/server/chunks/48219.js:1:2)",
    );
    const b = errorWith(
      "Error",
      "boom",
      "Error: boom\n    at h (/var/task/.next/server/chunks/91733.js:1:2)",
    );
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("survives a cache-busting query string on the frame", () => {
    const a = errorWith("Error", "boom", "Error: boom\n    at h (/app/x.js?v=1:1:1)");
    const b = errorWith("Error", "boom", "Error: boom\n    at h (/app/x.js?v=2:1:1)");
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("survives a timestamp in the message", () => {
    const a = errorWith("Error", "lease expired at 2026-08-28T10:00:00Z", "");
    const b = errorWith("Error", "lease expired at 2026-08-29T11:30:00Z", "");
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("survives a message reflowed across lines by a runtime upgrade", () => {
    const a = errorWith("Error", "connection\n  refused", "");
    const b = errorWith("Error", "connection refused", "");
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("merges the same bug reached from two different entry points", () => {
    // Frames beyond the limit differ per route. Splitting on them would file
    // one bug under every caller that can reach it.
    const viaWeb = errorWith(
      "TypeError",
      "x is not a function",
      [
        "TypeError: x is not a function",
        "    at compute (/app/src/calc.ts:5:1)",
        "    at run (/app/src/job.ts:9:1)",
        "    at dispatch (/app/src/queue.ts:2:1)",
        "    at webHandler (/app/src/web.ts:1:1)",
      ].join("\n"),
    );
    const viaCron = errorWith(
      "TypeError",
      "x is not a function",
      [
        "TypeError: x is not a function",
        "    at compute (/app/src/calc.ts:5:1)",
        "    at run (/app/src/job.ts:9:1)",
        "    at dispatch (/app/src/queue.ts:2:1)",
        "    at cronHandler (/app/src/cron.ts:1:1)",
      ].join("\n"),
    );
    expect(errorFingerprint(viaWeb)).toBe(errorFingerprint(viaCron));
  });
});

describe("errorFingerprint — different bugs stay apart", () => {
  it("separates two messages that differ in a word", () => {
    const other = errorWith(
      "TypeError",
      "Cannot read properties of undefined (reading 'userId')",
      ON_LAPTOP.stack ?? "",
    );
    expect(errorFingerprint(other)).not.toBe(errorFingerprint(ON_LAPTOP));
  });

  it("separates two error classes carrying the same message", () => {
    const stack = "Error: out of range\n    at check (/app/src/x.ts:1:1)";
    expect(
      errorFingerprint(errorWith("RangeError", "out of range", stack)),
    ).not.toBe(errorFingerprint(errorWith("TypeError", "out of range", stack)));
  });

  it("separates the same message thrown from different functions", () => {
    const a = errorWith(
      "Error",
      "invariant failed",
      "Error: invariant failed\n    at resolveTenant (/app/src/a.ts:1:1)",
    );
    const b = errorWith(
      "Error",
      "invariant failed",
      "Error: invariant failed\n    at resolveMember (/app/src/a.ts:1:1)",
    );
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });

  it("separates the same function name in different files", () => {
    const a = errorWith("Error", "boom", "Error: boom\n    at run (/app/src/a.ts:1:1)");
    const b = errorWith("Error", "boom", "Error: boom\n    at run (/app/src/b.ts:1:1)");
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });

  it("does not merge two short numbers that carry meaning", () => {
    // Digit runs shorter than four are left alone on purpose: merging
    // "expected 2 arguments" with "expected 3 arguments" hides a bug in a way
    // nothing downstream can detect.
    const a = errorWith("TypeError", "expected 2 arguments, got 1", "");
    const b = errorWith("TypeError", "expected 3 arguments, got 1", "");
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });
});

describe("errorFingerprint — shape and inputs it must not choke on", () => {
  it("is 16 lowercase hex characters", () => {
    const value = errorFingerprint(ON_LAPTOP);
    expect(value).toHaveLength(FINGERPRINT_LENGTH);
    expect(value).toMatch(/^[0-9a-f]+$/);
  });

  it.each([
    ["a thrown string", "boom"],
    ["a thrown number", 42],
    ["null", null],
    ["undefined", undefined],
    ["a bare object", { code: 500 }],
    ["an array", [1, 2, 3]],
  ])("fingerprints %s without throwing", (_label, thrown) => {
    expect(errorFingerprint(thrown)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not put a thrown object's contents into the fingerprint source", () => {
    // The source becomes the `message` column of a table kept for a year.
    // Stringifying an arbitrary thrown value puts whatever it held in there.
    expect(fingerprintSource({ apiKey: "sk_live_51H8xKzABCDEFGHij" })).not.toContain(
      "sk_live",
    );
  });

  it("handles an error with no stack at all", () => {
    const error = errorWith("Error", "no stack here", "");
    expect(errorFingerprint(error)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("fingerprints an error that failed `instanceof` across a realm", () => {
    // A structured-clone'd error from a worker is a plain object. Those come
    // from background jobs, where the error log is the only witness.
    const cloned = {
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'tenantId')",
      stack: ON_LAPTOP.stack,
    };
    expect(errorFingerprint(cloned)).toBe(errorFingerprint(ON_LAPTOP));
  });
});

describe("fingerprintSource — the answer to \"why did these merge\"", () => {
  it("strips absolute paths, line numbers and columns from the frames", () => {
    const source = fingerprintSource(ON_LAPTOP);
    expect(source).toContain("resolveTenant@tenancy.ts");
    expect(source).not.toContain("C:\\Users");
    expect(source).not.toContain("112");
  });

  it("includes exactly DEFAULT_FINGERPRINT_FRAMES frames", () => {
    const frames = fingerprintSource(ON_LAPTOP)
      .split("\n")
      .filter((line) => line.includes("@"));
    expect(frames).toHaveLength(DEFAULT_FINGERPRINT_FRAMES);
  });

  it("honours a caller-supplied frame count", () => {
    expect(
      fingerprintSource(ON_LAPTOP, { frames: 1 })
        .split("\n")
        .filter((line) => line.includes("@")),
    ).toHaveLength(1);
  });

  it("collapses two call sites when frames is 0", () => {
    const a = errorWith("Error", "boom", "Error: boom\n    at a (/app/a.ts:1:1)");
    const b = errorWith("Error", "boom", "Error: boom\n    at b (/app/b.ts:1:1)");
    expect(errorFingerprint(a, { frames: 0 })).toBe(
      errorFingerprint(b, { frames: 0 }),
    );
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });

  it("reads `at async fn (loc)` and `at loc` frames", () => {
    const error = errorWith(
      "Error",
      "boom",
      [
        "Error: boom",
        "    at async Object.handler (file:///C:/app/src/route.ts:12:3)",
        "    at /app/src/anonymous.ts:4:5",
      ].join("\n"),
    );
    const source = fingerprintSource(error);
    expect(source).toContain("Object.handler@route.ts");
    expect(source).toContain("@anonymous.ts");
  });
});
