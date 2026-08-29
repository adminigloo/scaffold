import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { env } from "@/env";

/**
 * Sign in / out, and a way into the admin panel.
 *
 * A SERVER component reading `auth()`, deliberately. Clerk Core 3 (@clerk/nextjs
 * v7) removed the `<SignedIn>` / `<SignedOut>` control components that every
 * older example still uses — they throw at render, not at build, so the code
 * looks correct until the page 500s.
 *
 * Renders nothing interactive when Clerk is unconfigured: `auth()` throws
 * without keys, and the root layout mounts no ClerkProvider for `<UserButton>`
 * to read from.
 */
export async function AuthHeader() {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) {
    return (
      <p style={{ fontSize: "0.875rem", color: "#6b7280", margin: 0 }}>
        Sign-in is off until Clerk is configured — see <Link href="/setup">/setup</Link>.
      </p>
    );
  }

  const { userId } = await auth();

  if (!userId) {
    return (
      <Link
        href="/sign-in"
        style={{
          display: "inline-block",
          padding: "0.4rem 0.9rem",
          border: "1px solid #d1d5db",
          borderRadius: 4,
          textDecoration: "none",
          fontSize: "0.875rem",
          color: "#111827",
        }}
      >
        Sign in
      </Link>
    );
  }

  return (
    <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
      <Link href="/admin" style={{ fontSize: "0.875rem" }}>
        Admin
      </Link>
      <UserButton />
    </div>
  );
}
