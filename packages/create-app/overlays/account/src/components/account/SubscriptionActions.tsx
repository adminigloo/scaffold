"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import type { SubscriptionAction } from "@/account";
import { api } from "@/trpc/client";

/**
 * ONE BUTTON, CHOSEN ON THE SERVER.
 *
 * Dub's rule, and the reason this component takes an ACTION rather than a
 * subscription: a billing screen that renders Cancel, Resume, Change plan and
 * Update card together — three of them greyed out — makes the reader work out
 * which one their situation calls for, and they get it wrong in exactly the
 * combinations that matter. `primaryActionFor` collapses the five columns into
 * one decision, it is a pure function with its own tests, and it runs on the
 * server so this component cannot form a second opinion about it. The same
 * arrangement `SimulatePurchase` has with `checkoutMode()`, for the same reason
 * — four copies of one rule agreed on the day they were written and disagreed
 * by the end of the month.
 *
 * `portal` and `settle` are NOT handled here. Both open Stripe's hosted portal,
 * which `BillingPortalButton` already owns end to end — the mutation, the audit
 * row, the three answers and the full-document navigation. A second component
 * that also minted portal sessions would be a second audit path for the same
 * capability, so this one renders the sentence and defers to the button beside
 * it.
 */
export interface SubscriptionActionsProps {
  readonly tenantId: string;
  readonly action: SubscriptionAction;
  /**
   * Does the viewer hold `subscriptions.manage`?
   *
   * DISABLED WITH THE REASON, NOT HIDDEN, matching the portal button on the
   * same page. Somebody who cannot cancel should be able to see that cancelling
   * is possible and who to ask, rather than concluding the product has no way
   * out. Resolved on the server; the mutation re-checks it, so this is
   * presentation and not the boundary.
   */
  readonly canManage: boolean;
}

export function SubscriptionActions(props: SubscriptionActionsProps) {
  // A second click while the first is in flight would send a second mutation.
  // The procedure is idempotent — it returns `changed: false` when the flag
  // already holds the value asked for — but a second audit row and a second
  // Stripe call for nothing are still worth not making.
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  const settled = () => {
    setConfirming(false);
    // `router.refresh()` and not a local state update. The banner, the card and
    // this button are all rendered on the SERVER from the subscription row, so
    // patching one of the three in the browser is how a screen comes to say
    // "ends on the 3rd" above a button that still offers to cancel.
    router.refresh();
  };

  const cancel = api.account.cancelSubscription.useMutation({ onSuccess: settled });
  const resume = api.account.resumeSubscription.useMutation({ onSuccess: settled });

  if (props.action.kind === "none") {
    return <p className="max-w-[62ch] text-sm text-ink-muted">{props.action.hint}</p>;
  }

  // Handled by `BillingPortalButton`, which is rendered on the same page. The
  // sentence still belongs here, because it is the one the state chose.
  if (props.action.kind === "settle" || props.action.kind === "portal") {
    return (
      <p className="max-w-[62ch] text-sm text-ink-muted">
        {props.action.hint} Use <strong className="font-medium text-ink">Manage
        billing</strong> below.
      </p>
    );
  }

  const mutation = props.action.kind === "cancel" ? cancel : resume;
  const busy = cancel.isPending || resume.isPending;

  if (!props.canManage) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" disabled className="self-start">
          {props.action.label}
        </Button>
        <p className="max-w-[62ch] text-sm text-ink-muted">
          Changing what this __TENANT_LABEL_LOWER__ pays needs{" "}
          <code className="font-mono">subscriptions.manage</code>, which normally
          only its owner holds. Ask them, or have them grant it to you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div className="flex flex-col gap-2">
          {/* A confirm step only on the actions that change what is charged.
              Everything else goes straight through: a confirmation on a
              harmless control teaches people to click past confirmations. */}
          <p className="max-w-[62ch] text-sm text-ink">{props.action.hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => mutation.mutate({ tenantId: props.tenantId })}
            >
              {busy ? "Saving…" : `Yes — ${props.action.label.toLowerCase()}`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Leave it as it is
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            variant={props.action.kind === "cancel" ? "secondary" : "primary"}
            disabled={busy}
            className="self-start"
            onClick={() =>
              props.action.consequential
                ? setConfirming(true)
                : mutation.mutate({ tenantId: props.tenantId })
            }
          >
            {props.action.label}
          </Button>
          <p className="max-w-[62ch] text-sm text-ink-muted">{props.action.hint}</p>
        </>
      )}

      {mutation.error && (
        <Notice tone="danger" title="That did not go through" role="alert">
          {/* The server's own message. It distinguishes "already ended" from
              "you are not allowed" from "Stripe refused", and each one needs a
              different person to do a different thing. */}
          {mutation.error.message}
        </Notice>
      )}
    </div>
  );
}
