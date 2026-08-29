import { SignIn } from "@clerk/nextjs";
import { env } from "@/env";

/**
 * Clerk's hosted sign-in, mounted as a catch-all.
 *
 * The `[[...sign-in]]` segment is required, not decorative: Clerk routes its own
 * multi-step flows (verification, factor two, reset) as sub-paths of this one.
 * A plain `sign-in/page.tsx` renders the first screen and 404s the moment
 * anybody needs a second step.
 */
export default function SignInPage() {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "3rem", lineHeight: 1.6 }}>
        <h1 style={{ fontSize: "1.25rem" }}>Sign-in is not configured yet</h1>
        <p style={{ color: "#4b5563", maxWidth: "58ch" }}>
          Add <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and{" "}
          <code>CLERK_SECRET_KEY</code> to <code>.env.local</code>, then restart.
          See <a href="/setup">/setup</a>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <SignIn />
    </main>
  );
}
