import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { BillingSync } from "@/components/admin/BillingSync";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { stripe } from "@/server/stripe";
import { api } from "@/trpc/server";

/**
 * The firm's own view of what it is billing, and the two buttons that repair it.
 *
 * *** WHY A KIT THAT OWNS ITS BILLING TABLES NEEDS THIS AND OTHER KITS DO NOT.
 * *** A product that treats Stripe as the record of what a customer pays can
 * recover from a missed webhook by reading Stripe on the next page load. This
 * firm owns `plans`, `subscriptions` and `entitlements`, so a missed event
 * leaves those tables AUTHORITATIVE AND WRONG, with nothing downstream to
 * reconcile against: the customer is charged and holds nothing, or has
 * cancelled and is still served, and neither is visible from inside the
 * application. The webhook is the mechanism; this screen is the repair, and a
 * firm-owned billing table is not safe to ship without one.
 *
 * TWO DIRECTIONS, TWO BUTTONS, and they are not the same operation.
 *
 *   PUBLISH  pushes the plan record's prices OUT to Stripe, creating the
 *            Product and Price objects a checkout bills against and caching
 *            their ids on the `plans` rows. Nothing else in the scaffold
 *            creates them, which is why a complete plan catalogue used to have
 *            nothing to charge with.
 *   RE-SYNC  pulls every subscription Stripe holds back IN, through the same
 *            `applySubscription` the webhook uses, stamped with the instant of
 *            the read so it wins every ordering contest against a stale event.
 *
 * A SERVER COMPONENT THAT CALLS THE ROUTER through `api()` rather than querying
 * Drizzle. The round trip is skipped, the middleware chain is not, so this page
 * is authorised by exactly the `requireStaff("staff.billing.resync")` rung a
 * browser request goes through — and the scope audit can see it.
 */
export const dynamic = "force-dynamic";

