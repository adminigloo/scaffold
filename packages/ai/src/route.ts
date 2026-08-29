import type { Principal } from "@adminigloo/auth";
import type { PermissionSet } from "@adminigloo/permissions";
import { meterStream, reportUsage } from "./stream.js";
import type { StreamOutcome, UsageReporter } from "./stream.js";

/**
 * A permission set and the tenant it was resolved FOR, as one value.
 *
 * They are inseparable because they are only meaningful together. A
 * `PermissionSet` is not "what this user may do", it is "what this user may do
 * IN ONE TENANT" — `@adminigloo/trpc` resolves it as
 * `loadTenantPermissions({ principal, tenantId })` and there is no other kind.
 * Handed around on its own it loses the half that says which rows it applies
 * to, and a handler holding it will happily authorize a read of whatever
 * tenant id it finds in the request body. That is the cross-tenant read
 * `tenantProcedure` exists to prevent, and it survives review, because the
 * check passes: the grants are real, they just belong to a different
 * organisation.
 *
 * Nesting rather than flattening `tenantId` and `can` onto the context is the
 * mechanism, not decoration: `ctx.scope.can` cannot be written without naming
 * the scope it came from, so a mismatch has to be typed out deliberately
 * instead of arrived at by autocomplete.
 */
export interface StreamRouteScope {
  /** The tenant `can` was resolved against. Never empty; see the guard below. */
  readonly tenantId: string;
  readonly can: PermissionSet;
}

/**
 * What `resolve` hands back for an authenticated caller.
 *
 * `scope` is null when the principal is real but is NOT A MEMBER of the tenant
 * this request named, mirroring `loadTenantPermissions` returning null in
 * `@adminigloo/trpc`. The distinction is load-bearing in exactly the same way:
 * the obvious implementation, `createPermissionSet(grantsByTenant[tenantId] ??
 * [])`, hands back an EMPTY SET for a tenant the caller has nothing to do
 * with, and an empty set is indistinguishable from "a member who holds no
 * grants yet". The request is then treated as coming from inside the tenant,
 * and any permission granted by default lets it through. Returning null puts
 * the difference in the type, where it cannot be forgotten.
 */
export interface StreamRouteAuth {
  readonly principal: Principal;
  readonly scope: StreamRouteScope | null;
}

/** Everything the handler is allowed to assume, because step 3 already ran. */
export interface StreamRouteContext {
  readonly req: Request;
  readonly principal: Principal;
  /**
   * The tenant, and the grants held in it, from one resolution.
   *
   * The handler must take the tenant it queries from HERE, not from the URL, a
   * header or the request body. Those are the caller's to set; this one is the
   * tenant `can` was resolved against, and the two disagreeing is precisely the
   * cross-tenant read this package is ordered to make impossible.
   */
  readonly scope: StreamRouteScope;
}

/**
 * A `resolve` that reported a scope with a blank tenant id.
 *
 * A 500, not a 403. An empty string is falsy, so it flows into
 * `WHERE tenant_id = ''` or past an `if (tenantId)` into a default-tenant
 * fallback, and the request proceeds against no tenant in particular while
 * still holding a real permission set. That is a bug in the app's resolver — a
 * header that was missing, a claim that was absent — and answering 403 would
 * present it to the user as an access problem they can do nothing about while
 * hiding it from the error tracker.
 */
export class InvalidStreamScopeError extends Error {
  readonly name = "InvalidStreamScopeError";
  constructor() {
    super(
      "resolve() returned a scope with an empty tenantId. Return null for a " +
        "caller who is not a member of the tenant: an empty tenant id is " +
        "falsy, so it reaches `WHERE tenant_id = ''` and default-tenant " +
        "fallbacks while the request still carries real grants.",
    );
  }
}

export interface CreateStreamRouteOptions<TPermission extends string = string> {
  /** Checked before the handler runs. Never checked again afterwards. */
  readonly permission: TPermission;
  /**
   * Identity, tenant and permissions, injected.
   *
   * This package therefore has no database and no identity provider: it never
   * imports Drizzle, never reads a cookie, and cannot be the reason an AI route
   * drags a Postgres client into an edge bundle. The app already knows how to
   * turn a `Request` into a principal and a tenant — it does so for every other
   * route — and passing that in keeps one implementation of the hard part.
   *
   * Return null for "no principal", and `{ principal, scope: null }` for "a
   * principal who is not a member of this tenant". Those are a 401 and a 403
   * and they are not the same event. Throwing is for "identity is broken",
   * which is a 500, not either of them.
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
 *   2. resolve the permission set, FOR ONE NAMED TENANT
 *   3. check membership, then the permission
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
    // 1 + 2. Identity, tenant and permissions together: the app resolves them
    // in one pass because a route that fetched the principal, opened the
    // stream, and then loaded permissions would have already lost the ability
    // to refuse.
    const auth = await resolve({ req });

    // 3a. No principal at all.
    if (!auth) return authFailure(401, { error: "unauthorized" });

    // 3b. A principal who is not a member of the tenant. Refused here, before
    // any permission is consulted. An empty permission set would produce the
    // same status for this one request, but it would also mean a non-member
    // reaches a handler as soon as anyone adds a permission this route does not
    // check — membership is a separate gate from what membership lets you do.
    const { scope } = auth;
    if (scope === null) {
      return authFailure(403, { error: "forbidden", reason: "not_a_member" });
    }

    // A blank tenant id is a broken resolver, not a refusal. Raised before the
    // permission check so it cannot be masked by a denial on a request that was
    // unservable either way.
    if (scope.tenantId === "") throw new InvalidStreamScopeError();

    // 3c. A member without this permission. No usage is recorded on any of
    // these branches: nothing was spent, and counting refusals as consumption
    // turns a credential-stuffing run into a spike on the spend dashboard.
    if (!scope.can.can(permission)) {
      return authFailure(403, { error: "forbidden", permission });
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
      // The scope goes through as the object `resolve` built, not as a tenant
      // id copied out beside a permission set copied out. Two loose values are
      // two things a later edit can let drift apart, which is the whole failure
      // being designed out here.
      response = await handler({ req, principal: auth.principal, scope });
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
    //
    // `startedAt` is the authorization boundary, not the first byte: the wait
    // before a provider emits anything is most of what a slow request feels
    // like, and a latency column that starts at the first chunk reports those
    // as fast.
    return new Response(meterStream(response.body, { onUsage, now, startedAt }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * The refusals, as JSON.
 *
 * Not `text/event-stream` with an error event in it: a client that has to parse
 * the stream to discover it was denied will render the partial UI first, which
 * is the failure this whole module is ordered to avoid. A refusal must be
 * unmistakable at the status line.
 *
 * The two 403s stay distinguishable in the body. "Not a member" and "member
 * missing a permission" have different fixes — one is an invitation, the other
 * is a role change — and collapsing them means every such ticket opens by
 * asking which one it was.
 */
type AuthFailureBody =
  | { readonly error: "unauthorized" }
  | { readonly error: "forbidden"; readonly reason: "not_a_member" }
  | { readonly error: "forbidden"; readonly permission: string };

function authFailure(status: 401 | 403, body: AuthFailureBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
