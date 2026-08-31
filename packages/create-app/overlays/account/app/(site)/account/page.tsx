import Link from "next/link";
import type { Principal } from "__SCOPE__/auth";
import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  buttonClass,
} from "@/components/ui";
import {
  accountOrderHref,
  describeSubscription,
  formatDay,
  metersFor,
  type Delivery,
  type GrantedEntitlement,
} from "@/account";
import { LicenceKey } from "@/components/account/LicenceKey";
import {
  featureLabel,
  limitLabel,
  orderStatusView,
} from "@/components/account/orderPresentation";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import {
  readDeliveriesForOrders,
  readGrantsForReferences,
  readSubscriptionForTenant,
} from "@/server/account";
import { listOrdersForUser, type FulfilledOrderView } from "@/server/fulfilment";
import { loadTenantPermissions } from "@/server/permissions";
import { STOREFRONT_TENANT_ID } from "@/server/routers/checkout";
import { currentTenantFor } from "@/server/tenant";

/**
 * WHAT THIS PERSON HAS. The page a customer opens after paying.
 *
 * Until this overlay there was no such page, in either direction:
 * `fulfilPurchase` wrote an order, its lines, its shipments and its
 * entitlements, and the only reader in the whole project was
 * `readOrderByReference` — keyed on a value in a URL the buyer was about to
 * navigate away from. Everything below is a read of rows that were already
 * being written and shown to nobody.
 *
 * THREE BLOCKS IN ONE ORDER, and the order is the argument. What you HOLD comes
 * before what you BOUGHT, because a customer arriving here wants the licence
 * key, not the receipt — the receipt is the thing they can find again from
 * their email, and the key is the thing they cannot. Billing state sits at the
 * top only when there is something wrong with it, which is the one case where
 * it outranks both.
 *
 * ONE ROUND OF QUERIES, not one per block. The orders are read once and
 * everything else — grants, deliveries, licence keys — is derived from that
 * list, because those three questions are all "what did these orders do" and
 * splitting them into three page sections must not split them into three
 * traversals.
 */
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const principal = await currentPrincipal();
  if (!principal) return <SignedOut />;

  // Asked before anything queries, matching every other page in this project.
  // The account area is linked from the header of every page, so on a fresh
  // clone it is one of the first things anybody clicks.
  if (!isDbConfigured(db)) return <NoDatabase />;

  const orders = await listOrdersForUser({
    tenantId: STOREFRONT_TENANT_ID,
    userId: principal.userId,
  });

  // Every reference this person's orders were booked under. A NULL reference
  // means the row was keyed by a writer other than `fulfilPurchase`; it is
  // still their order and still listed, it simply names no grants.
  const references = orders.flatMap((order) =>
    order.reference === null ? [] : [order.reference],
  );

  const [grantsByReference, deliveriesByOrder] = await Promise.all([
    readGrantsForReferences({ tenantId: STOREFRONT_TENANT_ID, references }),
    readDeliveriesForOrders(orders.map((order) => order.id)),
  ]);

  const grants: GrantedEntitlement[] = [...grantsByReference.values()].flat();
  const meters = metersFor(grants);

  const keys = orders.flatMap((order) =>
    order.lines.flatMap((line) =>
      line.licenseKey === null
        ? []
        : [{ orderNumber: order.orderNumber, name: line.name, key: line.licenseKey }],
    ),
  );

  const deliveries = orders.flatMap((order) =>
    (deliveriesByOrder.get(order.id) ?? []).map((delivery) => ({
      orderNumber: order.orderNumber,
      delivery,
    })),
  );

  const billing = await billingBanner(principal);

  const hasSomething =
    orders.length > 0 || meters.length > 0 || keys.length > 0 || billing !== null;

  if (!hasSomething) return <NothingYet />;

  return (
    <div className="flex flex-col gap-6">
      {billing}

      {keys.length > 0 && (
        <Card>
          <CardHeader
            title="Licence keys"
            hint="Kept here permanently. Copy one whenever you need it."
          />
          <CardBody className="flex flex-col gap-4">
            {keys.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-1.5">
                <p className="text-sm">
                  {entry.name}{" "}
                  <Link
                    href={accountOrderHref(entry.orderNumber)}
                    className="text-ink-muted no-underline hover:text-accent"
                  >
                    ({entry.orderNumber})
                  </Link>
                </p>
                <LicenceKey value={entry.key} />
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {meters.length > 0 && (
        <Card>
          <CardHeader
            title="What you can use"
            hint="Summed across everything you have bought."
          />
          <CardBody className="flex flex-col gap-3">
            {meters.map((meter) => (
              <div key={meter.feature} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm">{featureLabel(meter.feature)}</p>
                  <p className="text-sm tabular-nums text-ink-muted">
                    {/* Used AND limit, never a bare percentage. An overage is
                        real — a grant expired while its usage stood — and
                        "7 of 5 used" has to stay sayable. */}
                    {meter.resolved.used} of {limitLabel(meter.resolved.limit)} used
                    {meter.resolved.unlimited ? "" : ` · ${meter.resolved.remaining} left`}
                  </p>
                </div>
                {meter.exhausted && (
                  <p className="text-xs text-warn">
                    Nothing left on this allowance. Buying more adds to it rather
                    than replacing it.
                  </p>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {deliveries.length > 0 && (
        <Card>
          <CardHeader title="Deliveries" hint="Anything physical you have ordered." />
          <CardBody className="flex flex-col gap-2">
            {deliveries.map((entry, index) => (
              <DeliveryLine
                // No stable id: `order_shipments.id` is not selected because
                // nothing needs it, and one order can hold two shipments. The
                // list is never reordered or filtered, so the index is correct
                // here rather than lazy.
                key={`${entry.orderNumber}-${index}`}
                orderNumber={entry.orderNumber}
                delivery={entry.delivery}
              />
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Recent orders"
          hint={orders.length === 1 ? "1 order" : `${orders.length} orders`}
          actions={
            orders.length > RECENT_ORDERS ? (
              <Link href="/account/orders" className={buttonClass("secondary")}>
                See all
              </Link>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-2">
          {orders.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing bought yet. Everything above came from a subscription
              rather than a one-off purchase.
            </p>
          ) : (
            orders
              .slice(0, RECENT_ORDERS)
              .map((order) => <OrderLine key={order.id} order={order} />)
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * How many orders the overview shows before deferring to `/account/orders`.
 *
 * Five, because the overview's subject is what you HOLD and the order list is a
 * different question. A page that renders two hundred receipts under three
 * licence keys has buried the thing the reader came for.
 */
const RECENT_ORDERS = 5;

// ---------------------------------------------------------------------------
// Billing state, and who is allowed to see it
// ---------------------------------------------------------------------------

/**
 * ONE banner, or nothing at all.
 *
 * BEHIND `subscriptions.view`, which is a TENANT permission from
 * @__SCOPE_NAME__/billing and is checked against the viewer's own
 * __TENANT_LABEL_LOWER__ — not against the storefront tenant their orders live
 * in. Those really are two different tenants and the distinction is the whole
 * design: a subscription is what an organisation pays, several people can be
 * in that organisation, and the renewal amount is the same disclosure as an
 * invoice. The package gives the key to `owner` and `admin` and withholds it
 * from `member` and `viewer` for exactly that reason.
 *
 * HIDDEN RATHER THAN DISABLED, unlike the portal button on `/account/billing`.
 * The rule is that a CONTROL should explain itself instead of vanishing, so a
 * person can see there is something they are not allowed to do. This is not a
 * control, it is a disclosure — and a placeholder reading "you may not see the
 * renewal amount" tells the reader nothing they can act on while adding a
 * permanent apology to the top of the page. The Billing tab stays visible
 * either way, and lands on a page that says plainly what is missing.
 */
async function billingBanner(principal: Principal) {
  const tenant = await currentTenantFor(principal.userId);
  if (!tenant) return null;

  const permissions = await loadTenantPermissions({ principal, tenantId: tenant.id });
  if (!permissions?.can("subscriptions.view")) return null;

  const subscription = await readSubscriptionForTenant(tenant.id);
  if (!subscription) return null;

  const banner = describeSubscription(subscription);

  return (
    <Notice tone={banner.tone} title={banner.title}>
      {banner.body}{" "}
      <Link href="/account/billing" className="text-accent underline underline-offset-2">
        Billing
      </Link>{" "}
      has the detail.
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function OrderLine({ order }: { readonly order: FulfilledOrderView }) {
  const status = orderStatusView(order.status);

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-b-0 last:pb-0">
      <div className="min-w-0">
        <Link
          href={accountOrderHref(order.orderNumber)}
          className="font-mono text-sm text-ink no-underline hover:text-accent"
        >
          {order.orderNumber}
        </Link>
        <p className="text-xs text-ink-muted">
          {order.placedAt === null ? "Not placed yet" : formatDay(order.placedAt)}
          {order.lines[0] ? ` · ${order.lines[0].name}` : ""}
        </p>
      </div>
      <div className="flex items-baseline gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <p
          className={
            status.struckThrough
              ? "text-sm tabular-nums text-ink-muted line-through"
              : "text-sm font-medium tabular-nums"
          }
        >
          {formatMinor(order.totalMinor, order.currency)}
        </p>
      </div>
    </div>
  );
}

function DeliveryLine({
  orderNumber,
  delivery,
}: {
  readonly orderNumber: string;
  readonly delivery: Delivery;
}) {
  const COPY: Record<Delivery["stage"], { label: string; detail: string }> = {
    preparing: {
      label: "Being prepared",
      detail: "Not despatched yet. There is no tracking number until it leaves.",
    },
    despatched: {
      label: "On its way",
      detail:
        delivery.shippedAt === null
          ? "Despatched."
          : `Despatched on ${formatDay(delivery.shippedAt)}.`,
    },
    delivered: {
      label: "Delivered",
      detail:
        delivery.deliveredAt === null
          ? "Delivered."
          : `Delivered on ${formatDay(delivery.deliveredAt)}.`,
    },
  };
  const copy = COPY[delivery.stage];

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm">
          {copy.label}{" "}
          <Link
            href={accountOrderHref(orderNumber)}
            className="text-ink-muted no-underline hover:text-accent"
          >
            ({orderNumber})
          </Link>
        </p>
        <p className="text-xs text-ink-muted">
          {copy.detail}
          {delivery.carrier === null ? "" : ` ${delivery.carrier}.`}
          {delivery.trackingNumber === null ? "" : ` Tracking ${delivery.trackingNumber}.`}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three states that are not "here is your stuff"
// ---------------------------------------------------------------------------

function SignedOut() {
  return (
    <Notice tone="info" title="Sign in to see what you have">
      <p>
        Purchases belong to an account, so there is nothing to show until we know
        whose this is. Signing in with the address you bought under brings back
        every order, licence key and allowance on it.
      </p>
      <p className="mt-3">
        <Link href="/sign-in" className={buttonClass("primary")}>
          Sign in
        </Link>
      </p>
    </Notice>
  );
}

function NoDatabase() {
  return (
    <Notice tone="warn" title="DATABASE_URL is not set">
      Orders and everything they granted live in Postgres, and this deployment
      has no connection to one — so there is nothing to read back. Nobody has
      been charged.{" "}
      <Link href="/setup" className="text-accent underline underline-offset-2">
        /setup
      </Link>{" "}
      lists what else is outstanding.
    </Notice>
  );
}

/**
 * THE FIRST SCREEN EVERY NEW USER OF A CLIENT'S APP SEES.
 *
 * Worth more than "No orders", and worth more than a skeleton of fake rows —
 * ghost cards shaped like data are read as data by somebody who is not looking
 * carefully, and the person looking at this page has just signed up and is
 * looking at everything carefully.
 *
 * So it draws the shape in words instead: the three things that will appear
 * here, each with the reason it is here rather than in an email. That third
 * clause is the one that earns its place — the whole justification for an
 * account area is that a receipt in an inbox is not a copy of record, and this
 * is where a new customer learns that this application keeps one.
 *
 * ONE ACTION. There is exactly one thing to do from an empty account, and
 * offering a second would be inventing a task.
 */
function NothingYet() {
  return (
    <EmptyState
      title="Nothing here yet"
      action={
        <Link href="/products" className={buttonClass("primary")}>
          Browse products
        </Link>
      }
    >
      <p>Once you buy something, this page is where it lives:</p>
      <ul className="mt-2 flex list-none flex-col gap-1 p-0 text-left">
        <li>
          <strong className="font-medium text-ink">Orders</strong> — every
          purchase with its full breakdown, and the number to quote to support.
        </li>
        <li>
          <strong className="font-medium text-ink">Licence keys and deliveries</strong>{" "}
          — kept here for good, not only on the page you saw once after paying.
        </li>
        <li>
          <strong className="font-medium text-ink">Allowances</strong> — how much
          of anything you have bought is still left.
        </li>
      </ul>
    </EmptyState>
  );
}
