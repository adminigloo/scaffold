import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { isDbConfigured } from "__SCOPE__/db";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { money, StatusBadge } from "@/components/admin/orderBits";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

/**
 * ONE ORDER, IN FULL (create-app 0.44): what was bought, what it granted (the
 * credits it moved, the entitlements it holds, the licence keys it issued), its
 * refunds and dispute as Stripe reported them, and its audit trail. Read only:
 * a refund is made in Stripe ("Open in Stripe") and comes back by the webhook.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
}

const REASON_TONE = { grant: "ok", spend: "neutral", refund: "warn", adjust: "accent" } as const;

export default async function OrderPage({ params }: PageProps) {
  if (!isDbConfigured(db)) {
    return <Notice tone="warn">There is no database yet. Set DATABASE_URL, run the migrations, and this page fills in.</Notice>;
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("shop.orders.view")) {
    return <p className="mt-4 text-sm text-ink-muted">You do not have permission to view the shop&rsquo;s orders.</p>;
  }

  const { id } = await params;
  const caller = await api();
  let detail;
  try {
    detail = await caller.orders.detail({ id: decodeURIComponent(id) });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const { order, lines, credits, entitlements, trail } = detail;

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{order.orderNumber}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={order.status} refunded={order.refundedMinor > 0n} />
            {order.flag ? <Badge tone="danger">{order.flag.replace("_", " ")}</Badge> : null}
            {order.source === "simulated" ? <Badge tone="warn">simulated, no money moved</Badge> : null}
            <span>{order.email || "no email"}</span>
            <span className="text-ink-muted">{(order.placedAt ?? order.createdAt).toLocaleString("en-US")}</span>
          </span>
        }
        actions={
          <span className="flex gap-3 text-sm">
            {order.stripeUrl ? (
              <a href={order.stripeUrl} target="_blank" rel="noreferrer" className="text-accent">
                Open in Stripe
              </a>
            ) : null}
            <Link href="/admin/orders" className="text-accent">
              All orders
            </Link>
          </span>
        }
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="What was bought" />
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH>Item</TH>
                  <TH className="text-right">Qty</TH>
                  <TH className="text-right">Each</TH>
                  <TH className="text-right">Line</TH>
                  <TH>Granted</TH>
                </TR>
              </THead>
              <TBody>
                {lines.map((line) => (
                  <TR key={line.id}>
                    <TD>{line.name}</TD>
                    <TD className="text-right tabular-nums">{line.quantity}</TD>
                    <TD className="text-right tabular-nums">{money(line.unitPriceMinor, order.currency)}</TD>
                    <TD className="text-right tabular-nums">{money(line.totalMinor, order.currency)}</TD>
                    <TD className="text-xs">
                      {line.credits.map((c) => (
                        <span key={c.unit} className="block">
                          {c.amount} {c.unit}
                        </span>
                      ))}
                      {line.licenseKey ? (
                        <span className="block font-mono">
                          {line.licenseKey}
                          {line.licenseRevokedAt ? <Badge tone="danger" className="ml-1">revoked</Badge> : null}
                        </span>
                      ) : null}
                      {line.credits.length === 0 && !line.licenseKey ? <span className="text-ink-muted">see below</span> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:max-w-sm">
              <dt className="text-ink-muted">Subtotal</dt>
              <dd className="text-right tabular-nums">{money(order.subtotalMinor, order.currency)}</dd>
              {order.discountMinor > 0n ? (
                <>
                  <dt className="text-ink-muted">Discount</dt>
                  <dd className="text-right tabular-nums">−{money(order.discountMinor, order.currency)}</dd>
                </>
              ) : null}
              <dt className="font-medium">Total</dt>
              <dd className="text-right font-medium tabular-nums">{money(order.totalMinor, order.currency)}</dd>
              {order.refundedMinor > 0n ? (
                <>
                  <dt className="text-warn">Refunded in Stripe</dt>
                  <dd className="text-right tabular-nums text-warn">{money(order.refundedMinor, order.currency)}</dd>
                </>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        {credits.length > 0 ? (
          <Card>
            <CardHeader title="Credits" hint="What this order put in the buyer's balance, and anything a refund or dispute took back." />
            <CardBody>
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>What</TH>
                    <TH className="text-right">Change</TH>
                    <TH>Reference and note</TH>
                  </TR>
                </THead>
                <TBody>
                  {credits.map((entry) => (
                    <TR key={entry.id.toString()}>
                      <TD className="whitespace-nowrap text-ink-muted">{entry.createdAt.toLocaleString("en-US")}</TD>
                      <TD>
                        <Badge tone={REASON_TONE[entry.reason]}>{entry.reason}</Badge>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {entry.delta > 0 ? "+" : ""}
                        {entry.delta} {entry.unit}
                      </TD>
                      <TD className="text-xs text-ink-muted">
                        <span className="font-mono">{entry.ref}</span>
                        {entry.note ? <span className="block">{entry.note}</span> : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {order.userId ? (
                <p className="mt-3 text-xs">
                  <Link href={`/admin/credits?holder=${encodeURIComponent(order.userId)}`} className="text-accent">
                    The buyer&rsquo;s whole ledger
                  </Link>
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {entitlements.length > 0 ? (
          <Card>
            <CardHeader title="Entitlements" hint="What this order unlocks. A whole refund or a dispute ends them; the rows stay as the record." />
            <CardBody>
              <Table>
                <THead>
                  <TR>
                    <TH>Feature</TH>
                    <TH className="text-right">Limit</TH>
                    <TH className="text-right">Used</TH>
                    <TH className="text-right">Ends</TH>
                  </TR>
                </THead>
                <TBody>
                  {entitlements.map((row) => (
                    <TR key={row.id}>
                      <TD className="font-mono">{row.feature}</TD>
                      <TD className="text-right tabular-nums">{row.limitValue ?? "unlimited"}</TD>
                      <TD className="text-right tabular-nums">{row.usedValue}</TD>
                      <TD className="text-right text-ink-muted">{row.expiresAt ? row.expiresAt.toLocaleString("en-US") : "never"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Trail" hint="Every audit row about this order: booked, refunded, disputed." />
          <CardBody>
            {trail.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing recorded.</p>
            ) : (
              <ol className="flex flex-col gap-2 text-sm">
                {trail.map((row) => (
                  <li key={row.id.toString()} className="flex flex-wrap items-baseline gap-2">
                    <span className="whitespace-nowrap text-ink-muted">{row.createdAt.toLocaleString("en-US")}</span>
                    <span className="font-mono">{row.action}</span>
                    {row.isSensitive ? <Badge tone="warn">sensitive</Badge> : null}
                  </li>
                ))}
              </ol>
            )}
            {order.reference ? (
              <p className="mt-3 text-xs text-ink-muted">
                Reference <span className="font-mono">{order.reference}</span>
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
