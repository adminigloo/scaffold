/**
 * Turning a refused write back into a field on this form.
 *
 * WHAT THIS EXISTS TO PREVENT. A tRPC BAD_REQUEST raised by a zod input schema
 * carries the stringified issue list as its `message`, and rendering that
 * verbatim puts this on the page:
 *
 *     [{"origin":"string","code":"too_small","minimum":1,"inclusive":true,
 *       "path":["name"],"message":"Too small: expected string to have >=1
 *       characters"}]
 *
 * Three separate failures in one paragraph. It is a parser's output rather than
 * a sentence; it names no field the admin can see, because `path: ["name"]` is
 * the input schema's key and this form has a product name and a name on every
 * variant row; and nothing on screen moves, so even a reader who decodes it has
 * to guess which of six rows to look at.
 *
 * The mapping needs the STEP the chain was on, and that is the only reason a
 * step is threaded through `saveProduct` at all: `["name"]` alone is genuinely
 * ambiguous, and no amount of cleverness here recovers what the caller knew.
 *
 * A PLAIN `.ts` MODULE, for the reason at the top of ./money.ts — esbuild will
 * not transform a `.tsx` under `jsx: "preserve"`, and an error message nobody
 * can unit test is one that gets written once and never checked again.
 *
 * THE LABELS BELOW ARE THIS FORM'S. They are the words printed above the
 * inputs, so the sentence and the thing to click say the same thing. That is
 * also why this is not in @__SCOPE__/catalog: the package cannot know what a
 * restyled admin calls its fields, and a message naming a label that is no
 * longer on the page is worse than no message.
 */

/** Which write the chain was making when it was refused. */
export type SaveStep =
  | { readonly kind: "product" }
  | { readonly kind: "variant"; readonly index: number; readonly label: string }
  | { readonly kind: "grant"; readonly index: number; readonly label: string }
  | { readonly kind: "removal"; readonly variantId: string };

/** One field to highlight, in the same `path` notation `validateProduct` uses. */
export interface FieldFault {
  readonly path: string;
  readonly message: string;
}

export interface SaveFailureReport {
  /** What to print at the top of the form. One line per fault. */
  readonly message: string;
  /** The fields to mark, in the order to fix them. Empty when none was named. */
  readonly faults: readonly FieldFault[];
}

// ---------------------------------------------------------------------------
// The form's own labels, keyed by the input schema's field names
// ---------------------------------------------------------------------------

const PRODUCT_LABELS: Readonly<Record<string, string>> = {
  slug: "URL slug",
  name: "Name",
  description: "Description",
  kind: "Kind",
  images: "Images",
  metadata: "Metadata",
  sortOrder: "Sort order",
};

const VARIANT_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  sku: "SKU",
  priceMinor: "Price",
  currency: "Currency",
  interval: "Billing interval",
  isDefault: "Preselect this one",
  inventory: "Stock",
  sortOrder: "Sort order",
};

const GRANT_LABELS: Readonly<Record<string, string>> = {
  kind: "Buying this gives them",
  "config.feature": "Feature key",
  "config.limit": "Limit",
  "config.seats": "Seats",
  "config.keyFormat": "Key format",
  "config.weightGrams": "Weight (grams)",
  "config.requiresAddress": "Checkout must collect a postal address",
};

// ---------------------------------------------------------------------------
// The DOM ids the same fields are rendered under
// ---------------------------------------------------------------------------

const PRODUCT_ELEMENT_IDS: Readonly<Record<string, string>> = {
  slug: "product-slug",
  name: "product-name",
  description: "product-description",
  kind: "product-kind",
};

/** Suffixes applied to a row's `key`, matching `id()` in VariantEditor.tsx. */
const VARIANT_ELEMENT_SUFFIXES: Readonly<Record<string, string>> = {
  name: "name",
  sku: "sku",
  priceMinor: "price",
  currency: "currency",
  interval: "interval",
  inventory: "inventory",
  isDefault: "default",
};

const GRANT_ELEMENT_SUFFIXES: Readonly<Record<string, string>> = {
  kind: "grant",
  "config.feature": "feature",
  "config.limit": "limit",
  "config.seats": "seats",
  "config.keyFormat": "keyformat",
  "config.weightGrams": "weight",
  "config.requiresAddress": "address",
};

