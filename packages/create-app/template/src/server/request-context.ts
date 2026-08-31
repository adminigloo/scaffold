import { clientIpFromHeaders } from "__SCOPE__/observability/request";

/**
 * Where a request came from, or nulls.
 *
 * `headers()` only answers inside a request scope. A seed script, a cron
 * handler or a test that drives a router through `createCallerFactory` has no
 * request at all, and losing the whole write over an IP address the audit row
 * is allowed to leave null would be the wrong trade — an audit log that refuses
 * entries it cannot fully describe is an audit log with holes in exactly the
 * places nobody was watching.
 *
 * `next/headers` is imported INSIDE the function rather than at the top of the
 * file, so importing a router does not import Next's server runtime. Otherwise
 * a unit test that builds a caller to check one permission has to boot the
 * framework first.
 *
 * It lives in its own module because two routers now need it. The copy that
 * gets forked is the one that stops trimming the proxy chain, and then two
 * halves of the audit log record different things under the same column name.
 *
 * The address itself comes from `clientIpFromHeaders`, which is the same
 * function `createScaffoldContext` keys anonymous rate limits by. This module
 * had its own copy of the `x-forwarded-for` split, which is how an audit row
 * and a rate-limit bucket end up naming two different callers for one request
 * — and it did not fall back to `x-real-ip`, so behind a proxy that sets only
 * that header every audit row recorded a null address.
 */
export interface RequestOrigin {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export async function requestContext(): Promise<RequestOrigin> {
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    // Left-most entry of `x-forwarded-for`, then `x-real-ip`. Spoofable by a
    // direct caller, which is why it is evidence and not identity — the actor
    // id recorded beside it is the part that was authenticated.
    return {
      ipAddress: clientIpFromHeaders(incoming),
      userAgent: incoming.get("user-agent"),
    };
  } catch {
    return { ipAddress: null, userAgent: null };
  }
}
