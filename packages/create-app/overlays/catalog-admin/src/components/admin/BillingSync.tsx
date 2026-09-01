"use client";

import { useRouter } from "next/navigation";
import { Button, Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * The two buttons that put the firm's billing tables and Stripe back in step.
 *
 * THEY ARE NOT THE SAME OPERATION AND ARE NOT ONE BUTTON. Publishing pushes the
 * plan record's prices OUT to Stripe so a checkout has something to bill
 * against; re-syncing pulls every subscription back IN so the tables this
 * product answers from say what Stripe says. Collapsing them into "Sync" would
 * make the failure of either invisible inside the success of the other, and
 * they fail for different reasons — a plan that has not been seeded, versus a
 * subscription that carries no tenant.
 *
 * BOTH ARE AUDITED SERVER-SIDE, and neither is audited here. `applySubscription`
 * writes `billing.subscription.resynced` for every row it touches, flagged
 * sensitive so it lands in the compliance slice: this is the one action that
 * overwrites the authoritative billing tables from outside the event stream, so
 * "who changed what this organisation is entitled to" has to start from it. A
 * component cannot write an audit row and must not appear to.
 *
 * `router.refresh()` AND NOT A LOCAL STATE UPDATE. Everything on this page — the
 * catalogue table, the mirrored rows, the two warning banners — is rendered on
 * the server from the same tables these mutations just wrote. Patching one of
 * them in the browser is how a screen comes to show "3 plans not published"
 * above a report saying three were just published.
 */
export interface BillingSyncProps {
  /** Is there a Stripe key on this deployment? Decided on the server. */
  readonly configured: boolean;
  /** Active, seeded plan rows Stripe has never been told about. */
  readonly unpublished: number;
  readonly mirroredCount: number;
}

export function BillingSync(props: BillingSyncProps) {
  const router = useRouter();

  const publish = api.billing.syncPlans.useMutation({
    onSuccess: () => router.refresh(),
  });
  const resync = api.billing.resync.useMutation({
    onSuccess: () => router.refresh(),
  });

  const busy = publish.isPending || resync.isPending;

  return (
    <Card>
      <CardHeader
        title="Reconcile with Stripe"
        hint="This firm owns the billing tables, so a missed webhook leaves them authoritative and wrong. These are the repair."
      />
      <CardBody className="flex flex-col gap-4">
        {!props.configured && (
          <Notice tone="warn" title="Nothing to reconcile with">
            There is no <code className="font-mono">STRIPE_SECRET_KEY</code> on
            this deployment, so both buttons answer{" "}
            <code className="font-mono">not_configured</code> rather than
            throwing. Nothing here is broken — a missing credential is a state,
            not an error.
          </Notice>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={busy || !props.configured}
              onClick={() => publish.mutate()}
            >
              {publish.isPending ? "Publishing…" : "Publish plans to Stripe"}
            </Button>
            <span className="text-sm text-ink-muted">
              {props.unpublished === 0
                ? "Every active plan already has a Stripe price."
                : `${props.unpublished} active plan${props.unpublished === 1 ? " has" : "s have"} no Stripe price yet.`}
            </span>
          </div>
          <p className="max-w-[70ch] text-sm text-ink-muted">
            Creates the Stripe Product and Price each plan row bills against and
            caches their ids. A Stripe price is immutable, so a repriced tier
            gets a NEW price and the lookup key moves to it — the old one keeps
            billing whoever is already on it, which is the only behaviour that
            does not silently restate what somebody agreed to pay.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || !props.configured}
              onClick={() => resync.mutate({ limit: 50 })}
            >
              {resync.isPending ? "Re-pulling…" : "Re-sync subscriptions"}
            </Button>
            <span className="text-sm text-ink-muted">
              {props.mirroredCount} subscription
              {props.mirroredCount === 1 ? "" : "s"} recorded locally.
            </span>
          </div>
          <p className="max-w-[70ch] text-sm text-ink-muted">
            Reads the most recent 50 subscriptions Stripe holds, in every status,
            and writes each one through the same function the webhook uses. Each
            is stamped with the instant it was read, so it wins against any event
            still queued behind it — which is what makes this a repair rather
            than a race.
          </p>
        </div>

        {publish.data && (
          <Notice
            tone={publish.data.status === "ok" ? "info" : "warn"}
            title={
              publish.data.status === "ok"
                ? `${publish.data.published} plan rows examined, ${publish.data.created} new price${publish.data.created === 1 ? "" : "s"} created`
                : "Stripe is not configured here"
            }
            role="status"
          >
            <ul className="mt-1 flex flex-col gap-0.5">
              {publish.data.rows.map((row) => (
                <li key={row.key} className="font-mono text-xs">
                  {row.key} — {row.outcome}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {resync.data && (
          <Notice
            tone={resync.data.status === "ok" ? "info" : "warn"}
            title={
              resync.data.status === "ok"
                ? `${resync.data.examined} examined, ${resync.data.mirrored} written`
                : "Stripe is not configured here"
            }
            role="status"
          >
            {resync.data.skipped.length === 0 ? (
              <p>
                Nothing was skipped. Every subscription Stripe holds is now
                recorded here as Stripe describes it.
              </p>
            ) : (
              <>
                <p>
                  {resync.data.skipped.length} were not written. That is not
                  necessarily wrong — a recurring PRODUCT from the shop is a
                  Stripe subscription this table deliberately does not own — but
                  each one says why:
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {resync.data.skipped.map((row) => (
                    <li key={row.id} className="text-xs">
                      <span className="font-mono">{row.id}</span> — {row.why}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Notice>
        )}

        {(publish.error ?? resync.error) && (
          <Notice tone="danger" title="Stripe did not answer" role="alert">
            {/* The server's own message. It distinguishes a plan that has not
                been seeded from a price Stripe refused, and each needs a
                different person to do a different thing. */}
            {(publish.error ?? resync.error)?.message}
          </Notice>
        )}
      </CardBody>
    </Card>
  );
}
