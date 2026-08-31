"use client";

import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * The way out to Stripe's hosted billing portal.
 *
 * ONE MUTATION AND A LOCATION ASSIGNMENT, and it deletes an entire category of
 * screens: card forms, billing addresses, VAT ids, dunning notices, invoice
 * downloads and the cancellation flow are all on the other side of this link.
 * Every one of them is a form this firm would otherwise restyle per client.
 *
 * `window.location.assign` RATHER THAN `router.push`. The url is on Stripe's
 * origin, so Next's client router cannot navigate to it — it would try to fetch
 * an RSC payload from a host that does not serve one. A full document load is
 * also what leaves the portal in charge of the back button, which is the
 * behaviour a customer expects from a hosted checkout.
 *
 * `tenantId` ARRIVES AS A PROP, resolved on the server by `currentTenantFor`,
 * exactly as `PendingInvitations` takes it. Every tenant-scoped procedure names
 * its tenant in the input — that is what lets the ladder resolve permissions
 * for the tenant the request is about — and it is safe to hand to a browser
 * because the ladder re-checks membership AND the key against whatever id comes
 * back. A tampered id resolves to "not a member", not to somebody else's
 * billing portal. What must never happen is a PAGE reading a tenant id out of a
 * query string, because then nothing has vouched for it before the check.
 *
 * THE THREE ANSWERS ARE RENDERED, NOT THROWN. `billingPortal` returns a
 * discriminated union rather than throwing when Stripe is absent or the
 * customer has never been charged, and this is where that pays: a person
 * pressing "manage billing" gets a sentence about their own situation instead
 * of a red boundary about a deployment problem they cannot act on. The button
 * is not rendered at all when the page already knows Stripe is unconfigured —
 * the `not_configured` branch here is the server's own answer, kept because the
 * procedure is reachable without the page.
 */
export function BillingPortalButton({ tenantId }: { readonly tenantId: string }) {
  const [leaving, setLeaving] = useState(false);

  const open = api.account.billingPortal.useMutation({
    onSuccess: (result) => {
      if (result.status !== "ready") return;
      // Held separately from `isPending`, exactly as `SimulatePurchase` holds
      // it: the mutation flips back to idle the instant it resolves and the
      // navigation takes another beat, and a button that re-enables during that
      // beat invites a second click and a second portal session.
      setLeaving(true);
      window.location.assign(result.url);
    },
  });

  const busy = open.isPending || leaving;
  const result = open.data;

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => open.mutate({ tenantId })}
        className="self-start"
      >
        {busy ? "Opening Stripe…" : "Manage billing"}
      </Button>

      {result?.status === "no_customer" && (
        <Notice tone="info" title="There is nothing to manage yet" role="status">
          Stripe holds no billing record for this account, which means nothing
          has ever been charged to it. The portal appears here as soon as there
          is a payment behind it.
        </Notice>
      )}

      {result?.status === "not_configured" && (
        <Notice tone="warn" title="Payments are not configured here" role="status">
          This deployment has no <code>STRIPE_SECRET_KEY</code>, so there is no
          billing account to open. Nothing has been charged and nothing is
          outstanding.
        </Notice>
      )}

      {open.error && (
        <Notice tone="danger" title="Stripe did not answer" role="alert">
          The billing portal could not be opened just now. Nothing has changed on
          your account — try again in a moment.
        </Notice>
      )}
    </div>
  );
}
