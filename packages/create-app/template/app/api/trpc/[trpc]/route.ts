import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { after } from "next/server";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/trpc";
import { reportError } from "@/server/error-reporter";
import { requestLog } from "@/server/logger";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // A fresh context per request, built from THIS request's headers. The
    // permission cache inside it is what makes one router calling another
    // cheap; sharing it across requests would hand one user's authorization to
    // the next. The headers are what carry the request id and the client
    // address in — without them the context invents an id nothing else has
    // seen and reports no IP, which leaves every anonymous procedure
    // unlimited.
    createContext: ({ req: request }) => createContext({ headers: request.headers }),

    /**
     * The only place a failed procedure becomes a record.
     *
     * Without it tRPC answers the caller with a 500 and the error exists
     * nowhere else: the browser shows a toast, the server prints a line that
     * scrolls away, and the admin panel's Errors page stays empty while the API
     * is failing.
     *
     * INTERNAL_SERVER_ERROR ONLY. Every other code is the API working as
     * designed — BAD_REQUEST is a Zod rejection, FORBIDDEN is the permission
     * ladder doing its job, TOO_MANY_REQUESTS is the rate limiter doing its
     * job, NOT_FOUND is a missing row. Recording those would bury the handful
     * of genuine faults under a table of correct refusals, and the count that
     * decides what gets fixed first would stop meaning anything.
     *
     * `error.cause` in preference to the TRPCError. The wrapper's stack is tRPC
     * internals and its name is the same on every row; the cause is the actual
     * throw, with the file and line that produced it, which is what the
     * fingerprint needs to tell two bugs apart.
     *
     * THE LOG LINE AND THE ROW CARRY THE SAME ID, taken from the context the
     * middleware ran under rather than re-derived. That is the join: the row on
     * /admin/errors names a request id, and searching the aggregator for it
     * returns every line this request wrote on its way to failing. `ctx` is
     * optional here — a context that threw never produced one — so the header
     * is the fallback, which resolves to the value `proxy.ts` stamped.
     */
    onError({ error, path, type, ctx }) {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      const requestId = ctx?.requestId ?? resolveRequestId(req.headers);

      requestLog(requestId).error(
        { err: error.cause ?? error, path: path ?? null, type },
        "procedure failed",
      );

      // `after`, not a bare floating promise. On a serverless platform the
      // invocation can be frozen the instant the response is written, and work
      // that was merely started is work that silently never happened — so the
      // reports would go missing exactly where they are hardest to notice.
      after(
        reportError({
          error: error.cause ?? error,
          source: "trpc",
          url: req.url,
          userId: ctx?.principal?.userId ?? null,
          tenantId: ctx?.tenantId ?? null,
          requestId,
          context: { path: path ?? null, type },
        }),
      );
    },
  });

export { handler as GET, handler as POST };
