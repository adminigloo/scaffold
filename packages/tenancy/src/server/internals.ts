import type { Ctx } from "./context.js";

/**
 * The service's own context, kept OFF its public surface: the route seams
 * (`createCompanyRouteSeams`) resolve a caller's permissions through the same
 * loaders and membership gate the service uses, in one pass, without adding a
 * method every host would see and could misuse (a "loaders" handle on the
 * service would let any caller read any company's grants).
 *
 * A WeakMap, so a service that's dropped takes its context with it. A host
 * that hands the seams something that ISN'T the service object (a spread copy,
 * a wrapper) still works: the seams fall back to the service's public
 * `membership` and `hasPermission` (one more query per permission asked).
 */
const INTERNALS = new WeakMap<object, Ctx>();

export function rememberCtx(service: object, ctx: Ctx): void {
  INTERNALS.set(service, ctx);
}

export function ctxOf(service: object): Ctx | undefined {
  return INTERNALS.get(service);
}
