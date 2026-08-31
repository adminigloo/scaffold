import { describe, expect, it } from "vitest";
import { createScaffoldContext } from "../context.js";

function headers(values: Record<string, string>) {
  const lowered = new Map(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

describe("the request id", () => {
  it("is always present, with or without headers", () => {
    // No nullable request id, so no handler has to decide what to log when
    // there isn't one. A correlation key present on half the lines correlates
    // nothing, and the missing half is written by the error paths.
    expect(createScaffoldContext().requestId).toHaveLength(36);
    expect(createScaffoldContext({ headers: null }).requestId).toHaveLength(36);
  });

  it("adopts an inbound x-request-id", () => {
    const ctx = createScaffoldContext({
      headers: headers({ "x-request-id": "req_from_the_edge" }),
    });
    expect(ctx.requestId).toBe("req_from_the_edge");
  });

  it("is one id per request, not one per process", () => {
    expect(createScaffoldContext().requestId).not.toBe(
      createScaffoldContext().requestId,
    );
  });

  it("can be supplied outright, for a caller with no HTTP request", () => {
    // A cron invocation or a test caller: there are no headers, and the job
    // still wants its lines tied together.
    expect(createScaffoldContext({ requestId: "cron_reconcile_1" }).requestId).toBe(
      "cron_reconcile_1",
    );
  });
});

describe("the client address", () => {
  it("comes from x-forwarded-for", () => {
    const ctx = createScaffoldContext({
      headers: headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }),
    });
    expect(ctx.ipAddress).toBe("203.0.113.7");
  });

  it("is null when nothing reports one", () => {
    expect(createScaffoldContext().ipAddress).toBeNull();
  });
});

describe("what it does not carry", () => {
  it("has no resolved permissions on it", () => {
    // `can` only appears after a middleware has resolved it, so a handler that
    // reads it is provably below a rung that did.
    const ctx = createScaffoldContext();
    expect("can" in ctx).toBe(false);
  });

  it("builds a fresh permission cache per request", () => {
    // Hoisting it to module scope would share one user's resolved sets with
    // the next request a warm instance handles.
    expect(createScaffoldContext().permissionCache).not.toBe(
      createScaffoldContext().permissionCache,
    );
  });
});
