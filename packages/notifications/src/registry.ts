/**
 * The alert-kind registry (Tenancy 2b-1, 4.2; D3).
 *
 * Each package that produces alerts owns its kinds: their words, who they go
 * to, their default channel. It exports a FRAGMENT (`schedulingAlertKinds`,
 * `estimatorAlertKinds`, …), structurally, with no import of this package
 * (2a D4), and the project composes them with `defineAlertRegistry([...])`,
 * exactly like the permission and settings fragments. A wording fix in a
 * package reaches every project by npm; the project's glue only connects an
 * event stream to `alerts.notify`.
 *
 * A kind key is PERMANENT: it is stored on every alert row and on every
 * person's choice. So it is checked at definition time (a package's own test
 * catches a bad key), and two fragments claiming one key are refused when the
 * registry is built, not discovered later as two packages' alerts mixed up.
 */

export type AlertChannel = "in_app" | "email";

/** 3.2's `<Pkg>AlertKind`, exactly. */
export interface AlertKindSpec {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase: "Someone asks for an estimate". */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under: "Estimates", "Visits", "Invoices", "Messages", "Team". */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: AlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

/** 3.2's `<Pkg>AlertRouting`, exactly. */
export interface AlertRoutingSpec {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  /** "New estimate requests and quote answers" */
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

export interface AlertKindsFragment {
  readonly kinds: readonly AlertKindSpec[];
  readonly routings?: readonly AlertRoutingSpec[];
}

export class InvalidAlertKindError extends Error {
  readonly name = "InvalidAlertKindError";
}

export class DuplicateAlertKindError extends Error {
  readonly name = "DuplicateAlertKindError";
}

export interface AlertRegistry {
  /** Ordered: categories in first-seen order, then `order`, then key. */
  readonly kinds: readonly AlertKindSpec[];
  readonly routings: readonly AlertRoutingSpec[];
  readonly categories: readonly string[];
  /** Every distinct permission the kinds' audiences (and assigned) and the routings name, sorted: what a reader is asked for (4.7). */
  readonly permissions: readonly string[];
  kind(key: string): AlertKindSpec | undefined;
  routing(key: string): AlertRoutingSpec | undefined;
}

export const ALERT_KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
export const ALERT_ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const DEFAULT_ORDER = 100;

function text(value: unknown, min: number, max: number): boolean {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function permission(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= 120;
}

function checkKind(kind: AlertKindSpec): void {
  const key = (kind as { key?: unknown } | null)?.key;
  const name = typeof key === "string" ? key : JSON.stringify(key);
  const refuse = (why: string) => {
    throw new InvalidAlertKindError(`Alert kind ${name}: ${why}`);
  };
  if (!kind || typeof kind !== "object") throw new InvalidAlertKindError("An alert kind must be an object.");
  if (typeof key !== "string" || key.length > 64 || !ALERT_KIND_KEY.test(key)) {
    refuse("the key must look like `package.thing.what` (lower case, at most 64 characters).");
  }
  if (!text(kind.label, 1, 80)) refuse("the label must be 1 to 80 characters.");
  if (!text(kind.category, 1, 40)) refuse("the category must be 1 to 40 characters.");
  if (!optionalText(kind.description, 200)) refuse("the description must be at most 200 characters.");
  if (!kind.audience || typeof kind.audience !== "object" || !permission(kind.audience.permission)) {
    refuse("audience.permission must name a permission.");
  }
  if (kind.audience.routing !== undefined && (typeof kind.audience.routing !== "string" || !ALERT_ROUTING_KEY.test(kind.audience.routing))) {
    refuse("audience.routing must be a routing group key.");
  }
  if (kind.audience.assigned !== undefined && (!kind.audience.assigned || !permission(kind.audience.assigned.permission))) {
    refuse("audience.assigned.permission must name a permission.");
  }
  if (kind.defaultChannel !== "in_app" && kind.defaultChannel !== "email") refuse('defaultChannel must be "in_app" or "email".');
  if (kind.email !== undefined && typeof kind.email !== "boolean") refuse("email must be true or false.");
  if (kind.email === false && kind.defaultChannel === "email") refuse('a kind that is never emailed can\'t default to "email".');
  if (kind.emailBy !== undefined && kind.emailBy !== "notifications" && kind.emailBy !== "producer") {
    refuse('emailBy must be "notifications" or "producer".');
  }
  if (kind.email === false && kind.emailBy === "producer") refuse('a kind that is never emailed can\'t have emailBy "producer".');
  if (kind.order !== undefined && (typeof kind.order !== "number" || !Number.isFinite(kind.order))) refuse("order must be a number.");
}

function checkRouting(routing: AlertRoutingSpec): void {
  const key = (routing as { key?: unknown } | null)?.key;
  const name = typeof key === "string" ? key : JSON.stringify(key);
  const refuse = (why: string) => {
    throw new InvalidAlertKindError(`Alert routing group ${name}: ${why}`);
  };
  if (!routing || typeof routing !== "object") throw new InvalidAlertKindError("A routing group must be an object.");
  if (typeof key !== "string" || !ALERT_ROUTING_KEY.test(key)) refuse("the key must be 2 to 32 lower-case letters, digits or dashes.");
  if (!text(routing.label, 1, 80)) refuse("the label must be 1 to 80 characters.");
  if (!optionalText(routing.description, 200)) refuse("the description must be at most 200 characters.");
  if (!permission(routing.permission)) refuse("permission must name a permission.");
  if (routing.order !== undefined && (typeof routing.order !== "number" || !Number.isFinite(routing.order))) refuse("order must be a number.");
}

function checkFragment(fragment: AlertKindsFragment): void {
  if (!fragment || typeof fragment !== "object" || !Array.isArray(fragment.kinds)) {
    throw new InvalidAlertKindError("An alert-kinds fragment is { kinds: [...], routings?: [...] }.");
  }
  if (fragment.routings !== undefined && !Array.isArray(fragment.routings)) {
    throw new InvalidAlertKindError("An alert-kinds fragment's routings must be a list.");
  }
  const keys = new Set<string>();
  for (const kind of fragment.kinds) {
    checkKind(kind);
    if (keys.has(kind.key)) throw new DuplicateAlertKindError(`Alert kind ${kind.key} is declared twice.`);
    keys.add(kind.key);
  }
  const routings = new Set<string>();
  for (const routing of fragment.routings ?? []) {
    checkRouting(routing);
    if (routings.has(routing.key)) throw new DuplicateAlertKindError(`Alert routing group ${routing.key} is declared twice.`);
    routings.add(routing.key);
  }
}

/** Checks one fragment now (InvalidAlertKindError), so a package's own test catches a bad key. */
export function defineAlertKinds<const F extends AlertKindsFragment>(fragment: F): F {
  checkFragment(fragment);
  return fragment;
}

/**
 * The project's registry from every installed package's fragment. Refuses a
 * duplicate kind or routing key across fragments, and a kind naming a routing
 * group no fragment declares (the group would have no label, no permission
 * and no place in Alert settings).
 */
export function defineAlertRegistry(fragments: readonly AlertKindsFragment[]): AlertRegistry {
  if (!Array.isArray(fragments)) throw new InvalidAlertKindError("defineAlertRegistry takes a list of fragments.");
  const kinds = new Map<string, AlertKindSpec>();
  const routings = new Map<string, AlertRoutingSpec>();
  for (const fragment of fragments) {
    checkFragment(fragment);
    for (const kind of fragment.kinds) {
      if (kinds.has(kind.key)) throw new DuplicateAlertKindError(`Alert kind ${kind.key} is declared by two packages.`);
      kinds.set(kind.key, kind);
    }
    for (const routing of fragment.routings ?? []) {
      if (routings.has(routing.key)) throw new DuplicateAlertKindError(`Alert routing group ${routing.key} is declared by two packages.`);
      routings.set(routing.key, routing);
    }
  }
  for (const kind of kinds.values()) {
    if (kind.audience.routing !== undefined && !routings.has(kind.audience.routing)) {
      throw new InvalidAlertKindError(`Alert kind ${kind.key} names the routing group ${kind.audience.routing}, which no package declares.`);
    }
  }

  const categories: string[] = [];
  for (const kind of kinds.values()) if (!categories.includes(kind.category)) categories.push(kind.category);
  const orderedKinds = [...kinds.values()].sort(
    (a, b) =>
      categories.indexOf(a.category) - categories.indexOf(b.category) ||
      (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const orderedRoutings = [...routings.values()].sort(
    (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const permissions = new Set<string>();
  for (const kind of orderedKinds) {
    permissions.add(kind.audience.permission);
    if (kind.audience.assigned) permissions.add(kind.audience.assigned.permission);
  }
  for (const routing of orderedRoutings) permissions.add(routing.permission);

  const byKind = new Map(orderedKinds.map((kind) => [kind.key, kind] as const));
  const byRouting = new Map(orderedRoutings.map((routing) => [routing.key, routing] as const));
  return Object.freeze({
    kinds: Object.freeze(orderedKinds),
    routings: Object.freeze(orderedRoutings),
    categories: Object.freeze(categories),
    permissions: Object.freeze([...permissions].sort()),
    kind: (key: string) => byKind.get(key),
    routing: (key: string) => byRouting.get(key),
  });
}
