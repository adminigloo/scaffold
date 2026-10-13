import { redirect } from "next/navigation";
import { SignOutNow } from "@/components/SignOutNow";
import { safeReturnPath } from "@/redirect";
import { isSignInConfigured } from "@/server/auth";

/**
 * Sign out, then go somewhere on this site.
 *
 * WHY A PAGE. Clerk signs out from the browser (`useClerk().signOut`), and the
 * one place in the app that needs a plain LINK that signs you out is the
 * invitation screen: someone signed in with the wrong address is told which
 * address the invitation was sent to, and "sign out and sign in with that one"
 * has to be something they can press, not an instruction (review T1-07). The
 * header's account menu signs out too, but it can't come back to the
 * invitation afterwards; this can.
 *
 * `redirect_url` goes through `safeReturnPath`, so this can't be turned into a
 * bounce to another site.
 */
export const dynamic = "force-dynamic";

export default async function SignOutPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly redirect_url?: string | string[] }>;
}) {
  const back = safeReturnPath((await searchParams).redirect_url) ?? "/";
  // No Clerk, nobody to sign out — and no ClerkProvider for the hook to read.
  if (!isSignInConfigured()) redirect(back);
  return (
    <main className="grid min-h-[50vh] place-items-center px-6 py-12">
      <SignOutNow redirectUrl={back} />
    </main>
  );
}
