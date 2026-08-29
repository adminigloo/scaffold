import { createHash } from "node:crypto";

/**
 * The instant every factory timestamps against.
 *
 * A fixed date, not `new Date()`. Two rows built in the same test must be able
 * to compare equal, and a `createdAt` that moves means an assertion on a whole
 * row has to be written as a field-by-field match with the timestamps picked
 * out — which is how the one field that actually regressed stops being checked.
 */
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

export interface Seeded {
  /**
   * Distinguishes several rows of the same kind inside one test. Same seed,
   * same id, every run and every machine.
   */
  readonly seed?: number;
}

const UUID_V7_LAYOUT = [4, 2, 2, 2, 6] as const;

/**
 * A UUID v7 derived from `kind` and `seed` rather than from the clock.
 *
 * `newId()` in @adminigloo/db is `uuidv7()`, which embeds `Date.now()` and 74
 * bits of randomness — correct in production and useless in a fixture, because
 * a failing assertion prints an id that will never occur again and the run
 * cannot be reproduced from the log. This produces a real v7 (right version and
 * variant nibbles, so anything that validates the format still passes) whose
 * bytes are a SHA-256 of the seed.
 *
 * The timestamp field is `FIXED_NOW + seed` ms, so ids from one factory sort in
 * seed order exactly as `uuidv7()` sorts in insertion order — a test asserting
 * "most recent first" over fixtures gets the ordering it would get in
 * production instead of a coin flip.
 */
export function deterministicId(kind: string, seed = 0): string {
  const digest = createHash("sha256").update(`${kind}:${seed}`, "utf8").digest();
  const bytes = Buffer.alloc(16);

  bytes.writeUIntBE(FIXED_NOW.getTime() + seed, 0, 6);
  digest.copy(bytes, 6, 0, 10);

  // Version 7 in the high nibble of byte 6, RFC 9562 variant in byte 8. Read
  // back through `?? 0` rather than `!`: noUncheckedIndexedAccess is on, and a
  // non-null assertion here would be the only place in the package claiming to
  // know better than the compiler about an index.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  const groups: string[] = [];
  let offset = 0;
  for (const size of UUID_V7_LAYOUT) {
    groups.push(hex.slice(offset, offset + size * 2));
    offset += size * 2;
  }
  return groups.join("-");
}

/**
 * A timestamp `offsetMs` after `FIXED_NOW`.
 *
 * Exists so a fixture that needs "created before" / "updated after" says so in
 * milliseconds instead of hard-coding a second literal date string, which is
 * how two fixtures end up ordered the wrong way round and the test still passes
 * for the wrong reason.
 */
export function fixedTime(offsetMs = 0): Date {
  return new Date(FIXED_NOW.getTime() + offsetMs);
}

/**
 * Lowercase, `[a-z0-9-]`-only form of an arbitrary string.
 *
 * Used wherever a caller-supplied name reaches something with an opinion about
 * characters: a Neon branch name, a storage-state filename. Collapsing runs and
 * trimming the ends matters because `refs/heads/feature/x` would otherwise
 * become `refs-heads-feature-x-` with a trailing separator that some APIs
 * accept and others reject.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
