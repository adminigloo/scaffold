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
  // Optional in every project, and the copy has to say what actually changes
  // rather than implying the feature is off. Errors are recorded either way;
  // rate limits are enforced either way. What changes is where.
  SENTRY_DSN:
    "Forwarding to Sentry. Errors are recorded in error_log and listed under Admin either way.",
  UPSTASH_REDIS_REST_URL:
    "Rate limits shared between instances. Without it each process counts alone, so a fleet allows N times the limit.",
  UPSTASH_REDIS_REST_TOKEN: "The other half of the shared rate-limit store.",
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
  SENTRY_DSN: "sentry.io → your project → Settings → Client Keys (DSN)",
  UPSTASH_REDIS_REST_URL:
    "console.upstash.com → your database → REST API → the https:// url, not the redis:// one",
  UPSTASH_REDIS_REST_TOKEN: "console.upstash.com → the same panel → REST token",
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
      {/* The project name is in the site header now. What this page adds is
          which environment the report below is describing — the same report
          reads differently on a laptop and on a deployment. */}
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        environment: {report.appEnv}
      </p>

      {/* WHEN NOTHING NAMED THE ENVIRONMENT. `report.appEnv` alone cannot say
          this: "staging" reads as a fact, and on a host that is not Vercel it
          may be a guess — the one made when there is no VERCEL_ENV and no
          APP_ENV. The guess is deliberately the cautious one, and every
          consequence of it is a thing somebody will otherwise report as a bug:
          the simulated checkout is off, the automatic first-admin grant is off,
          and the credentials below stay optional rather than being enforced.
          One variable turns all of that into a decision instead of a default. */}
      {report.origin === "unidentified" && (
        <Notice tone="info" title="Nothing on this host says which environment it is">
          There is no <code className="font-mono">VERCEL_ENV</code> and no{" "}
          <code className="font-mono">APP_ENV</code>, so this is being treated as
          an unnamed deployment: cautious about anything dangerous, and lenient
          about anything missing. Set{" "}
          <code className="font-mono">APP_ENV</code> to{" "}
          <code className="font-mono">local</code>,{" "}
          <code className="font-mono">staging</code> or{" "}
          <code className="font-mono">production</code> in this deployment&rsquo;s
          own configuration. Until you do, the credentials below stay optional
          rather than being required, the first person to sign in is not made an
          administrator, live Stripe and Clerk keys are refused, and the
          simulated checkout is unavailable.
        </Notice>
      )}

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
