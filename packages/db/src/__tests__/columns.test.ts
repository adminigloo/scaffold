import { describe, expect, it } from "vitest";
import { newId } from "../columns.js";

describe("newId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
  });

  it("produces UUID v7 — version nibble is 7", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sorts lexicographically by creation order, which is why not v4", async () => {
    const first = newId();
    await new Promise((r) => setTimeout(r, 5));
    const second = newId();
    expect([second, first].sort()).toEqual([first, second]);
  });
});
