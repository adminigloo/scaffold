import Link from "next/link";
import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonClass,
} from "@/components/ui";
import { accountOrderHref, formatDay } from "@/account";
import { orderStatusView } from "@/components/account/orderPresentation";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { ACCOUNT_ORDER_LIMIT, listOrdersForUser } from "@/server/fulfilment";
import { STOREFRONT_TENANT_ID } from "@/server/routers/checkout";

/**
 * Everything this person has ever bought, oldest at the bottom.
 *
 * SEPARATE FROM `/account` BECAUSE THEY ANSWER DIFFERENT QUESTIONS. The
 * overview is "what do I have", which is licence keys and allowances and stops
 * being readable past a handful of receipts. This is "what did I pay for and
 * when", which is the question somebody arrives with holding a bank statement,
 * and it wants every row.
 *
 * FIVE COLUMNS AND NO MORE. Placed, order, product, status, total — plus the
 * number itself as the link, because the number is what a customer quotes to
 * support and a separate "view" column would be a second click target for the
 * same destination. Anything else worth knowing is on the detail page, and a
 * table that tries to carry a money breakdown is a table nobody can read on a
 * phone.
 */
export const dynamic = "force-dynamic";

export default async function AccountOrdersPage() {
  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Notice tone="info" title="Sign in to see your orders">
        An order belongs to the account that placed it, so there is nothing to
        list until we know whose this is.{" "}
        <Link href="/sign-in" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
        .
      </Notice>
    );
  }

  if (!isDbConfigured(db)) {
    return (
      <Notice tone="warn" title="DATABASE_URL is not set">
        Orders live in Postgres and this deployment has no connection to one, so
        there is nothing to read back.
      </Notice>
    );
  }

  const orders = await listOrdersForUser({
    tenantId: STOREFRONT_TENANT_ID,
    userId: principal.userId,
  });

  if (orders.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        action={
          <Link href="/products" className={buttonClass("primary")}>
            Browse products
          </Link>
        }
      >
        Every purchase lands here the moment it is paid for, with the amount, the
        breakdown behind it and the order number to quote if you ever need to ask
        about it.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Table>
          <THead>
            <TR>
              <TH className="w-[8rem]">Placed</TH>
              <TH>Order</TH>
              <TH>Product</TH>
              <TH className="w-[9rem]">Status</TH>
              <TH className="w-[8rem] text-right">Total</TH>
            </TR>
          </THead>
          <TBody>
            {orders.map((order) => {
              const status = orderStatusView(order.status);
              return (
                <TR key={order.id}>
                  <TD className="whitespace-nowrap text-ink-muted">
                    {/* NULL until the payment settles. "Not placed yet" rather
                        than an em dash, because a blank cell in a date column
                        reads as data we lost. */}
                    {order.placedAt === null ? "Not placed yet" : formatDay(order.placedAt)}
                  </TD>
                  <TD>
                    <Link
                      href={accountOrderHref(order.orderNumber)}
                      className="font-mono text-ink no-underline hover:text-accent"
                    >
                      {order.orderNumber}
                    </Link>
                  </TD>
                  <TD>
                    {/* The first line names the order. `fulfilPurchase` books
                        one line per order today; a cart-based checkout would
                        book several, and the count is what keeps this honest
                        without widening the column. */}
                    {order.lines[0]?.name ?? "—"}
                    {order.lines.length > 1 && (
                      <span className="text-ink-muted"> +{order.lines.length - 1} more</span>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TD>
                  <TD
                    className={
                      status.struckThrough
                        ? "text-right tabular-nums text-ink-muted line-through"
                        : "text-right font-medium tabular-nums"
                    }
                  >
                    {formatMinor(order.totalMinor, order.currency)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      {orders.length >= ACCOUNT_ORDER_LIMIT && (
        // Said out loud rather than silently truncated. A list that stops at a
        // round number without saying so is indistinguishable from a customer's
        // older orders having been deleted, and that is a support ticket.
        <Notice tone="info" title="Showing the most recent orders">
          This page lists the latest {ACCOUNT_ORDER_LIMIT}. Anything older is
          still on record — quote the order number and support can find it.
        </Notice>
      )}
    </div>
  );
}