// ---------------------------------------------------------------------------
// Reading the refusal
// ---------------------------------------------------------------------------

/** One zod issue, read defensively: this crossed a wire as JSON. */
interface RawIssue {
  readonly code?: unknown;
  readonly path?: unknown;
  readonly message?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly origin?: unknown;
  readonly expected?: unknown;
}

/**
 * Say what was refused, and which field to point at.
 *
 * Anything that is not a zod refusal is passed through unchanged. Those
 * messages — a taken slug, the publish validator's list, a permission refusal —
 * were written for this reader already, and rewording them here would be a
 * second copy of wording the server owns.
 */
export function describeSaveFailure(error: unknown, step: SaveStep): SaveFailureReport {
  const raw = messageOf(error);
  const issues = zodIssuesIn(raw, error);

  if (issues.length === 0) {
    return { message: unreachableServer(error, raw) ?? raw, faults: [] };
  }

  const faults = issues.map((issue) => faultFor(issue, step));
  return { message: faults.map((fault) => fault.message).join("\n"), faults };
}

/**
 * The element to focus, for a problem path.
 *
 * `rowKeys` rather than an index into the live rows, because a variant's inputs
 * are keyed on the row's `key` — the stable token, not the database id — and
 * this module must not know which of those a row happens to hold.
 *
 * Returns null when the path names nothing rendered. Focusing is a courtesy;
 * the sentence has to stand on its own, and a wrong `focus()` scrolls the admin
 * away from the message that would have explained it.
 */
export function formFieldId(path: string, rowKeys: readonly string[]): string | null {
  const product = /^product\.([A-Za-z0-9_]+)$/.exec(path);
  if (product) return PRODUCT_ELEMENT_IDS[product[1] ?? ""] ?? null;

  const variant = /^variants\[(\d+)\]\.(.+)$/.exec(path);
  if (variant) {
    const key = rowKeys[Number(variant[1])];
    const suffix = VARIANT_ELEMENT_SUFFIXES[variant[2] ?? ""];
    return key !== undefined && suffix !== undefined ? `${key}-${suffix}` : null;
  }

  const grant = /^grants\[(\d+)\]\.(.+)$/.exec(path);
  if (grant) {
    const key = rowKeys[Number(grant[1])];
    const suffix = GRANT_ELEMENT_SUFFIXES[grant[2] ?? ""];
    return key !== undefined && suffix !== undefined ? `${key}-${suffix}` : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The issues behind a BAD_REQUEST, from whichever shape survived the wire.
 *
 * tRPC puts `JSON.stringify(error.issues)` in the message, which is the richer
 * source — it keeps `minimum`, `maximum` and the nested path. `data.zodError`
 * is the fallback, and it is a `flatten()`, so nested paths have already been
 * collapsed to their first segment by the time it is read.
 */
function zodIssuesIn(raw: string, error: unknown): readonly RawIssue[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every(isIssueLike)) return parsed;
    } catch {
      // Not JSON after all. A server message may legitimately begin with "[".
    }
  }

  const flattened = flattenedZodError(error);
  if (!flattened) return [];
  return Object.entries(flattened).flatMap(([field, messages]) =>
    messages.map((message): RawIssue => ({ code: "custom", path: [field], message })),
  );
}

function isIssueLike(value: unknown): value is RawIssue {
  return typeof value === "object" && value !== null && "code" in value;
}

/** `data.zodError.fieldErrors` off a TRPCClientError, or null. */
function flattenedZodError(error: unknown): Record<string, string[]> | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("zodError" in data)) return null;
  const zodError = (data as { readonly zodError?: unknown }).zodError;
  if (typeof zodError !== "object" || zodError === null || !("fieldErrors" in zodError)) {
    return null;
  }
  const fieldErrors = (zodError as { readonly fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== "object" || fieldErrors === null) return null;

  const out: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (Array.isArray(messages)) out[field] = messages.filter((m): m is string => typeof m === "string");
  }
  return out;
}

