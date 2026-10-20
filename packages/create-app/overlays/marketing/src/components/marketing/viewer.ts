import { auth } from "@clerk/nextjs/server";
import { env } from "@/env";

/**
 * Is someone signed in? For the landing page's one button: "Go to your
 * dashboard" for them, "Get started" for everyone else. False with sign-in
 * not configured, and false — never an error page — if Clerk can't answer.
 */
export async function isSignedIn(): Promise<boolean> {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return false;
  try {
    return (await auth()).userId !== null;
  } catch {
    return false;
  }
}
