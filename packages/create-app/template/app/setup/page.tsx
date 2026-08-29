import { describeEnv } from "__SCOPE__/env";
import { envDescription } from "@/env";

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

  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem 2rem", maxWidth: 860, lineHeight: 1.6 }}>
      <p
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "#6b7280",
          margin: "0 0 12px",
        }}
      >
        __PROJECT_NAME__ &middot; environment: {report.appEnv}
      </p>

      <h1 style={{ fontSize: "1.75rem", margin: "0 0 8px" }}>
        {report.ok ? "Everything is configured" : "Add credentials as you need them"}
      </h1>

      <p style={{ color: "#4b5563", maxWidth: "62ch" }}>
        {report.ok
          ? "Nothing is missing. Delete this page whenever you like — it is copied source."
          : "Nothing here blocks you from building. Add a value to .env.local and restart when you want the feature it unlocks."}
      </p>

      {report.groups.map((group) => (
        <section key={group.name} style={{ marginTop: "2rem" }}>
          <h2
            style={{
              fontSize: "0.6875rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#6b7280",
              margin: "0 0 0.5rem",
            }}
          >
            {group.name}
          </h2>

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {group.vars.map((v) => (
              <li
                key={v.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "18px 1fr",
                  gap: "0.75rem",
                  alignItems: "start",
                  padding: "0.625rem 0",
                  borderBottom: "1px solid #f0f1f3",
                }}
              >
                <span
                  aria-hidden
                  title={v.present ? "set" : "not set"}
                  style={{
                    marginTop: 6,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: v.malformed
                      ? "#a02e21"
                      : v.present
                        ? "#17635a"
                        : "#d1d5db",
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <code style={{ fontSize: "0.8125rem" }}>{v.name}</code>
                  {v.malformed && (
                    <span style={{ color: "#a02e21", fontSize: "0.75rem", marginLeft: 8 }}>
                      set, but not valid
                    </span>
                  )}
                  <div style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
                    {WHAT_IT_UNLOCKS[v.name] ?? ""}
                    {!v.present && WHERE_TO_GET_IT[v.name] && (
                      <>
                        {" "}
                        <span style={{ color: "#9ca3af" }}>
                          &mdash; {WHERE_TO_GET_IT[v.name]}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {report.missingWhenDeployed.length > 0 && (
        <section
          style={{
            marginTop: "2rem",
            borderLeft: "3px solid #7d5a0c",
            padding: "0.25rem 0 0.25rem 1rem",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.875rem", color: "#4b5563", maxWidth: "60ch" }}>
            <strong>These are optional here and required on a deployment.</strong> A
            preview or production build refuses to start without them, which is
            deliberate: a forgotten Vercel variable should fail the build, not
            surface as a broken page.
          </p>
          <p
            style={{
              margin: "0.5rem 0 0",
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.8125rem",
              color: "#6b7280",
            }}
          >
            {report.missingWhenDeployed.join("  ")}
          </p>
        </section>
      )}
    </main>
  );
}
