import { createHash } from "node:crypto";

/**
 * How many stack frames take part.
 *
 * Three, because the top frame alone merges every caller of a shared helper
 * into one row — `assertDefined` throwing from forty places is forty bugs —
 * while the full stack splits one bug across every route that can reach it,
 * and the router hops nearest the top of a tRPC stack differ per procedure.
 * Three is where the same failure from two entry points still merges and two
 * different failures in the same file still separate.
 */
export const DEFAULT_FINGERPRINT_FRAMES = 3;

/**
 * 16 hex characters, 64 bits.
 *
 * The population being hashed is distinct BUGS — thousands over the life of an
 * application, not millions — so the birthday bound is many orders of
 * magnitude away, and 16 characters fit in a table cell and paste into a
 * ticket. A full digest buys nothing here and gets truncated by hand in the UI
 * anyway, at which point the truncation is nobody's decision.
 */
export const FINGERPRINT_LENGTH = 16;

export interface FingerprintOptions {
  readonly frames?: number;
}

/**
 * Volatile substrings, replaced before anything is hashed.
 *
 * ORDER IS LOAD BEARING. UUIDs go first, because their segments would
 * otherwise be eaten piecemeal by the digit and hex rules and two different
 * ids could normalise to two different shapes. ISO timestamps go before the
 * digit rule for the same reason. `0x…` goes before the bare-hex rule so the
 * prefix does not survive as `0x<hex>`.
 *
 * The digit rule starts at four characters on purpose. Shorter runs are load
 * bearing far more often than they are volatile — "expected 2 arguments",
 * "reading 'x'" — and normalising them merges genuinely different bugs, which
 * is the failure that cannot be detected from the outside: the row count looks
 * healthy and one of the two bugs is simply never seen again.
 */
const NORMALISERS: readonly (readonly [RegExp, string])[] = [
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<uuid>",
  ],
  [/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/0x[0-9a-f]+/gi, "<addr>"],
  [/\b[0-9a-f]{16,}\b/gi, "<hex>"],
  [/\b\d{4,}\b/g, "<n>"],
];

const FRAME_LINE = /^\s*at\s+(.*)$/;
const FRAME_WITH_LOCATION = /^(.*?)\s*\((.*)\)$/;
/** A trailing `:line` or `:line:column`. */
const SOURCE_POSITION = /:\d+(?::\d+)?$/;

/**
 * The exact text `errorFingerprint` hashes.
 *
 * Exported because "why did these two errors merge" and "why did these two not
 * merge" are asked about every fingerprinting scheme ever shipped, and a hash
 * cannot answer either. Same role `explainPermission` plays for the resolver:
 * the decision, in a form a human can read.
 */
export function fingerprintSource(
  error: unknown,
  options: FingerprintOptions = {},
): string {
  const described = describeError(error);
  const frames = stackFrames(
    described.stack,
    options.frames ?? DEFAULT_FINGERPRINT_FRAMES,
  );
  return [described.name, normalise(described.message), ...frames].join("\n");
}

/**
 * A stable identity for a bug.
 *
 * Two occurrences of the same bug MUST hash the same across deploys and across
 * machines, because this value is the unique key of `error_log`. Everything
 * that varies between two runs of one bug is stripped first:
 *
 *   - absolute paths      `C:\Users\dev\src\x.ts` and `/var/task/src/x.ts` are
 *                         the same file; only the basename survives
 *   - line and column     a comment added above the throw is not a new bug
 *   - UUIDs and ids       the tenant in the message changes every request
 *   - hex addresses       heap pointers and build hashes change per process
 *   - build artifacts     `.next/server/chunks/4821.js` becomes `<n>.js`
 *
 * `error.cause` is deliberately NOT folded in. A wrapper such as
 * `WebhookVerificationError` carries a different cause on every request — svix
 * returns a distinct parse error per malformed body — so including it would
 * mint a new fingerprint per occurrence for precisely the error class that
 * repeats most, which is the one case the unique index exists to handle.
 */
export function errorFingerprint(
  error: unknown,
  options: FingerprintOptions = {},
): string {
  return createHash("sha256")
    .update(fingerprintSource(error, options), "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

interface DescribedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

function describeError(error: unknown): DescribedError {
  if (typeof error === "string") {
    return { name: "Error", message: error, stack: "" };
  }
  if (isErrorLike(error)) {
    const name = typeof error.name === "string" ? error.name : "";
    return {
      name: name.length > 0 ? name : "Error",
      message: typeof error.message === "string" ? error.message : "",
      stack: typeof error.stack === "string" ? error.stack : "",
    };
  }
  // `throw 42`, `throw null`, `throw { code: 500 }`. Everything non-Error
  // collapses to one fingerprint, which is the honest outcome: there is no
  // stack and nothing stable to tell two of them apart. `Object.prototype
  // .toString` rather than `JSON.stringify` because stringifying an arbitrary
  // thrown object puts whatever it was carrying into the `message` column of a
  // table that is kept for a year.
  return {
    name: "NonError",
    message: Object.prototype.toString.call(error),
    stack: "",
  };
}

/**
 * Duck-typed rather than `instanceof Error` alone.
 *
 * `instanceof` is false for an error that crossed a worker, a vm context or a
 * structured clone — which is exactly the error thrown by a background job,
 * where nobody is watching and the error log is the only record.
 */
function isErrorLike(
  value: unknown,
): value is { name?: unknown; message?: unknown; stack?: unknown } {
  if (value instanceof Error) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

function stackFrames(stack: string, limit: number): readonly string[] {
  if (limit <= 0) return [];
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const match = FRAME_LINE.exec(line);
    if (!match) continue;
    const frame = canonicalFrame(match[1] ?? "");
    if (frame === null) continue;
    frames.push(frame);
    if (frames.length === limit) break;
  }
  return frames;
}

/**
 * One V8 frame reduced to `function@file`.
 *
 * Handles the four shapes V8 emits — `at fn (loc)`, `at loc`, `at async fn
 * (loc)`, `at new Fn (loc)` — plus the locations the platform invents:
 * `file:///C:/…`, `webpack-internal:///(rsc)/./src/…`, `node:internal/…`.
 */
function canonicalFrame(body: string): string | null {
  const match = FRAME_WITH_LOCATION.exec(body);
  const rawFunction = match ? (match[1] ?? "") : "";
  const rawLocation = match ? (match[2] ?? "") : body;

  const fn = normalise(rawFunction.replace(/^async\s+/, "").trim());
  const file = normalise(basename(rawLocation.replace(SOURCE_POSITION, "")));
  if (fn === "" && file === "") return null;
  return `${fn}@${file}`;
}

function basename(location: string): string {
  // Query strings and hashes are cache-busting noise: Next.js appends `?v=…`
  // to a chunk on every build, so leaving them in reissues every fingerprint
  // in the table on each deploy.
  const withoutQuery = location.split(/[?#]/)[0] ?? "";
  const segments = withoutQuery.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

function normalise(text: string): string {
  let out = text;
  for (const [pattern, replacement] of NORMALISERS) {
    out = out.replace(pattern, replacement);
  }
  // Collapsed last. Node reflows some built-in messages between versions, and
  // a fingerprint that changes on a runtime upgrade orphans every row that
  // came before it.
  return out.replace(/\s+/g, " ").trim();
}
