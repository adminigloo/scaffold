import { describe, expect, it } from "vitest";
import { generateClientKey, hashClientKey, verifyClientKey } from "../index.js";

describe("generateClientKey", () => {
  it("produces aik_-prefixed 40-hex secrets", () => {
    expect(generateClientKey()).toMatch(/^aik_[0-9a-f]{40}$/);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 1000 }, generateClientKey));
    expect(keys.size).toBe(1000);
  });
});

describe("hashClientKey", () => {
  it("is deterministic 64-char hex", async () => {
    const key = "aik_" + "ab".repeat(20);
    const first = await hashClientKey(key);
    const second = await hashClientKey(key);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different keys", async () => {
    expect(await hashClientKey("aik_one")).not.toBe(await hashClientKey("aik_two"));
  });
});

describe("verifyClientKey", () => {
  it("rejects a wrong prefix without touching the database", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be queried for a malformed key");
        },
      },
    );
    expect(await verifyClientKey(db as never, "sk_live_notours")).toBeNull();
  });
});
