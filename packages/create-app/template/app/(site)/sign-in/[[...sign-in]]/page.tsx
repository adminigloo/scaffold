import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { env } from "@/env";
import { safeReturnPath } from "@/redirect";
import { Card, CardBody, PageHeader } from "@/components/ui";

/**
 * Clerk's hosted sign-in, mounted as a catch-all.
 *
 * The `[[...sign-in]]` segment is required, not decorative: Clerk routes its own
 * multi-step flows (verification, factor two, reset) as sub-paths of this one.
 * A plain `sign-in/page.tsx` renders the first screen and 404s the moment
 * anybody needs a second step.
 *
 * `?redirect_url=` is honoured, and it is not decoration.
 *
 * An invitation link lands on /invite/[token] and sends whoever holds it here
 * to get an account. Without a return path Clerk drops them on the landing page
 * afterwards, the tab carrying the token is gone, and the only copy of the
 * invitation went with it — the invitee is then stuck in the one place nobody
 * can help them from, because the sender cannot re-send a link the database
 * only ever stored a hash of.
 *
 * `forceRedirectUrl` rather than a redirect written by hand after the fact:
 * sign-in is a multi-step flow — verify the address, add a second factor,
 * discover the account already exists — and each step is a separate navigation
 * that would lose a value this page was holding. `signUpUrl` carries it too, so
 * the "create one" link inside Clerk's own card does not drop it.
 *
 * The value goes through `safeReturnPath`, which refuses anything that could
 * leave the site. An unchecked one is an open redirect straight into a copy of
 * this page asking for the password again.
 */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly redirect_url?: string | string[] }>;
}) {
  const back = safeReturnPath((await searchParams).redirect_url);

  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-lg items-center px-6 py-12">
        <div className="w-full">
          <PageHeader
            title="Sign-in is not configured yet"
            description="Clerk holds the identities; without its keys there is nothing to sign in to."
          />
          <Card>
            <CardBody className="text-sm text-ink-muted">
              Add <Key>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</Key> and{" "}
              <Key>CLERK_SECRET_KEY</Key> to <Key>.env.local</Key>, then restart.{" "}
              <Link href="/setup" className="text-accent underline underline-offset-2">
                /setup
              </Link>{" "}
              lists what is missing and where to get it.
            </CardBody>
          </Card>
        </div>
      </main>
    );
  }

  // Clerk renders its own card here, styled by Clerk. Deliberately left alone:
  // matching it to the theme means pinning its internal class names, and those
  // change between Clerk releases without a major version. The page around it
  // carries the theme instead.
  //
  // A fraction of the viewport rather than `min-h-dvh`, and no background of
  // its own: this page sits inside `app/(site)/layout.tsx` now, so a full-height
  // main pushes the footer off every screen and paints over the header's rule.
  return (
    <main className="grid min-h-[70vh] place-items-center px-6 py-12">
      <SignIn
        forceRedirectUrl={back ?? undefined}
        signUpUrl={
          back === null ? undefined : `/sign-up?redirect_url=${encodeURIComponent(back)}`
        }
      />
    </main>
  );
}

function Key({ children }: { children: string }) {
  return (
    <code className="rounded-[3px] bg-accent-soft px-1 py-px font-mono text-xs text-accent">
      {children}
    </code>
  );
}
