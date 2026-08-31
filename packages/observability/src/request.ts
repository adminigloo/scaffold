/**
 * The identifier that ties one row in `/admin/errors` to the log lines that
 * were written around it.
 *
 * Without it the error viewer is a list of messages with no way back into the
 * logs. You know a `TypeError` fired 40,000 times; you cannot find the request
 * that caused any one of them, because the aggregator holds a million lines
 * for the same minute and nothing in the row narrows them down. Stamping one
 * id on every line of a request AND on the error row turns "which request was
 * this" from an afternoon into a single search.
 *
 * An INBOUND `x-request-id` is preferred over a fresh one, and that is the
 * half people skip. Vercel, Cloudflare and every load balancer in front of an
 * app already mint one; generating our own regardless means the platform's
 * trace and the application's logs carry different ids for the same request
 * and cannot be joined at all — which is precisely the situation this exists
 * to prevent, reintroduced one layer down.
 *
 * IMPORTS NOTHING, and that is a load-bearing property rather than a small
 * module's good luck. This file is the one part of the package a root proxy
 * or an edge route handler needs, and those runtimes have no `node:crypto`,
 * no `pino` and no filesystem. Reached through the barrel it would drag the
 * logger in behind it and the build would fail before the first request; so
 * it is published on its own as `@adminigloo/observability/request`, and
 * `edge-safety.test.ts` holds it to having no import statements at all.
 *
 * That subpath exists so that an application does NOT have to keep a second,
 * dependency-free copy of these three things beside its proxy. It kept one,
 * and the copy drifted exactly where it mattered: it never validated the
 * inbound header, so an attacker-supplied newline went straight into the id
 * that every log line for that request would carry.
 */

/** Lower case, because Node lower-cases inbound header names. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The part of a `Headers` object read here.
 *
 * Structural rather than the DOM/undici `Headers` type: this package compiles
 * with `lib: ["ES2022"]` and no DOM, the edge and Node runtimes disagree about
 * which `Headers` is in scope, and a plain object with a `get` method is a
 * perfectly good test double.
 */
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

/**
 * Long enough for a UUID, a Cloudflare ray id or an OpenTelemetry trace id;
 * short enough that a header cannot be used to write a megabyte into every
 * line of the log.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * The inbound value is attacker-controlled and gets copied into every log
 * line, so it is validated rather than trusted.
 *
 * A newline in a request id is a log injection: with line-delimited JSON,
 * `{"requestId":"a\n{\"level\":\"info\",\"msg\":\"payment captured\"}"}` is two
 * records to the aggregator and the second one is whatever the caller wanted
 * it to say. Restricting to the characters real ids actually use is cheaper
 * than escaping, and an id that fails the test is replaced rather than
 * rejected — refusing the request would let a malformed header from an
 * upstream proxy take the whole route down.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]+$/;

function readHeader(
  headers: HeaderSource | null | undefined,
  name: string,
): string | null {
  if (headers === null || headers === undefined) return null;
  const value = headers.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The id for this request: the inbound one when it is usable, a fresh UUID
 * otherwise.
 *
 * Always returns a string. There is no "no request id" state to handle at a
 * call site, because a nullable request id is a request id that half the log
 * lines omit, and a correlation key present on half the lines correlates
 * nothing.
 */
export function resolveRequestId(headers?: HeaderSource | null): string {
  const inbound = readHeader(headers, REQUEST_ID_HEADER);
  if (
    inbound !== null &&
    inbound.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID.test(inbound)
  ) {
    return inbound;
  }
  return mintRequestId();
}

/**
 * A fresh id, from the Web Crypto global rather than `node:crypto`.
 *
 * `globalThis.crypto` is a standard global in every runtime this package is
 * allowed to run in — Node since 19, and every edge and worker runtime by
 * definition — whereas importing `node:crypto` would make this module
 * unbundlable for the proxy that is its single most important caller. The
 * value is only ever a correlation key, so the distinction between the two
 * generators is one of availability and nothing else.
 */
function mintRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The client's address as the platform's proxy saw it.
 *
 * The LEFTMOST entry of `x-forwarded-for`, which is only trustworthy behind a
 * proxy that appends to the header — every platform this scaffold deploys to
 * does. Exposed to the public internet with nothing in front, the whole header
 * is caller-supplied and anyone rate-limited by it simply sends a different
 * value; a deployment in that shape must key off the socket address instead.
 * Written down here because the difference is invisible at the call site and
 * the failure is a limiter that reports itself working.
 *
 * Returns null rather than a placeholder when nothing identifies the caller.
 * A shared `"unknown"` bucket would put every unattributable request into one
 * counter, and on a laptop — where no proxy sets the header — that is a
 * developer rate-limiting themselves out of their own dev server within a
 * minute of starting it.
 */
export function clientIpFromHeaders(
  headers?: HeaderSource | null,
): string | null {
  const forwarded = readHeader(headers, "x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return readHeader(headers, "x-real-ip");
}
