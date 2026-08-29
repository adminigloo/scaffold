import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/trpc/client";
import { env } from "@/env";

export const metadata: Metadata = {
  title: "__PROJECT_NAME__",
};

/**
 * ClerkProvider is mounted only when Clerk is actually configured.
 *
 * Not a feature flag — a runtime configuration check, and the two are different
 * things. ClerkProvider decodes the publishable key into a frontend API domain
 * and throws when it cannot, so on a laptop with no Clerk account yet EVERY
 * page 500s, including the setup page that would tell you what to do about it.
 * The first thing you would see after generating a project is a stack trace.
 *
 * On a deployment this branch is unreachable: `env.ts` marks the Clerk keys as
 * required once deployed, so a preview build without them fails at boot rather
 * than quietly rendering an app with no authentication.
 */
function AuthProvider({ children }: { children: ReactNode }) {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return <>{children}</>;
  return <ClerkProvider>{children}</ClerkProvider>;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
