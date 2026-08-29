import { pino } from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

/**
 * The censor written in place of anything redacted.
 *
 * One constant for both mechanisms below, because the first thing anyone does
 * after a leak scare is grep the aggregator for the marker. Two spellings mean
 * half the hits are missed and the sweep reads as clean.
 */
export const REDACTED = "[redacted]";

/**
 * Mirrors `coreServer().LOG_LEVEL` from @adminigloo/env so
 * `createLogger({ level: env.LOG_LEVEL })` typechecks with no cast at the one
 * call site every app writes. Spelled out rather than re-exported from pino:
 * pino's level union is a pino implementation detail, and the app's env schema
 * is the thing this has to stay in step with.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Header paths that need spelling out because they sit deeper than one level.
 *
 * `authorization` itself is not here — it is in `SECRET_PROPERTY_NAMES` below,
 * which covers `{ headers: { authorization } }` through the leading wildcard
 * and top-level `{ authorization }` at the same time. Only the three-deep
 * shapes (`req.headers.…`) need a literal path.
 *
 * `stripe-signature` and `svix-signature` are not bearer tokens, and they are
 * here anyway: logged next to the raw body, the pair is a pre-signed request
 * that replays against our own webhook route.
 */
const HEADER_PATHS: readonly string[] = [
  "headers.cookie",
  "headers.Cookie",
  'headers["set-cookie"]',
  'headers["stripe-signature"]',
  'headers["svix-signature"]',
  'headers["upstash-signature"]',
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'req.headers["stripe-signature"]',
  'req.headers["svix-signature"]',
  'res.headers["set-cookie"]',
  "request.headers.authorization",
  "request.headers.cookie",
];

/**
 * Property names that hold a secret whatever object they turn up on.
 *
 * `tokenHash` is deliberate. It is not a bearer credential, but it is the
 * stored verifier for an invitation and `verifyInvitationToken` compares
 * against exactly this value, so a hash in a log plus read access to the code
 * is an accepted invite.
 *
 * `Authorization` is listed alongside `authorization` because Node lowercases
 * inbound header names but a hand-built object literal, an
 * `Object.fromEntries(request.headers)` dump and anything pasted out of a
 * provider's docs do not — and fast-redact matches segments byte for byte.
 */
const SECRET_PROPERTY_NAMES: readonly string[] = [
  "authorization",
  "Authorization",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "idToken",
  "secret",
  "clientSecret",
  "webhookSecret",
  "signingSecret",
  "apiKey",
  "privateKey",
];

/**
 * The environment variables this scaffold actually defines, by name.
 *
 * Enumerated rather than globbed because fast-redact matches whole path
 * segments: there is no `*_SECRET` suffix wildcard, and writing one produces a
 * path that quietly matches nothing rather than an error. Everything this list
 * cannot anticipate is what `redactValue` is for.
 *
 * DATABASE_URL is the entry that matters most. It carries the role password
 * inline, every driver puts the URL in scope at the moment it throws, and a
 * connection string logged once in an error path is a credential sitting in a
 * log aggregator forever — long after the incident is closed, readable by
 * everyone who can read logs, and rotated by nobody because nobody knows it is
 * there.
 */
const ENV_SECRET_NAMES: readonly string[] = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_AUTH_TOKEN",
  // AI provider keys. @adminigloo/ai declares all three, and an LLM call that
  // fails is exactly the kind of thing that gets logged with its whole config.
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "PERPLEXITY_API_KEY",
  // Secrets the app mints itself.
  "CRON_SECRET",
  "PARTICIPANT_PIN_PEPPER",
  "PARTICIPANT_COOKIE_SECRET",
  "IMPORT_PII_SALT",
  // Blob / object storage.
  "BLOB_READ_WRITE_TOKEN",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  // Google service-account private key — a whole PEM in one variable.
  "GSC_PRIVATE_KEY",
];

/**
 * The default redaction paths, exported so an app can EXTEND them:
 *
 *   createLogger({ redact: ["acme.ssn", "*.dateOfBirth"] })
 *
 * `createLogger` concatenates; there is no option to replace. Replacement is
 * how a list like this rots — someone needs one extra path, passes an array of
 * one, and every header above goes back to being logged in full.
 *
 * Each name appears twice, bare and under a leading wildcard, because a path
 * is matched in full: `password` catches `{ password }`, `*.password` catches
 * `{ input: { password } }`, and neither catches the other.
 */
export const REDACT_PATHS: readonly string[] = [
  ...HEADER_PATHS,
  ...[...SECRET_PROPERTY_NAMES, ...ENV_SECRET_NAMES].flatMap((name) => [
    name,
    `*.${name}`,
  ]),
];

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  /** Extra paths, ADDED to `REDACT_PATHS`. */
  readonly redact?: readonly string[];
  /**
   * Fields stamped on every line: service name, release, region.
   *
   * Supplying this REPLACES pino's default `{ pid, hostname }`, which is the
   * point on a serverless platform — pid is always 1 and hostname is a
   * container id that lives for one invocation, so the two default fields are
   * noise on every line of every request.
   */
  readonly base?: Record<string, string | number | boolean | null>;
  /**
   * Where lines go. Defaults to stdout.
   *
   * Injected so the redaction list can be asserted against real pino output.
   * An unexercised redaction list is a list of typos: an unmatched path is not
   * an error in fast-redact, it is simply a path that never fires.
   */
  readonly destination?: DestinationStream;
}