export default async function AdminBillingPage() {
  // FIRST, before anything queries. `currentPrincipal()` reads the users table,
  // so on a fresh clone with no DATABASE_URL this page would otherwise throw
  // before it could say what is missing.
  if (!isDbConfigured(db)) {
    return (
      <>
        <Header />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Plans and subscriptions live in Postgres. Set the variable, run{" "}
          <code className="font-mono">pnpm db:migrate</code> and then{" "}
          <code className="font-mono">pnpm db:seed:plans</code> to put the record
          in <code className="font-mono">src/plans.ts</code> into the table.
        </Notice>
      </>
    );
  }

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Checked here as well as in the layout and again on every procedure. A page
  // can be rendered by a route that does not sit under the admin layout, and
  // "the parent checked" is not something the type system enforces.
  if (!can?.can("staff.billing.resync")) {
    return (
      <>
        <Header />
        <p className="mt-4 text-sm text-ink-muted">
          Re-syncing billing needs{" "}
          <code className="font-mono">staff.billing.resync</code>, which is held
          by administrators and support leads.
        </p>
      </>
    );
  }

  const caller = await api();
  const [catalogue, mirrored] = await Promise.all([
    caller.billing.catalogue(),
    caller.billing.mirrored(),
  ]);

  const unseeded = catalogue.rows.filter((row) => !row.seeded).length;
  const unpublished = catalogue.rows.filter(
    (row) => row.seeded && row.isActive && !row.published,
  ).length;

  return (
    <>
      <Header />

      {!stripe && (
        <div className="mt-4">
        <Notice tone="warn" title="Payments are not configured here">
          <code className="font-mono">STRIPE_SECRET_KEY</code> is not set, so
          there is nothing to publish to and nothing to re-sync from. The plan
          record and its rows below are still real — a deployment with no keys
          exercises the whole subscription path through the simulated one on{" "}
          <code className="font-mono">/account/billing</code>.
        </Notice>
        </div>
      )}

      {unseeded > 0 && (
        <div className="mt-4">
        <Notice tone="warn" title="The plan record and the table disagree">
          {unseeded} of the {catalogue.rows.length} rows{" "}
          <code className="font-mono">src/plans.ts</code> projects are not in the{" "}
          <code className="font-mono">plans</code> table. Nothing can be
          subscribed to a plan that has no row for{" "}
          <code className="font-mono">subscriptions.plan_id</code> to point at —
          run <code className="font-mono">pnpm db:seed:plans</code>.
        </Notice>
        </div>
      )}

      {catalogue.orphaned.length > 0 && (
        <div className="mt-4">
        <Notice tone="danger" title="Rows the record does not account for">
          <p>
            {catalogue.orphaned.map((row) => row.key).join(", ")} — no tier in{" "}
            <code className="font-mono">src/plans.ts</code> projects{" "}
            {catalogue.orphaned.length === 1 ? "this row" : "these rows"}.
            Nothing here deletes them:{" "}
            <code className="font-mono">subscriptions.plan_id</code> is{" "}
            <code className="font-mono">on delete restrict</code>, so a delete
            either fails or takes a paying customer&rsquo;s subscription with it.
            Put the tier back with <code className="font-mono">isActive: false</code>.
          </p>
        </Notice>
        </div>
      )}

      <div className="mt-6">
        <BillingSync
          configured={stripe !== null}
          unpublished={unpublished}
          mirroredCount={mirrored.length}
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="The plan catalogue"
          hint="Projected from src/plans.ts. The record is the source of truth; the table and Stripe are both caches of it."
        />
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH>Price</TH>
                <TH>In the table</TH>
                <TH>At Stripe</TH>
              </TR>
            </THead>
            <TBody>
              {catalogue.rows.map((row) => (
                <TR key={row.key}>
                  <TD>
                    <span className="font-mono text-xs">{row.key}</span>
                    {!row.isActive && (
                      <Badge tone="neutral" className="ml-2">
                        retired
                      </Badge>
                    )}
                  </TD>
                  <TD className="tabular-nums">
                    {formatMinor(row.priceMinor, row.currency)} / {row.interval}
                  </TD>
                  <TD>
                    <Badge tone={row.seeded ? "accent" : "warn"}>
                      {row.seeded ? "seeded" : "missing"}
                    </Badge>
                  </TD>
                  <TD>
                    {/* A retired tier is deliberately never published. Creating
                        a Price for something nobody may buy would put it back
                        on sale in the Stripe dashboard. */}
                    <Badge
                      tone={
                        !row.isActive ? "neutral" : row.published ? "accent" : "warn"
                      }
                    >
                      {!row.isActive
                        ? "not published"
                        : row.published
                          ? "published"
                          : "not published"}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="What the firm's tables say"
          hint="Every subscription row, newest first. `observed` is the Stripe event this row was last written from."
        />
        <CardBody>
          {mirrored.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No subscriptions have been mirrored yet. One appears here the
              moment <code className="font-mono">customer.subscription.created</code>{" "}
              is delivered — or the moment somebody simulates one on a deployment
              with no Stripe keys.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>__TENANT_LABEL__</TH>
                  <TH>Plan</TH>
                  <TH>Status</TH>
                  <TH>Renews / ends</TH>
                  <TH>Observed</TH>
                </TR>
              </THead>
              <TBody>
                {mirrored.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <span className="font-mono text-xs">{row.tenantId}</span>
                    </TD>
                    <TD>
                      <span className="font-mono text-xs">{row.planKey}</span>
                    </TD>
                    <TD>
                      <Badge tone={row.status === "active" ? "accent" : "neutral"}>
                        {row.status}
                      </Badge>
                      {row.cancelAtPeriodEnd && (
                        <Badge tone="warn" className="ml-2">
                          ending
                        </Badge>
                      )}
                    </TD>
                    <TD className="tabular-nums">
                      {row.currentPeriodEnd === null
                        ? "—"
                        : row.currentPeriodEnd.toISOString().slice(0, 10)}
                    </TD>
                    <TD className="tabular-nums">
                      {/* The watermark. A row whose observation is old while
                          Stripe has moved on is exactly what the re-sync above
                          repairs, and this is where that shows. */}
                      {row.lastEventAt === null
                        ? "never"
                        : row.lastEventAt.toISOString().slice(0, 16).replace("T", " ")}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function Header() {
  return (
    <PageHeader
      title="Plans & billing"
      description="What this firm sells on subscription, what Stripe knows about it, and the repair for when the two disagree."
    />
  );
}
