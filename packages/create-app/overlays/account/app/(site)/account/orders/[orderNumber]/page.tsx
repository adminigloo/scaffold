import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Notice,
  buttonClass,
} from "@/components/ui";
import { LicenceKey } from "@/components/account/LicenceKey";
import {
  featureLabel,
  limitLabel,
  orderStatusView,
} from "@/components/account/orderPresentation";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { formatDay, type Delivery, type GrantedEntitlement } from "@/account";
import {
  readDeliveriesForOrders,
  readGrantsForReferences,
} from "@/server/account";
import { readOrderForUser, type FulfilledOrderView } from "@/server/fulfilment";
import { STOREFRONT_TENANT_ID } from "@/server/routers/checkout";

/**
 * ONE ORDER, AND EVERYTHING IT DID. The page somebody opens after paying.
 *
 * It is the cheapest screen in the whole area and the one with the most
 * unrendered data behind it. `orders` stores `subtotal`, `discount`, `tax`,
 * `shipping` and `total` as five separate columns, every order writes all five,
 * and `/checkout/success` prints one. `applyGrant` mints a licence key, inserts
 * a shipment row and writes an entitlement, and none of the three had a reader.
 * Nothing below is new machinery; it is the dial for a machine that was already
 * running.
 *
 * OWNERSHIP IS PROVED BY THE QUERY, NOT BY A CHECK AFTER IT. `readOrderForUser`
 * puts `user_id` in the WHERE clause, so a stranger's order number returns
 * nothing rather than returning a row this page then has to remember to refuse.
 * "No such order" and "not yours" are one answer for the same reason
 * `/checkout/success` gives: distinguishing them makes the route an oracle for
 * which order numbers exist.
 *
 * THE GRANTS ARE REACHED THROUGH THE ORDER. `entitlements` is keyed on the
 * FIRM's tenant id on the storefront path, so it must never be queried by
 * tenant here — see the header of `src/server/account.ts`. The order's
 * fulfilment reference is what names its own entitlement rows and no others.
 */
export const dynamic = "force-dynamic";

