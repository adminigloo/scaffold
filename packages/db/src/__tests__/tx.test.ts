import { describe, expect, it, vi } from "vitest";
import { withRollback, type Transactable } from "../tx.js";

/** Mimics Drizzle: runs the callback, lets a throw escape (which rolls back). */
function fakeDb(): Transactable<{ tag: string }> & { rolledBack: boolean } {
  const state = {
    rolledBack: false,
    async transaction<T>(fn: (tx: { tag: string }) => Promise<T>): Promise<T> {
      try {
        return await fn({ tag: "tx" });
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
  };
  return state;
}

describe("withRollback", () => {
  it("returns the callback's value", async () => {
    const db = fakeDb();
    await expect(withRollback(db, async () => ({ rows: 3 }))).resolves.toEqual({
      rows: 3,
    });
  });

  it("rolls back even on success", async () => {
    const db = fakeDb();
    await withRollback(db, async () => "ok");
    expect(db.rolledBack).toBe(true);
  });

  it("hands the transaction handle to the callback", async () => {
    const db = fakeDb();
    const seen = await withRollback(db, async (tx) => tx.tag);
    expect(seen).toBe("tx");
  });

  it("propagates a real error instead of swallowing it as a rollback", async () => {
    const db = fakeDb();
    await expect(
      withRollback(db, async () => {
        throw new Error("constraint violation");
      }),
    ).rejects.toThrow("constraint violation");
  });

  it("fails loudly if the driver swallows the rollback signal", async () => {
    const swallowing: Transactable<unknown> = {
      async transaction(fn) {
        try {
          return await fn({});
        } catch {
          return undefined as never;
        }
      },
    };
    await expect(withRollback(swallowing, async () => 1)).rejects.toThrow(
      /did not roll back/,
    );
  });

  it("supports a value of undefined without tripping the swallow check", async () => {
    const db = fakeDb();
    await expect(withRollback(db, async () => undefined)).resolves.toBeUndefined();
  });

  it("does not call the callback more than once", async () => {
    const db = fakeDb();
    const fn = vi.fn(async () => 1);
    await withRollback(db, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
