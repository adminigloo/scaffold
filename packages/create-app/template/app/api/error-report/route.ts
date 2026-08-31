import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clientIpFromHeaders,
  rateLimitHeaders,
  type RateLimitPolicy,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { reportError } from "@/server/error-reporter";
import { failClosedLimiter } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a React error boundary posts what it caught.
 *
 * This route exists because `error.tsx` and `global-error.tsx` are CLIENT
 * components. They hold the only record that a real person saw a failure, and
 * they cannot write it down — no database handle, no server environment, no
 * server-only import of any kind. With nowhere to post to, a caught render
 * error is a message in one browser's console and nothing else.
 *
 * IT IS AN UNAUTHENTICATED WRITE ENDPOINT, and that is not an oversight: the
 * errors most worth having are the ones on public pages, and on a page whose
 * render has just failed the auth path is one of the things that may have
 * failed. Requiring a session would silently drop exactly the reports that
 * matter. So it is bounded instead, four ways, each of them load-bearing:
 *
 *   1. SAME ORIGIN. A cross-site page cannot make a browser send this. Not
 *      authentication — curl sets any header it likes — but it removes the
 *      drive-by case, which is the one that arrives by the million.
 *   2. RATE LIMITED per client address, and FAIL CLOSED. See below.
 *   3. EVERY FIELD IS BOUNDED. The body is parsed, not trusted: unknown keys
 *      are dropped and every string has a maximum, so nobody can post a
 *      megabyte into a table that is kept for a year.
 *   4. DEDUPLICATED BY FINGERPRINT. Repeats increment a counter rather than
 *      inserting a row, so even an accepted flood cannot push real bugs off
 *      the first page of the admin panel.
 *
 * Nothing here decides anything on the caller's word. The report is recorded
 * with `source: "react"` whatever the body says, and no field reaches anything
 * except the error log.
 */
const ReportBody = z.object({
  /** Which boundary caught it: "global", "site", "admin", "checkout". */
  boundary: z.string().max(32),
  /** Next's error digest, when React produced one. */
  digest: z.string().max(64).optional(),
  name: z.string().max(120).optional(),
  message: z.string().max(500).optional(),
  /** The page that failed, not this endpoint. */
  url: z.string().max(2048).optional(),
});

/**
 * Five a minute is a person hitting reload. Anything above it is not.
 *
 * Written here rather than taken from `RATE_LIMIT_POLICIES` because this is the
 * one budget in the application that is not about protecting a resource: five
 * is what a human being can produce, and the named policies are all an order of
 * magnitude looser than that by design.
 */
const REPORT_POLICY: RateLimitPolicy = { limit: 5, windowMs: 60_000 };

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return new NextResponse(null, { status: 403 });

  // FAIL CLOSED, and the decision is in the limiter rather than in a try/catch
  // here. `failClosedLimiter` is constructed with `onStoreFailure: "deny"`, so
  // a Redis outage refuses instead of quietly becoming no limit at all —
  // behind this endpoint is an unauthenticated write, and an open one during
  // the incident that took the store out is how the error log fills with junk
  // at the moment it is most needed. The cost is real and accepted: reports are
  // lost for as long as the store is down.
  //
  // An over-budget caller and an unreachable store get the same 429, on
  // purpose. Nothing the client could do differs between the two — it retries
  // after the same interval either way — and the difference is in the warning
  // the limiter writes through `log`, which is where an operator looks.
  const verdict = await failClosedLimiter.limit({
    key: `error-report:${clientAddress(req)}`,
    policy: REPORT_POLICY,
  });

  if (!verdict.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: rateLimitHeaders(verdict, REPORT_POLICY),
    });
  }

  const parsed = ReportBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const body = parsed.data;

  await reportError({
    error: clientError(body),
    source: "react",
    digest: body.digest,
    // The page the person was on, which is the only URL worth recording. This
    // endpoint's own URL would be the same string on every row.
    url: body.url,
    // Not resolved, on purpose. Reading the principal means a database round
    // trip per anonymous POST — abuse amplification on the one endpoint that
    // has to stay cheap — and the auth path is a plausible cause of the very
    // error being reported.
    userId: null,
    tenantId: null,
    // This POST's own id, not the failed render's. A browser cannot see the
    // request id of the document it is displaying; `digest` is the join back to
    // the server log line, which is why it is carried separately.
    requestId: resolveRequestId(req.headers),
    context: {
      boundary: body.boundary,
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    },
  });

  // 202: recorded, or deliberately not, and the client has no use for the
  // difference. Nothing in the response says whether the fingerprint was new,
  // which would otherwise make this endpoint a probe of the error log.
  return new NextResponse(null, { status: 202 });
}

/**
 * Did a page of this app make this request?
 *
 * `Origin` against `Host`, rather than against NEXT_PUBLIC_APP_URL. A browser
 * sends `Origin` on every POST including a same-origin one, and comparing the
 * two headers works unchanged on localhost, on 127.0.0.1, and on the preview
 * deployment whose hostname nobody knew in advance.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Whose bucket this counts against.
 *
 * `clientIpFromHeaders` reads the leftmost `x-forwarded-for` entry — the client
 * as the platform's edge saw it, the entries after it being proxies — and falls
 * back to `x-real-ip`. It is the same function the tRPC context keys anonymous
 * procedures by, so one endpoint cannot decide a caller's identity differently
 * from another.
 *
 * Everything unattributable shares one bucket named "unknown", and that is the
 * one place this endpoint departs from the package's advice. `clientIpFromHeaders`
 * returns null rather than a placeholder precisely so a laptop with no proxy
 * does not rate-limit its own developer out of a shared bucket — correct for
 * the procedure ladder, wrong here, because this is an unauthenticated write
 * and "we cannot identify you" must not mean "you are unlimited". Five a minute
 * between all of them is the conservative direction.
 */
function clientAddress(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}

/**
 * The reported failure, as something with a stable fingerprint.
 *
 * THE DIGEST GOES IN `name`, which looks odd until you follow what
 * deduplication does to the alternative. A fingerprint is computed from the
 * name, the NORMALISED message and the stack, and normalising replaces every
 * run of four or more digits with a placeholder — which is exactly the shape of
 * a Next digest. Put it in the message and every digest-bearing report in the
 * application collapses into ONE row. That matters more than it sounds: in
 * production React refuses to send the real message to the browser, and the
 * generic replacement is byte-identical for every server render error there
 * will ever be, so the message carries no identity at all. The name is the one
 * field that reaches the hash unnormalised, so it is where the identity has to
 * live. The digest is repeated in the message for whoever reads the row.
 *
 * NO STACK. The browser's is minified and changes with every deploy, so it
 * would split one bug across builds; a stack synthesised here would point at
 * this file and read identically on every row. An empty one fingerprints on
 * name and message alone, which is the honest identity of a report that never
 * had a server stack in it.
 */
function clientError(body: z.infer<typeof ReportBody>): Error {
  const detail = body.message ?? "Client render error";
  const error = new Error(
    body.digest === undefined ? detail : `${detail} (digest ${body.digest})`,
  );
  error.name =
    body.digest === undefined
      ? (body.name ?? "ClientError")
      : `ClientError(${body.digest})`;
  error.stack = "";
  return error;
}
