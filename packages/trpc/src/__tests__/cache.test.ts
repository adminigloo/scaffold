import { describe, expect, it, vi } from "vitest";
import { createRequestCache } from "../cache.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  // Definite assignment is provably safe: the Promise executor runs
  // synchronously during construction, so both are assigned before `deferred`
  // returns.
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createRequestCache — the stampede", () => {
  it("runs the factory once for callers that all arrive before it settles", async () => {
    // The askLou shape: forecastCFF fans out to ten forecastBS calls, each of
    // which fans out again, and every one of them wants the same access row.
    // They start together, so a cache of settled values would catch none of
    // them.
    const gate = deferred<string>();
    const factory = vi.fn(() => gate.promise);
    const cache = createRequestCache<string>();

    const callers = Array.from({ length: 60 }, () =>
      cache.get("tenant:u1:t1", factory),
    );
    gate.resolve("resolved-once");

    expect(await Promise.all(callers)).toEqual(
      Array.from({ length: 60 }, () => "resolved-once"),
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("hands every concurrent caller the identical promise, not a copy", async () => {
    const cache = createRequestCache<string>();
    const first = cache.get("k", () => Promise.resolve("a"));
    const second = cache.get("k", () => Promise.resolve("b"));

    expect(second).toBe(first);
    expect(await second).toBe("a");
  });

  it("reuses a settled lookup for a caller that arrives afterwards", async () => {
    const factory = vi.fn(() => Promise.resolve("a"));
    const cache = createRequestCache<string>();

    await cache.get("k", factory);
    expect(await cache.get("k", factory)).toBe("a");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps keys apart", async () => {
    const cache = createRequestCache<string>();
    const a = await cache.get("tenant:u1:t1", () => Promise.resolve("tenant-a"));
    const b = await cache.get("tenant:u1:t2", () => Promise.resolve("tenant-b"));

    expect([a, b]).toEqual(["tenant-a", "tenant-b"]);
  });
});

describe("createRequestCache — rejection", () => {
  it("evicts a failed lookup so a later caller retries", async () => {
    // Without eviction, one transient database error during the first
    // permission lookup pins the same failure on every later hop, and the user
    // is told they lack access for the rest of the request.
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("granted");
    const cache = createRequestCache<string>();

    await expect(cache.get("k", factory)).rejects.toThrow("connection reset");
    expect(await cache.get("k", factory)).toBe("granted");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("still shares the failure with everyone already waiting on it", async () => {
    // Eviction is about later callers. Everybody who joined before the failure
    // settled asked one question and must get one answer.
    const gate = deferred<string>();
    const factory = vi.fn(() => gate.promise);
    const cache = createRequestCache<string>();

    const both = [cache.get("k", factory), cache.get("k", factory)];
    gate.reject(new Error("connection reset"));

    await expect(Promise.allSettled(both)).resolves.toEqual([
      { status: "rejected", reason: new Error("connection reset") },
      { status: "rejected", reason: new Error("connection reset") },
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not raise unhandledRejection for a cached promise nobody awaited", async () => {
    // The whole point of caching the promise is that one hop may start a
    // lookup another hop consumes. If no one ever does, Node's default
    // --unhandled-rejections=throw takes down the process for a failure that
    // was, from the request's point of view, never asked about.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const cache = createRequestCache<string>();
      void cache.get("k", () => Promise.reject(new Error("db down")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
