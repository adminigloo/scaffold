import { SCOPE_RANK, SCOPE_TAG } from "./scope.js";
import type { ScopeTagged, ProcedureScope } from "./scope.js";

/**
 * One procedure as the audit sees it.
 *
 * `scope` is optional because that is the honest shape of what a caller reads
 * off a built router: `procedure._def.meta?.scope` is `undefined` for a
 * procedure nobody annotated. Typing it as required would push the interesting
 * case — the one that got forgotten — out of the type system and into a `!`.
 */
export interface ProcedureEntry {
  /** Dotted path within the router, e.g. `billing.invoices.void`. */
  readonly path: string;
  readonly scope?: ProcedureScope;
  /** The router this procedure was registered under, e.g. `billing`. */
  readonly router: string;
}

export interface ScopeViolation {
  readonly path: string;
  readonly reason: string;
}

export interface AuditResult {
  readonly ok: boolean;
  readonly violations: ScopeViolation[];
}

/**
 * Check every procedure against the scope its router is registered for.
 *
 * Pure, and takes the inventory as data rather than reading the filesystem or
 * importing the app's routers: the caller walks its own router tree (a build
 * step, a test, a CI script) and hands the result here. That keeps the rule
 * itself testable without a repository to point it at, and means the same
 * function can audit a router assembled at runtime.
 *
 * Three ways to fail, all of them things askLou shipped:
 *
 *   1. No declared scope. An unannotated procedure is one nobody has stated an
 *      intent for, and the default for "nobody stated an intent" must be
 *      "refuse", not "public".
 *   2. Scope disagrees with the router's registration. This is the actual bug:
 *      one procedure in an otherwise tenant-scoped router built from
 *      `publicProcedure` or checked by hand, sitting in the middle of twenty
 *      that were done properly, invisible in review because the file reads
 *      fine on its own.
 *   3. The router is not in the inventory at all. Without this the guard rots
 *      the first time someone adds a router: CI stays green, and the new
 *      surface is audited by nobody. `noUncheckedIndexedAccess` makes the
 *      missing-key case impossible to ignore here, which is exactly why it is
 *      turned on.
 */
export function auditProcedureScopes(
  entries: readonly ProcedureEntry[],
  expected: Record<string, ProcedureScope>,
): AuditResult {
  const violations: ScopeViolation[] = [];

  for (const entry of entries) {
    const expectedScope = expected[entry.router];

    if (expectedScope === undefined) {
      violations.push({
        path: entry.path,
        reason:
          `Router "${entry.router}" is not in the scope inventory. Add it, so ` +
          `that a new router cannot ship unaudited.`,
      });
      continue;
    }

    if (entry.scope === undefined) {
      violations.push({
        path: entry.path,
        reason:
          `No scope declared. Add .meta({ scope: "${expectedScope}" }) — a ` +
          `procedure with no scope is invisible to this audit.`,
      });
      continue;
    }

    if (entry.scope !== expectedScope) {
      violations.push({
        path: entry.path,
        reason:
          `Declares scope "${entry.scope}" but router "${entry.router}" is ` +
          `registered as "${expectedScope}". Build it from the matching ` +
          `procedure in createProcedures rather than checking by hand.`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Deriving the rung, rather than trusting the annotation
// ---------------------------------------------------------------------------

/** The shape of a built tRPC procedure that we actually read. */
export interface BuiltProcedureLike {
  readonly _def?: {
    readonly middlewares?: readonly unknown[];
    readonly meta?: unknown;
  };
}

/**
 * The scope a procedure was ACTUALLY built from.
 *
 * This is the check that has teeth. `entry.scope` is a hand-written
 * `.meta({ scope })` annotation with no connection to the middleware chain, so
 * comparing it against the router's expected scope compares one declaration
 * against another — it catches an author who mislabels honestly and misses the
 * failure that actually happens: copying a neighbouring procedure inside a
 * tenant router carries the correct-looking `.meta({ scope: "tenant" })` along
 * while the rung silently becomes `publicProcedure`. The annotation stays
 * right, the authorization disappears, and a declaration-only audit says OK.
 *
 * `createProcedures` stamps every middleware it installs (see `tagScope`), and
 * tRPC preserves those exact function references in `_def.middlewares` through
 * the whole builder chain. Walking them reports the rung, not the claim.
 */
export function scopeOfProcedure(procedure: BuiltProcedureLike): ProcedureScope {
  const middlewares = procedure._def?.middlewares ?? [];
  let best: ProcedureScope = "public";

  for (const middleware of middlewares) {
    if (typeof middleware !== "function" && typeof middleware !== "object") continue;
    if (middleware === null) continue;
    const tag = (middleware as ScopeTagged)[SCOPE_TAG];
    if (tag === undefined) continue;
    if (SCOPE_RANK[tag] > SCOPE_RANK[best]) best = tag;
  }

  return best;
}

export interface DerivedEntry {
  readonly path: string;
  readonly router: string;
  readonly procedure: BuiltProcedureLike;
  /** The `.meta({ scope })` the author wrote, if any. */
  readonly declared?: ProcedureScope;
}

/**
 * Audit built procedures against what their routers are registered as.
 *
 * Three failures, and unlike `auditProcedureScopes` the first two are derived
 * from the middleware chain rather than from a second annotation:
 *
 *   1. the rung is weaker than the router's registered scope — the real bug
 *   2. the author's `.meta({ scope })` disagrees with the rung they used
 *   3. the router is not registered at all, so nobody is auditing it
 */
export function auditBuiltProcedures(
  entries: readonly DerivedEntry[],
  expected: Readonly<Record<string, ProcedureScope>>,
): AuditResult {
  const violations: ScopeViolation[] = [];

  for (const entry of entries) {
    const derived = scopeOfProcedure(entry.procedure);
    const want = expected[entry.router];

    if (want === undefined) {
      violations.push({
        path: entry.path,
        reason: `router "${entry.router}" is not registered in the expected-scope map, so nothing audits it`,
      });
      continue;
    }

    if (SCOPE_RANK[derived] < SCOPE_RANK[want]) {
      violations.push({
        path: entry.path,
        reason: `built from the "${derived}" rung but its router requires "${want}" — the authorization middleware is missing, whatever the meta says`,
      });
    }

    if (entry.declared !== undefined && entry.declared !== derived) {
      violations.push({
        path: entry.path,
        reason: `declares scope "${entry.declared}" but was built from the "${derived}" rung`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
