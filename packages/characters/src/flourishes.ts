import type { Flourishes } from "./types.js";

/**
 * THE PAID-ENDING BUG (found in Hinderstap's own scripted conversations, pnpm
 * keepers:talk, 2026-11-11, before this was factored out as its own rule). Free talk's
 * rotation ends on a held-back tease — the best way to sell the next drink. Hinderstap's
 * first cut of the rotation reached for `Flourishes.endings` on every reply, paid or not,
 * so a visitor who had just bought a room was still told "not tonight" and "when you've
 * earned it": the tease that sells a first drink reads as a broken promise to someone who
 * already paid for one. `endingFor` is the fix, kept as its own tiny function so a new
 * world's rotation can't reintroduce the bug by copy-pasting the free-talk branch: once
 * `tier` is above free, the ending is always this one, offered freely, never withheld.
 */
export const PAID_ENDING =
  "a thread they can pull on next, a name or a story from your notes, offered freely and never held back";

function at(list: readonly string[], i: number): string | undefined {
  return list.length ? list[((i % list.length) + list.length) % list.length] : undefined;
}

/**
 * How this reply ends: `Flourishes.endings`, taken in turn by how many replies she's
 * given (`told`), unless `tier` is above free — then always `PAID_ENDING`, whatever
 * `endings` says. `endings` empty falls back to `PAID_ENDING` too, since an ending that
 * holds nothing back is always a safe default.
 */
export function endingFor(flourishes: Flourishes, options: { readonly told: number; readonly tier: number }): string {
  if (options.tier > 0) return PAID_ENDING;
  return at(flourishes.endings, options.told) ?? PAID_ENDING;
}

/** What this reply leans on, taken in turn the same way `endingFor` takes its ending. */
export function leanFor(flourishes: Flourishes, told: number): string | undefined {
  return at(flourishes.leans, told);
}

/** What this reply's one stage direction is about, when a world gives a rotating list of them. */
export function stagingFor(flourishes: Flourishes, told: number): string | undefined {
  return flourishes.staging ? at(flourishes.staging, told) : undefined;
}
