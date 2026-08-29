import "server-only";
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
 */
export async function api() {
  return createCallerFactory(appRouter)(await createContext());
}
