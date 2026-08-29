import type { Principal } from "@adminigloo/auth";
import type { PermissionSet } from "@adminigloo/permissions";
import { meterStream, reportUsage } from "./stream.js";
import type { StreamOutcome, UsageReporter } from "./stream.js";

/**
 * What `resolve` hands back for an authenticated caller.
 *
 * `can` is a resolved `PermissionSet`, the same object `@adminigloo/trpc` puts
 * on a tenant procedure's context — one shape for "what may this request do",
 * whether the entry point is a procedure or a route handler.
 */
export interface StreamRouteAuth {
  readonly principal: Principal;
  readonly can: PermissionSet;
}

/** Everything the handler is allowed to assume, because step 3 already ran. */
export interface StreamRouteContext {
  readonly req: Request;
  readonly principal: Principal;
  readonly can: PermissionSet;
}

export interface CreateStreamRouteOptions<TPermission extends string = string> {
  /** Checked before the handler runs. Never checked again afterwards. */
  readonly permission: TPermission;
  /**
   * Identity and permissions, injected.
   *
   * This package therefore has no database and no identity provider: it never
   * imports Drizzle, never reads a cookie, and cannot be the reason an AI route
   * drags a Postgres client into an edge bundle. The app already knows how to
   * turn a `Request` into a principal — it does so for every other route — and
   * passing that in keeps one implementation of the hard part.
   *
   * Return null for "no principal". Throwing is for "identity is broken", which
   * is a 500, not a 401.
   */
  readonly resolve: (input: {
    readonly req: Request;
  }) => Promise<StreamRouteAuth | null>;
  /** Opens the stream. Owns the response from here on. */
  readonly handler: (ctx: StreamRouteContext) => Promise<Response>;
  /**
   * Called exactly once per AUTHORIZED request, when the stream ends however it
   * ends. The app combines the outcome and latency reported here with the token
   * counts it got from the provider and writes the `ai_usage` row.
   */
  readonly onUsage?: UsageReporter;
  /** Injected so latency assertions do not depend on the wall clock. */
  readonly now?: () => number;
}

/**
 * Build a streaming route handler.
 *
 * THE ORDER IS THE POINT:
 *
 *   1. resolve the principal
 *   2. resolve the permission set
 *   3. check the permission
 *   4. and ONLY THEN call the handler that opens the stream
 *
 * Steps 1-3 are cheap and they all happen before a single byte is written. Once
 * headers are flushed there is no clean way to send a 403: the status line went
 * out as 200 with `text/event-stream` long before the check would have run, the
 * client is already rendering, and the only remaining move is to stop
 * mid-sentence. To the user that is indistinguishable from the model failing;
 * to an auditor there is a 200 in the log for a request that should never have
 * reached the provider. Both are unrecoverable by design, which is why the
 * check cannot live inside the handler alongside the provider call — the usual
 * shape, where authorization is one more line in the same async function and
 * drifts below the first `write` during a refactor nobody flags.
 *
 * After step 4 this function deliberately does nothing to the response except
 * count it. Content type, protocol framing, retry headers, abort handling: all
 * the handler's, because those differ per provider and a wrapper that guesses
 * at them is a wrapper people bypass.
 */
export function createStreamRoute<TPermission extends string = string>(
  options: CreateStreamRouteOptions<TPermission>,
): (req: Request) => Promise<Response> {
  const { permission, resolve, handler, onUsage, now = () => Date.now() } = options;

  return async (req: Request): Promise<Response> => {
    // 1 + 2. Identity and permissions together: the app resolves them in one
    // pass because a route that fetched the principal, opened the stream, and
    // then loaded permissions would have already lost the ability to refuse.
    const auth = await resolve({ req });

    // 3a. No principal at all.
    if (!auth) return authFailure(401, "unauthorized");

    // 3b. A principal without this permission. No usage is recorded on either
    // branch: nothing was spent, and counting refusals as consumption turns a
    // credential-stuffing run into a spike on the spend dashboard.
    if (!auth.can.can(permission)) {
      return authFailure(403, "forbidden", permission);
    }

    // 4. Authorized. From here the handler owns the response.
    const startedAt = now();
    const report = async (outcome: StreamOutcome, error?: unknown): Promise<void> => {
      if (!onUsage) return;
      await reportUsage(onUsage, {
        outcome,
        chunks: 0,
        durationMs: now() - startedAt,
        ...(outcome === "errored" ? { error } : {}),
      });
    };

    let response: Response;
    try {
      response = await handler({ req, principal: auth.principal, can: auth.can });
    } catch (error) {
      // A handler that throws before returning a Response has usually already
      // called the provider, so the tokens are spent even though no stream ever
      // existed. Recording only streamed requests loses exactly the failures
      // worth investigating. Rethrown afterwards: the platform's 500 is
      // correct, and nothing has been flushed, so it is still deliverable.
      await report("errored", error);
      throw error;
    }

    if (!onUsage) return response;

    // A non-streaming response — a cached answer, a 204, an error the handler
    // chose to render itself — still gets exactly one report, so "authorized
    // request" and "usage row" stay one-to-one and a gap in the table means a
    // dropped write rather than a shape nobody thought about.
    if (!response.body) {
      await report("completed");
      return response;
    }

    // Rebuilt rather than mutated: `Response.body` is read-only, and consuming
    // it here is what lets the metered copy see every chunk. Status, statusText
    // and headers are carried across verbatim — this wrapper has no opinion
    // about any of them.
    return new Response(meterStream(response.body, { onUsage, now }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * The two refusals, as JSON.
 *
 * Not `text/event-stream` with an error event in it: a client that has to parse
 * the stream to discover it was denied will render the partial UI first, which
 * is the failure this whole module is ordered to avoid. A refusal must be
 * unmistakable at the status line.
 */
function authFailure(status: 401 | 403, error: string, permission?: string): Response {
  const body = permission === undefined ? { error } : { error, permission };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
