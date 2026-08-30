import { describeEnv } from "__SCOPE__/env";
import { envDescription } from "@/env";
import { Card, Notice, PageHeader } from "@/components/ui";

/**
 * What is configured, what is not, and what each missing thing switches off.
 *
 * This page exists because the alternative is a wall of setup instructions in a
 * README that goes stale the first time a package is added. The report is
 * derived from the same schemas the boot validation uses, so it cannot drift
 * from what the app actually requires.
 *
 * It NEVER prints a value — only whether one is present. A setup page that
 * echoes a secret is worse than no setup page, and this one is reachable
 * without signing in, because you cannot sign in until Clerk is configured.
 */
export const dynamic = "force-dynamic";

const WHAT_IT_UNLOCKS: Record<string, string> = {
  DATABASE_URL: "Everything that reads or writes data.",
  DATABASE_URL_UNPOOLED: "Migrations (pnpm db:migrate) and pnpm db:studio.",
  CLERK_SECRET_KEY: "Signing in, and every permission check.",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "The sign-in and sign-up UI.",
  CLERK_WEBHOOK_SIGNING_SECRET:
    "Keeping the local user row in step with Clerk. Not needed on localhost.",
  STRIPE_SECRET_KEY: "Checkout, subscriptions and the webhook ledger.",
  STRIPE_WEBHOOK_SECRET:
    "Verifying Stripe webhooks. Printed by `stripe listen` on its first line.",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "Stripe Elements in the browser.",
  RESEND_API_KEY: "Sending email. Without it, sends are logged as skipped.",
  EMAIL_FROM: "The sender address on outgoing mail.",
  ANTHROPIC_API_KEY: "AI routes.",
};

const WHERE_TO_GET_IT: Record<string, string> = {
  DATABASE_URL: "console.neon.tech → your project → Connection Details → the POOLED string",
  DATABASE_URL_UNPOOLED:
    "console.neon.tech → the same panel → the DIRECT string (no -pooler in the host)",
  CLERK_SECRET_KEY: "dashboard.clerk.com → API keys",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "dashboard.clerk.com → API keys",
  CLERK_WEBHOOK_SIGNING_SECRET: "dashboard.clerk.com → Configure → Webhooks",
  STRIPE_SECRET_KEY: "dashboard.stripe.com → Developers → API keys (Test mode ON)",
  STRIPE_WEBHOOK_SECRET: "run `pnpm dev` — the Stripe CLI prints it",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "dashboard.stripe.com → Developers → API keys",
  RESEND_API_KEY: "resend.com → API Keys",
  EMAIL_FROM: "any address on a domain you have verified in Resend",
  ANTHROPIC_API_KEY: "console.anthropic.com → API keys",
};

export default function SetupPage() {
  const report = describeEnv(envDescription);

  // NOT `report.ok`. That means "valid for the environment you are in", and
  // locally these credentials are deferred — so it is true while nothing is
  // configured, and the page cheerfully reports success on a project that can
  // neither sign anyone in nor reach a database. What a reader actually wants
  // to know is whether anything is still outstanding for a real deployment.
  const outstanding = report.missingWhenDeployed;
  const allSet = outstanding.length === 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        __PROJECT_NAME__ &middot; environment: {report.appEnv}
      </p>

      <PageHeader
        title={allSet ? "Everything is configured" : "Add credentials as you need them"}
        description={
          allSet
            ? "Nothing is outstanding. Delete this page whenever you like — it is copied source."
            : `${outstanding.length} credential${outstanding.length === 1 ? "" : "s"} still to add. None of them blocks you from building — paste one into .env.local and restart when you want the feature it unlocks.`
        }
      />

      <div className="flex flex-col gap-6">
        {report.groups.map((group) => (
          <section key={group.name}>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              {group.name}
            </h2>

            <Card>
              <ul>
                {group.vars.map((v) => (
                  <li
                    key={v.name}
                    className="grid grid-cols-[10px_1fr] items-start gap-x-3 border-b border-line px-4 py-2.5 last:border-0"
                  >
                    {/* Shape as well as colour. A status conveyed only by hue is
                        a status a red-green colour-blind reader cannot read,
                        and this is the page you land on when nothing works. */}
                    <span
                      aria-hidden
                      className={
                        v.malformed
                          ? "mt-2 size-2.5 rotate-45 bg-danger"
                          : v.present
                            ? "mt-2 size-2.5 rounded-full bg-accent"
                            : "mt-2 size-2.5 rounded-full border border-line"
                      }
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <code className="font-mono text-[13px] text-ink">{v.name}</code>
                        <span className="sr-only">
                          {v.malformed ? "set, but not valid" : v.present ? "set" : "not set"}
                        </span>
                        {v.malformed && (
                          <span className="text-xs text-danger">set, but not valid</span>
                        )}
                      </div>
                      <p className="text-[13px] text-ink-muted">
                        {WHAT_IT_UNLOCKS[v.name] ?? ""}
                        {!v.present && WHERE_TO_GET_IT[v.name] && (
                          <> &mdash; {WHERE_TO_GET_IT[v.name]}</>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))}

        {outstanding.length > 0 && (
          <Notice tone="warn" title="Optional here, required on a deployment">
            <p>
              A preview or production build refuses to start without them, which
              is deliberate: a forgotten Vercel variable should fail the build,
              not surface as a broken page.
            </p>
            <p className="mt-2 font-mono text-[13px] break-words">
              {outstanding.join("  ")}
            </p>
          </Notice>
        )}
      </div>
    </main>
  );
}
