import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/trpc/client";
import { env } from "@/env";
import "./globals.css";

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
    // `suppressHydrationWarning` on <html> only: the dark theme is pure CSS
    // (prefers-color-scheme), so nothing here reads the theme at runtime — but
    // browser extensions routinely stamp attributes on <html> before React
    // hydrates, and the resulting warning trains people to ignore the console.
    <html lang="en" suppressHydrationWarning>
      {/* Explicit background, from a token. A transparent body borrows whatever
          the browser paints, which in dark mode is white behind a dark page —
          visible as a flash on navigation and as white gutters on short pages,
          neither of which points at its own cause. */}
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <AuthProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
