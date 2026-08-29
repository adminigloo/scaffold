import { describe, expect, it } from "vitest";
import { deterministicId, fixedTime, slugify, FIXED_NOW } from "../deterministic.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministicId", () => {
  it("returns the same id for the same kind and seed", () => {
    expect(deterministicId("user", 3)).toBe(deterministicId("user", 3));
  });

  it("is a well-formed UUID v7, so anything validating the format still passes", () => {
    // The fixtures stand in for `newId()` rows. A column, a Zod schema or a URL
    // matcher that accepts a uuid must not start rejecting rows the moment a
    // test builds them.
    expect(deterministicId("user", 0)).toMatch(UUID_V7);
    expect(deterministicId("tenant", 99)).toMatch(UUID_V7);
  });

  it("gives different kinds different ids for the same seed", () => {
    // Otherwise a fixture user and a fixture tenant built with the default seed
    // share a primary key, and a foreign key pointing at the wrong table
    // resolves anyway.
    expect(deterministicId("user", 0)).not.toBe(deterministicId("tenant", 0));
  });

  it("gives different seeds different ids", () => {
    const ids = new Set([0, 1, 2, 3, 4].map((seed) => deterministicId("user", seed)));
    expect(ids.size).toBe(5);
  });

  it("sorts by seed the way uuidv7 sorts by insertion time", () => {
    // `newId()` is v7 precisely so "most recent" queries work on the key. A
    // fixture whose ids sorted arbitrarily would make an ordering assertion
    // pass or fail on the hash rather than on the code under test.
    const ids = [0, 1, 2, 3, 4].map((seed) => deterministicId("user", seed));
    expect([...ids].sort()).toEqual(ids);
  });

  it("does not move between runs", () => {
    // Pinned literal, not a self-comparison: this is the assertion that fails
    // if someone reintroduces Date.now() or randomness into the generator.
    expect(deterministicId("user", 0)).toBe("019b76da-a800-79ba-9c6f-943ab62e2307");
  });
});

describe("fixedTime", () => {
  it("defaults to the frozen instant", () => {
    expect(fixedTime().getTime()).toBe(FIXED_NOW.getTime());
  });

  it("offsets in milliseconds", () => {
    expect(fixedTime(1_000).getTime() - FIXED_NOW.getTime()).toBe(1_000);
    expect(fixedTime(-1_000).getTime() - FIXED_NOW.getTime()).toBe(-1_000);
  });

  it("hands out a fresh Date, so a caller mutating one cannot move the epoch", () => {
    const first = fixedTime();
    first.setFullYear(1999);
    expect(fixedTime().getTime()).toBe(FIXED_NOW.getTime());
  });
});

describe("slugify", () => {
  it("lowercases and joins on single hyphens", () => {
    expect(slugify("Tenant Owner")).toBe("tenant-owner");
  });

  it("flattens a ref path without leaving a trailing separator", () => {
    // `refs/heads/feature/x` reaches here from GITHUB_HEAD_REF. A trailing
    // hyphen is accepted by some APIs and rejected by others, which is the
    // worst of the two.
    expect(slugify("refs/heads/feature/x")).toBe("refs-heads-feature-x");
    expect(slugify("--messy--name--")).toBe("messy-name");
  });

  it("collapses runs rather than emitting empty segments", () => {
    expect(slugify("a   b___c")).toBe("a-b-c");
  });

  it("returns an empty string when nothing survives, instead of a bare hyphen", () => {
    // Callers branch on the empty string to substitute a default. A "-" would
    // pass that check and produce a filename of `-.json`.
    expect(slugify("///")).toBe("");
  });
});
