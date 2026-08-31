import "server-only";
import { headers } from "next/headers";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createContext } from "@/server/trpc";

/**
 * Call the API from a server component, with no HTTP round trip.
 *
 * The caller runs the full middleware chain, so a server component is
 * authorized exactly like a browser request — the same rung, the same
 * permission set, the same audit. Skipping tRPC and querying the database
 * directly from a page is how a surface ends up unprotected.
 *
 *   const { granted } = await (await api()).members.list({ tenantId });
 *
 * THE REQUEST'S OWN HEADERS GO IN. Without them the context mints a fresh
 * request id, so a page and the procedure that page called would log under two
 * different ids and neither would match the one `proxy.ts` echoed back to the
 * browser — the join would be broken on the single most common path in the
 * app. Reading `headers()` also opts the caller into dynamic rendering, which
 * is already true of every page that asks who the user is.
 */
export async function api() {
  return createCallerFactory(appRouter)(
    await createContext({ headers: await headers() }),
  );
}
