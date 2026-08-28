import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/trpc";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // A fresh context per request. The permission cache inside it is what makes
    // one router calling another cheap; sharing it across requests would hand
    // one user's authorization to the next.
    createContext,
  });

export { handler as GET, handler as POST };
