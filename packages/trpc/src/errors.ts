import { TRPCError } from "@trpc/server";

/**
 * The shape of `PermissionDeniedError` from `@adminigloo/permissions`, matched
 * structurally rather than with `instanceof`.
 *
 * `instanceof` is wrong here specifically. pnpm resolves a peer-dependency
 * mismatch by installing a second physical copy of a package, so an app can
 * easily end up with the copy of `@adminigloo/permissions` that threw the error
 * and the copy this package imported being two different modules with two
 * different class objects. `instanceof` is false across them, the 403 quietly
 * degrades into a 500, and it only reproduces on the machine with the duplicate
 * install. Every error class in this codebase declares `readonly name` as an
 * own property for exactly this reason: the name survives module duplication
 * and CJS/ESM interop, where the class identity does not.
 *
 * The `permission` check is not belt and braces. Matching on the name alone
 * would map any error someone happened to name that way onto a 403 reading
 * `Permission denied: undefined`, which looks like a real answer and is
 * therefore worse than the 500 it replaced.
 */
export interface PermissionDeniedLike extends Error {
  readonly permission: string;
}

export function isPermissionDenied(
  cause: unknown,
): cause is PermissionDeniedLike {
  return (
    cause instanceof Error &&
    cause.name === "PermissionDeniedError" &&
    "permission" in cause &&
    typeof cause.permission === "string"
  );
}

/**
 * The one FORBIDDEN this package throws.
 *
 * The message names the permission because the alternative — a bare
 * "Forbidden" — turns every support ticket into a debugging session. It is safe
 * to leak: permission keys are declared in code and shipped to the client
 * already, so the caller learns nothing about the tenant from seeing one.
 */
export function permissionDenied(permission: string): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: `Permission denied: ${permission}`,
  });
}

/**
 * Map a thrown `PermissionDeniedError` onto the same FORBIDDEN the middleware
 * throws, or `undefined` when the cause is something else.
 *
 * `requirePermission` is transport-agnostic by design, so a handler that calls
 * it deep inside a service function throws a plain Error as far as tRPC is
 * concerned, and `getTRPCErrorFromUnknown` turns anything it does not
 * recognise into INTERNAL_SERVER_ERROR. Without this mapping the same denial
 * is a 403 when the middleware catches it and a 500 when a service function
 * does — the client retries the 500, pages someone, and the user is told the
 * app is broken rather than that they lack access.
 *
 * Returns `undefined` rather than throwing so a caller can fall through to its
 * own handling; the alternative is a catch block that has to rethrow to say
 * "not mine", which is easy to get wrong under `noImplicitReturns`.
 */
export function permissionDeniedToTRPCError(
  cause: unknown,
): TRPCError | undefined {
  if (!isPermissionDenied(cause)) return undefined;
  return new TRPCError({
    code: "FORBIDDEN",
    message: `Permission denied: ${cause.permission}`,
    cause,
  });
}

/**
 * The caller is signed in but has no membership in the tenant they named.
 *
 * FORBIDDEN, not NOT_FOUND: hiding the tenant's existence would be the more
 * cautious choice, but every route here already takes the tenant id as input
 * from a caller who typed it, so there is nothing to leak that they did not
 * already supply. A distinct code is worth more than the pretence.
 */
export function notAMember(tenantId: string): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: `Not a member of tenant ${tenantId}`,
  });
}

/** The caller is signed in but holds no staff role at all. */
export function notStaff(): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: "Staff access required",
  });
}

/**
 * The caller has spent their budget for this window.
 *
 * TOO_MANY_REQUESTS, which tRPC maps to HTTP 429, so an off-the-shelf client
 * with retry logic already knows not to hammer it.
 *
 * The message names the number of seconds rather than a timestamp. tRPC has no
 * mechanism for setting a `Retry-After` header from inside a procedure — the
 * response is one batched envelope that may contain several results — so the
 * only place the client can learn when to come back is the message, and a
 * client that does not know cannot do anything except retry immediately.
 */
export function tooManyRequests(resetAt: Date, now: number = Date.now()): TRPCError {
  const seconds = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000));
  return new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `Rate limit exceeded. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
  });
}