/**
 * A pino logger with the scaffold's redaction list already applied.
 *
 * The wrapper exists for one reason: so that no app ever constructs a bare
 * `pino()`. Redaction has to be the default state of the logger rather than a
 * step someone remembers, because the lines that leak are written in error
 * paths nobody reviewed.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  // Deduped, because an app extending the list naturally re-lists a path it
  // also cares about. fast-redact rejects a duplicate path by throwing during
  // construction, which kills the process before it can log the reason.
  const paths = [...new Set([...REDACT_PATHS, ...(options.redact ?? [])])];

  const config: LoggerOptions = {
    level: options.level ?? "info",
    redact: { paths, censor: REDACTED },
    formatters: {
      // pino writes `"level":30`. Every aggregator we target indexes the
      // string, so without this the "show me errors" filter is written against
      // a magic number nobody remembers is 50.
      level: (label: string) => ({ level: label }),
    },
  };
  if (options.base !== undefined) config.base = { ...options.base };

  return options.destination === undefined
    ? pino(config)
    : pino(config, options.destination);
}

/**
 * Credential shapes, matched anywhere inside a string.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Stripe secret, publishable and restricted keys — and Clerk's, which use
  // the identical `<kind>_<mode>_<random>` shape. One rule covers
  // CLERK_SECRET_KEY and STRIPE_SECRET_KEY both.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  // The same families with no mode marker.
  /\b(?:sk|rk)_[A-Za-z0-9]{20,}/g,
  // Stripe endpoint secrets and Svix signing secrets.
  /\bwhsec_[A-Za-z0-9+/=_-]{16,}/g,
  // Resend. The `{20,}` is not cosmetic: a bare `\bre_` would redact a large
  // share of the identifiers in this codebase and make error messages
  // unreadable, which is how an over-eager redactor gets switched off entirely.
  /\bre_[A-Za-z0-9_-]{20,}/g,
  // A JWT in an error message is a live session, not a debugging aid.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Anthropic and OpenAI are HYPHEN-delimited and match none of the
  // underscore rules above. This same repo validates them with
  // prefixedSecret("sk-ant-") and prefixedSecret("sk-"), so the keys are known
  // to be present and were being logged in full. Longest prefix first, so the
  // generic sk- rule cannot consume only the head of a longer key and leave
  // the rest of the secret in the log.
  /\bsk-ant-[A-Za-z0-9-]{16,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens — this scaffold's own registry credential is one of these.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
];

/**
 * Runs BEFORE the patterns above so the scheme survives into the log. "Bearer
 * [redacted]" still answers "was this request authenticated at all", which is
 * the first question asked about a 401 nobody can reproduce.
 */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `scheme://user:password@host/db`, for any of the URL-shaped credentials a
 * deployment holds.
 *
 * Only the userinfo is masked, so the result is still
 * `postgresql://[redacted]@ep-cool-name-pooler.us-east-2.aws.neon.tech/neondb`.
 * The host is the half of a connection failure you actually need — "which
 * database refused us" is the question being asked — and it is not a secret.
 * Blanking the whole URL removes the password and the answer together, and an
 * error nobody can act on gets logged at a lower level the next time somebody
 * touches that file.
 */
const CONNECTION_STRING =
  /\b(postgres(?:ql)?|rediss?|mysql|mongodb(?:\+srv)?|amqps?):\/\/[^\s/@]+@/gi;

/**
 * Mask anything that LOOKS like a credential, wherever it appears.
 *
 * The complement of `REDACT_PATHS`, not a replacement for it. Paths catch
 * values whose location is known — a header, a named property. This catches
 * values whose location is not: a Postgres URL interpolated into an
 * `Error.message`, a webhook secret echoed back inside a provider's own error
 * body, an API key a caller typed into a free-text `reason` field.
 *
 * Value-shaped, deliberately. It does not inspect property names, because
 * `{ password: "hunter2" }` is already the path list's job, and a function
 * doing both would blur which mechanism is responsible the next time a leak is
 * found.
 *
 * Pure: never mutates its argument, and returns a fresh structure for anything
 * it walks into.
 */
export function redactValue(value: unknown): unknown {
  return walk(value, new Set<object>());
}

function walk(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") return redactString(value);
  // Functions land here too and pass through untouched; pino drops them.
  if (value === null || typeof value !== "object") return value;

  // Tracks the ANCESTOR PATH, not every object ever seen. A set that only grew
  // would report the second reference to a shared object — the same tenant
  // hung off three entities — as a cycle, deleting real data from the log to
  // fix a problem that was not there.
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, ancestors));

    // An Error's own `message` and `stack` are non-enumerable, so the generic
    // walk below returns `{}` for one — discarding the whole error in order to
    // redact a credential that was probably never in it. Rebuilt explicitly.
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack === undefined ? undefined : redactString(value.stack),
      };
    }

    // Dates, Maps, Sets, Buffers and promises have no enumerable own
    // properties worth walking: `Object.entries` on a Date returns `[]`, which
    // would turn a timestamp into `{}`.
    if (isOpaque(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = walk(nested, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Promise ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function redactString(value: string): string {
  let out = value.replace(
    AUTH_SCHEME,
    (_match: string, scheme: string) => `${scheme} ${REDACTED}`,
  );
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED);
  // Last, so it works on whatever the rules above left behind.
  return out.replace(
    CONNECTION_STRING,
    (_match: string, scheme: string) => `${scheme}://${REDACTED}@`,
  );
}