/**
 * A dropped connection, said as such.
 *
 * `fetch` rejects with "Failed to fetch" — six words that describe the browser's
 * internals and nothing the reader can act on. It matters here more than
 * elsewhere because this is the failure most likely to land MID-CHAIN, so the
 * recovery sentence the caller appends is the useful half of the message.
 */
function unreachableServer(error: unknown, raw: string): string | null {
  const network =
    /failed to fetch|networkerror|load failed|fetch failed|err_internet_disconnected/i.test(
      raw,
    ) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { readonly name?: unknown }).name === "TypeError" &&
      /fetch/i.test(raw));

  return network
    ? "The browser could not reach the server, so this save stopped where it was. " +
        "Nothing further was sent."
    : null;
}

function faultFor(issue: RawIssue, step: SaveStep): FieldFault {
  const segments = Array.isArray(issue.path) ? issue.path.map(String) : [];
  const field = segments.join(".");
  const label = labelFor(field, step);

  if (label === null) {
    // A field this form does not render — or none at all, for a refinement on
    // the whole object. Naming the step is still better than naming nothing.
    return {
      path: pathFor(field === "" ? "$root" : field, step),
      message: `${capitalise(subjectOf(step))} was refused: ${zodSentence(issue)}`,
    };
  }

  return {
    path: pathFor(field, step),
    message: `“${label}” on ${subjectOf(step)} ${clauseFor(issue)}`,
  };
}

function labelFor(field: string, step: SaveStep): string | null {
  if (field === "") return null;
  switch (step.kind) {
    case "product":
      return PRODUCT_LABELS[field] ?? null;
    case "variant":
      return VARIANT_LABELS[field] ?? null;
    case "grant":
      return GRANT_LABELS[field] ?? null;
    case "removal":
      return null;
  }
}

/** The `validateProduct` path notation, so one component renders both sources. */
function pathFor(field: string, step: SaveStep): string {
  switch (step.kind) {
    case "product":
      return `product.${field}`;
    case "variant":
      return `variants[${step.index}].${field}`;
    case "grant":
      return `grants[${step.index}].${field}`;
    case "removal":
      return "variants";
  }
}

/**
 * What the sentence is about: "the product", or a named row.
 *
 * The row's position is always given, even when it has a name, because the
 * position is what the admin scrolls to and two variants may share a name.
 */
function subjectOf(step: SaveStep): string {
  switch (step.kind) {
    case "product":
      return "the product";
    case "variant":
      return named(`variant ${step.index + 1}`, step.label, step.index);
    case "grant":
      return `${named(`variant ${step.index + 1}`, step.label, step.index)}’s grant`;
    case "removal":
      return "the variant being removed";
  }
}

/** `variant 2 (“Deluxe”)`, or just `variant 2` when the row has no name yet. */
function named(position: string, label: string, index: number): string {
  return label === `variant ${index + 1}` ? position : `${position} (“${label}”)`;
}

function clauseFor(issue: RawIssue): string {
  const code = typeof issue.code === "string" ? issue.code : "";
  const onAString = issue.origin === "string";
  const minimum = numberOf(issue.minimum);
  const maximum = numberOf(issue.maximum);

  if (code === "too_small" && onAString && minimum === 1) return "cannot be empty.";
  if (code === "too_small" && onAString && minimum !== null) {
    return `needs at least ${minimum} characters.`;
  }
  if (code === "too_small" && minimum !== null) return `must be ${minimum} or more.`;
  if (code === "too_big" && onAString && maximum !== null) {
    return `is too long: the most it can hold is ${maximum} characters.`;
  }
  if (code === "too_big" && maximum !== null) return `must be ${maximum} or less.`;
  if (code === "invalid_type") {
    const expected = typeof issue.expected === "string" ? issue.expected : "a value";
    return `is missing, or holds something other than ${expected}.`;
  }
  return `was not accepted: ${zodSentence(issue)}`;
}

/** Zod's own sentence, ended properly, or a stand-in when it sent none. */
function zodSentence(issue: RawIssue): string {
  const message = typeof issue.message === "string" ? issue.message.trim() : "";
  if (message === "") return "the server did not say why.";
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // superjson carries a zod `minimum` as a bigint when the schema used one.
  if (typeof value === "bigint") return Number(value);
  return null;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
