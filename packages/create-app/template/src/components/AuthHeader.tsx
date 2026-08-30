import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { env } from "@/env";
import { buttonClass } from "@/components/ui";

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
      <p className="text-sm text-ink-muted">
        Sign-in is off until Clerk is configured &mdash;{" "}
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>
      </p>
    );
  }

  const { userId } = await auth();

  if (!userId) {
    return (
      <Link href="/sign-in" className={buttonClass("secondary")}>
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link href="/admin" className="text-sm text-accent underline underline-offset-2">
        Admin
      </Link>
      <UserButton />
    </div>
  );
}
