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
    /** The `.input()` parsers, in order (the rung's own first). Read by `inputFieldsOf`. */
    readonly inputs?: readonly unknown[];
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
    // THE FULL PATH WINS OVER THE ROUTER NAME (Tenancy 1). A mixed router
    // declares its exceptions: `invoicing: "staff"` beside
    // `"invoicing.byToken": "public"`. Without this, one public procedure in a
    // staff router forced the whole router to be registered as public, which
    // let every other procedure in it be weakened unnoticed.
    const want = expected[entry.path] ?? expected[entry.router];

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

/** The part of a built tRPC router that `inventoryOf` reads. */
export interface RouterLike {
  readonly _def: { readonly procedures: Readonly<Record<string, unknown>> };
}

function isScope(value: unknown): value is ProcedureScope {
  return value === "public" || value === "authenticated" || value === "tenant" || value === "staff";
}

/**
 * Every procedure of a built router, flattened, ready for
 * `auditBuiltProcedures` (PC-19: the scope audit existed but nothing fed it).
 *
 * tRPC 11's `router._def.procedures` is already flat and keyed by dotted path
 * (verified against @trpc/server 11.18: `["a", "b.c", "b.d.e"]`), so this is a
 * map, not a walk. `router` is the first path segment ("" for a root-level
 * procedure); `declared` is the author's `.meta({ scope })` when it is a valid
 * scope, so the audit can also catch a label that disagrees with the rung.
 *
 *   const result = auditBuiltProcedures(inventoryOf(appRouter), EXPECTED_SCOPES);
 */
