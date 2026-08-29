"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/server/routers/_app";

/**
 * The typed client. `api.members.list.useQuery(...)` is checked against the
 * router on the server, so renaming a procedure breaks the build rather than
 * the page.
 */
export const api = createTRPCReact<AppRouter>();

/**
 * Wraps the app once, in the root layout.
 *
 * Both clients are created inside `useState` initialisers rather than at module
 * scope. A module-level QueryClient is shared by every request the server
 * handles, so one user's cached data can be rendered for the next — the kind of
 * leak that only shows up under concurrent traffic.
 */
export function TRPCProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Long enough that a client-side navigation does not refetch what
            // the server just rendered.
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Never retry an authorization failure. The answer will not
              // change, and retrying turns one 403 into four in the log.
              const code = (error as { data?: { code?: string } })?.data?.code;
              if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          // superjson, matching the server. Without it a Date arrives as a
          // string and a bigint throws on serialisation — and money in this
          // scaffold is bigint minor units.
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </api.Provider>
  );
}
