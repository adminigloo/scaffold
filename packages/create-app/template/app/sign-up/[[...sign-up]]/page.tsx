import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { env } from "@/env";
import { Card, CardBody, PageHeader } from "@/components/ui";

/**
 * Clerk's hosted sign-up, mounted as a catch-all.
 *
 * The `[[...sign-up]]` segment is required, not decorative: Clerk routes its own
 * multi-step flows (verification, factor two, reset) as sub-paths of this one.
 * A plain `sign-up/page.tsx` renders the first screen and 404s the moment
 * anybody needs a second step.
 */
export default function SignUpPage() {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg items-center px-6 py-12">
        <div className="w-full">
          <PageHeader
            title="Sign-up is not configured yet"
            description="Clerk holds the identities; without its keys there is no account to create."
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
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-6 py-12">
      <SignUp />
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