export function inventoryOf(router: RouterLike): DerivedEntry[] {
  return Object.entries(router._def.procedures).map(([path, procedure]) => {
    const dot = path.indexOf(".");
    const built = procedure as BuiltProcedureLike;
    const meta = built._def?.meta as { scope?: unknown } | undefined;
    return {
      path,
      router: dot < 0 ? "" : path.slice(0, dot),
      procedure: built,
      ...(isScope(meta?.scope) ? { declared: meta.scope } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// What a procedure takes, for the isolation proof
// ---------------------------------------------------------------------------

/** One leaf of a procedure's input, as `inputFieldsOf` reports it. */
export interface InputField {
  /** Dotted, with `[]` for an array element: `"filter.memberIds[]"`. */
  readonly path: string;
  /** The same path as segments (`["filter", "memberIds", "[]"]`), for building an input that sets it. */
  readonly segments: readonly string[];
  /** The last named key on the path (`"memberIds"`). */
  readonly key: string;
  /** The leaf's type, lowercased: "string", "number", "enum", "boolean", … */
  readonly kind: string;
  /** It, or something it sits inside, may be left out (optional, nullish, or has a default). */
  readonly optional: boolean;
  /** It sits inside an array. */
  readonly inArray: boolean;
}

interface SchemaWalk {
  readonly out: Map<string, InputField>;
  readonly seen: Set<unknown>;
}

/** zod 4 keeps the definition on `_zod.def` (and `_def`), with `type`; zod 3 on `_def`, with `typeName`. */
function definitionOf(schema: unknown): { readonly kind: string; readonly def: Record<string, unknown> } | null {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as { _zod?: { def?: unknown }; _def?: unknown };
  const def = (s._zod?.def ?? s._def) as Record<string, unknown> | undefined;
  if (typeof def !== "object" || def === null) return null;
  if (typeof def["type"] === "string") return { kind: def["type"], def };
  if (typeof def["typeName"] === "string") return { kind: def["typeName"].replace(/^Zod/, "").toLowerCase(), def };
  return null;
}

function shapeOf(schema: unknown, def: Record<string, unknown>): Record<string, unknown> {
  const fromDef = typeof def["shape"] === "function" ? (def["shape"] as () => unknown)() : def["shape"];
  const shape = fromDef ?? (schema as { shape?: unknown }).shape;
  return typeof shape === "object" && shape !== null ? (shape as Record<string, unknown>) : {};
}

function walkSchema(
  walk: SchemaWalk,
  schema: unknown,
  segments: readonly string[],
  optional: boolean,
  inArray: boolean,
): void {
  // A recursive schema (z.lazy) would walk forever; a schema already on this
  // path is reported once, where it was first met.
  if (segments.length > 12 || walk.seen.has(schema)) return;
  const found = definitionOf(schema);
  if (!found) return;
  const { kind, def } = found;
  walk.seen.add(schema);
  try {
    switch (kind) {
      case "object":
        for (const [key, child] of Object.entries(shapeOf(schema, def))) walkSchema(walk, child, [...segments, key], optional, inArray);
        return;
      case "optional":
      case "nullable":
      case "nullish":
      case "default":
      case "prefault":
      case "catch":
        walkSchema(walk, def["innerType"], segments, true, inArray);
        return;
      case "readonly":
      case "nonoptional":
        walkSchema(walk, def["innerType"], segments, optional, inArray);
        return;
      case "branded":
        walkSchema(walk, def["type"], segments, optional, inArray);
        return;
      case "array":
        // zod 4: def.element; zod 3: def.type.
        walkSchema(walk, def["element"] ?? def["type"], [...segments, "[]"], optional, true);
        return;
      case "set":
        walkSchema(walk, def["valueType"], [...segments, "[]"], optional, true);
        return;
      case "tuple":
        for (const item of (def["items"] as unknown[] | undefined) ?? []) walkSchema(walk, item, [...segments, "[]"], optional, true);
        return;
      case "union":
      case "discriminatedunion": {
        const options = def["options"];
        for (const option of Array.isArray(options) ? options : options instanceof Map ? [...options.values()] : []) {
          walkSchema(walk, option, segments, optional, inArray);
        }
        return;
      }
      case "intersection":
        walkSchema(walk, def["left"], segments, optional, inArray);
        walkSchema(walk, def["right"], segments, optional, inArray);
        return;
      case "pipe":
      case "pipeline":
        walkSchema(walk, def["in"], segments, optional, inArray);
        return;
      case "effects":
        walkSchema(walk, def["schema"], segments, optional, inArray);
        return;
      case "lazy":
        if (typeof def["getter"] === "function") walkSchema(walk, (def["getter"] as () => unknown)(), segments, optional, inArray);
        return;
      case "record":
        walkSchema(walk, def["valueType"], [...segments, "*"], true, inArray);
        return;
      default: {
        if (segments.length === 0) return;
        const path = segments.join(".").replace(/\.\[\]/g, "[]");
        const key = [...segments].reverse().find((s) => s !== "[]" && s !== "*") ?? "";
        const previous = walk.out.get(path);
        walk.out.set(path, {
          path,
          segments,
          key,
          kind: previous && previous.kind !== kind ? "union" : kind,
          optional: optional || (previous?.optional ?? false),
          inArray,
        });
      }
    }
  } finally {
    walk.seen.delete(schema);
  }
}

/**
 * Every leaf field a procedure's input parsers declare — required, OPTIONAL,
 * nested in objects and inside arrays — read off the zod schemas themselves
 * (zod 3 and 4), without running anything.
 *
 * WHY (review R3 TB2-01): the isolation proof checked a "tenant-only"
 * procedure by parsing B's company id alone. A required second id failed that
 * parse and was caught; an OPTIONAL one (`userId: z.string().optional()`)
 * parsed fine, the proof never sent it, and a procedure that read a member of
 * ANY company by that id passed as isolated. Walking the declared shape is
 * what lets the proof find every id a procedure can be handed, not only the
 * ones it insists on.
 *
 * Fields are merged across `.input()` calls; the rung's own `tenantId` is
 * among them. A parser that isn't zod contributes nothing.
 */
export function inputFieldsOf(procedure: BuiltProcedureLike): InputField[] {
  const walk: SchemaWalk = { out: new Map(), seen: new Set() };
  for (const parser of procedure._def?.inputs ?? []) walkSchema(walk, parser, [], false, false);
  return [...walk.out.values()];
}

/**
 * Does this input name read as a row's id? `id`, `ids`, `userId`,
 * `memberIds`, `orderID`, `visit_id` — the names a procedure gives the id of
 * something a company owns. `paid`, `valid` and `tierKey` are not.
 */
export function looksLikeAnId(key: string): boolean {
  return /^(id|ids|uuid|uuids)$/i.test(key) || /[a-z0-9](Id|Ids|ID|IDs)$/.test(key) || /[a-z0-9]_ids?$/i.test(key);
}