export default async function AccountOrderPage({
  params,
}: {
  readonly params: Promise<{ readonly orderNumber: string }>;
}) {
  const { orderNumber } = await params;

  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Notice tone="info" title="Sign in to see this order">
        An order is only ever shown to the account that placed it.{" "}
        <Link href="/sign-in" className="text-accent underline underline-offset-2">
          Sign in
        </Link>{" "}
        with the address you bought under.
      </Notice>
    );
  }

  if (!isDbConfigured(db)) {
    return (
      <Notice tone="warn" title="DATABASE_URL is not set">
        Orders live in Postgres and this deployment has no connection to one.
      </Notice>
    );
  }

  const order = await readOrderForUser({
    tenantId: STOREFRONT_TENANT_ID,
    userId: principal.userId,
    orderNumber: decodeURIComponent(orderNumber),
  });

  if (!order) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="danger" title="That order could not be found">
          Either there is no such order number, or it belongs to a different
          account. If you have more than one, sign in as the account that made
          the purchase.
        </Notice>
        <p>
          <Link href="/account/orders" className={buttonClass("secondary")}>
            All your orders
          </Link>
        </p>
      </div>
    );
  }

  const [grantsByReference, deliveriesByOrder] = await Promise.all([
    readGrantsForReferences({
      tenantId: STOREFRONT_TENANT_ID,
      references: order.reference === null ? [] : [order.reference],
    }),
    readDeliveriesForOrders([order.id]),
  ]);

  const entitlements =
    order.reference === null ? [] : (grantsByReference.get(order.reference) ?? []);
  const deliveries = deliveriesByOrder.get(order.id) ?? [];
  const keys = order.lines.flatMap((line) =>
    line.licenseKey === null ? [] : [{ name: line.name, key: line.licenseKey }],
  );

  const status = orderStatusView(order.status);

  return (
    <div className="flex flex-col gap-6">
      {order.source === "simulated" && (
        // The buyer's own copy of what the success page said once. A simulated
        // order is a real row written by the real function, and a customer
        // looking at their history months later must not read it as a purchase
        // they were charged for.
        <Notice tone="warn" title="This order was recorded without a payment">
          It was booked while Stripe was unconfigured on this deployment. No
          money moved, and it carries no Stripe payment id.
        </Notice>
      )}

      <Card>
        <CardHeader
          title={`Order ${order.orderNumber}`}
          hint={
            order.placedAt === null
              ? "Not placed yet"
              : `Placed on ${formatDay(order.placedAt)}`
          }
          actions={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody className="flex flex-col gap-4">
          <ul className="flex list-none flex-col gap-2 p-0">
            {order.lines.map((line, index) => (
              <li
                // `orderItems.id` is not selected because nothing needs it, and
                // the list is never reordered or filtered — so the index is the
                // correct key here rather than a lazy one.
                key={index}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 text-sm">
                  {line.name}
                  {line.quantity > 1 && (
                    <span className="text-ink-muted"> × {line.quantity}</span>
                  )}
                </span>
                <span className="text-sm tabular-nums text-ink-muted">
                  {formatMinor(line.totalMinor, order.currency)}
                </span>
              </li>
            ))}
          </ul>

          <MoneyLadder order={order} />

          <p className="text-xs text-ink-muted">
            Quote <code className="font-mono">{order.orderNumber}</code> to
            support and they can find this order and the payment behind it.
          </p>
        </CardBody>
      </Card>

      {keys.length > 0 && (
        <Card>
          <CardHeader
            title={keys.length === 1 ? "Licence key" : "Licence keys"}
            hint="Yours permanently. This page is the copy of record."
          />
          <CardBody className="flex flex-col gap-4">
            {keys.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-1.5">
                <p className="text-sm text-ink-muted">{entry.name}</p>
                <LicenceKey value={entry.key} />
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {entitlements.length > 0 && (
        <Card>
          <CardHeader
            title="What this order granted"
            hint="Access added to your account when it was paid for."
          />
          <CardBody className="flex flex-col gap-2">
            {entitlements.map((grant) => (
              <EntitlementLine key={`${grant.feature}-${grant.reference}`} grant={grant} />
            ))}
          </CardBody>
        </Card>
      )}

      {deliveries.length > 0 && (
        <Card>
          <CardHeader title="Delivery" hint="Where the physical part of this order is." />
          <CardBody className="flex flex-col gap-3">
            {deliveries.map((delivery, index) => (
              <DeliveryDetail key={index} delivery={delivery} />
            ))}
          </CardBody>
        </Card>
      )}

      <p>
        <Link href="/account/orders" className={buttonClass("secondary")}>
          All your orders
        </Link>
      </p>
    </div>
  );
}

/**
 * Subtotal, discount, tax, shipping, total — the five stored columns.
 *
 * EVERY ROW WHOSE AMOUNT IS ZERO IS OMITTED except the subtotal and the total.
 * A receipt listing "Tax £0.00, Shipping £0.00, Discount £0.00" on a digital
 * purchase is four lines of noise around the one number that matters, and it
 * invites the reader to check arithmetic that was settled at payment time. When
 * a figure IS non-zero it is always shown, because that is exactly the line
 * somebody is looking for when they open this page.
 *
 * The discount is rendered negative. @__SCOPE_NAME__/commerce stores it
 * positive — it is "the amount taken off" — and printing the stored sign would
 * show a discount that appears to have been added to the bill.
 */
function MoneyLadder({ order }: { readonly order: FulfilledOrderView }) {
  const rows: readonly { label: string; amount: bigint; negative?: boolean }[] = [
    { label: "Subtotal", amount: order.subtotalMinor },
    { label: "Discount", amount: order.discountMinor, negative: true },
    { label: "Shipping", amount: order.shippingMinor },
    { label: "Tax", amount: order.taxMinor },
  ];

  return (
    <dl className="flex flex-col gap-1 border-t border-line pt-3">
      {rows
        .filter((row) => row.label === "Subtotal" || row.amount !== 0n)
        .map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-sm text-ink-muted">{row.label}</dt>
            <dd className="text-sm tabular-nums text-ink-muted">
              {row.negative && row.amount !== 0n ? "−" : ""}
              {formatMinor(row.amount, order.currency)}
            </dd>
          </div>
        ))}
      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
        <dt className="text-sm font-medium">Total</dt>
        <dd className="text-sm font-semibold tabular-nums">
          {formatMinor(order.totalMinor, order.currency)}
        </dd>
      </div>
    </dl>
  );
}

function EntitlementLine({ grant }: { readonly grant: GrantedEntitlement }) {
  const expired =
    grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now();

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm">
          {featureLabel(grant.feature)}
          {expired && <span className="text-ink-muted"> — expired</span>}
        </p>
        {grant.expiresAt !== null && !expired && (
          <p className="text-xs text-ink-muted">Until {formatDay(grant.expiresAt)}</p>
        )}
      </div>
      <p className="text-sm tabular-nums text-ink-muted">
        {/* The limit this grant added, not the account-wide total. Two orders
            can grant the same feature, and a per-order page that showed the sum
            would report the same figure twice and look like double-counting.
            The summed view is on the overview, through `resolveEntitlements`. */}
        {limitLabel(grant.limitValue)}
      </p>
    </div>
  );
}

function DeliveryDetail({ delivery }: { readonly delivery: Delivery }) {
  if (delivery.stage === "preparing") {
    return (
      <Row label="Status">
        Being prepared. Nothing has been despatched yet, so there is no carrier
        or tracking number to show — those appear here as soon as it leaves.
      </Row>
    );
  }

  return (
    <>
      <Row label="Status">
        {delivery.stage === "delivered" ? "Delivered" : "On its way"}
      </Row>
      {delivery.carrier !== null && <Row label="Carrier">{delivery.carrier}</Row>}
      {delivery.trackingNumber !== null && (
        <Row label="Tracking">
          <code className="font-mono">{delivery.trackingNumber}</code>
        </Row>
      )}
      {delivery.shippedAt !== null && (
        <Row label="Despatched">{formatDay(delivery.shippedAt)}</Row>
      )}
      {delivery.deliveredAt !== null && (
        <Row label="Delivered">{formatDay(delivery.deliveredAt)}</Row>
      )}
    </>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="max-w-[42ch] text-right text-sm">{children}</span>
    </div>
  );
}
