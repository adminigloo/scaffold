import Link from "next/link";
import type { ReactNode } from "react";
import { isDbConfigured } from "__SCOPE__/db";
import { Badge, Card, CardBody, EmptyState, Notice, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { money, StatusBadge } from "@/components/admin/orderBits";
import { ORDER_FILTERS, type OrderFilter } from "@/server/routers/orders";
import { api } from "@/trpc/server";

/**
 * THE SHOP'S ORDERS (create-app 0.44): every order this site's own shop booked,
 * newest first, with what was refunded or disputed and which were simulated.
 *
 * Read through the router (`api()`), never from `db` directly, so the page is
 * authorized by the same `requireStaff(...)` rungs a browser request meets.
 * `?filter=` narrows it (paid, refunded, disputed, simulated); `?q=` searches by
 * email or order number. An order's own page shows what it granted and its trail.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  readonly searchParams: Promise<{ readonly filter?: string; readonly q?: string }>;
}

const FILTER_LABELS: Record<OrderFilter, string> = {
  all: "All",
  paid: "Paid",
  refunded: "Refunded",
  disputed: "Disputed",
  simulated: "Simulated",
};

export default async function OrdersPage({ searchParams }: PageProps) {
  if (!isDbConfigured(db)) {
    return (
      <>
        <Header />
        <Notice tone="warn">There is no database yet. Set DATABASE_URL, run the migrations, and this page fills in.</Notice>
      </>
    );
  }

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  // Checked here as well as on the procedure: a page can be reached by a route
  // that doesn't sit under the admin layout.
  if (!can?.can("shop.orders.view")) {
    return (
      <>
        <Header />
        <p className="mt-4 text-sm text-ink-muted">You do not have permission to view the shop&rsquo;s orders.</p>
      </>
    );
  }

  const params = await searchParams;
  const filter = ORDER_FILTERS.find((candidate) => candidate === params.filter) ?? "all";
  const caller = await api();
  const { rows } = await caller.orders.list({ filter, ...(params.q ? { search: params.q } : {}), limit: 200 });

  return (
    <>
      <Header />
      <nav className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="Filter orders">
        {ORDER_FILTERS.map((candidate) => (
          <FilterLink key={candidate} active={filter === candidate} href={hrefWith(params, { filter: candidate === "all" ? undefined : candidate })}>
            {FILTER_LABELS[candidate]}
          </FilterLink>
        ))}
        <form className="ml-auto flex gap-2" action="/admin/orders">
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          <label htmlFor="orders-q" className="sr-only">
            Search orders
          </label>
          <input
            id="orders-q"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Email or order number"
            className="rounded-[--radius-card] border border-line bg-surface px-3 py-1.5 text-sm"
          />
        </form>
      </nav>

      {rows.length === 0 ? (
        <EmptyState title={filter === "all" && !params.q ? "No orders yet" : "No orders match"}>
          {filter === "all" && !params.q
            ? "Orders appear here the moment a purchase is booked, from a real payment or the simulate button."
            : "Try another filter, or clear the search."}
        </EmptyState>
      ) : (
        <Card>
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH>Order</TH>
                  <TH>Buyer</TH>
                  <TH>State</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Refunded</TH>
                  <TH className="text-right">Placed</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <Link href={`/admin/orders/${encodeURIComponent(row.id)}`} className="font-mono text-accent underline-offset-2 hover:underline">
                        {row.orderNumber}
                      </Link>
                      <span className="block text-xs text-ink-muted">
                        {row.lines} {row.lines === 1 ? "line" : "lines"}
                      </span>
                    </TD>
                    <TD>{row.email || <span className="text-ink-muted">no email</span>}</TD>
                    <TD>
                      <span className="flex flex-wrap gap-1">
                        <StatusBadge status={row.status} refunded={row.refundedMinor > 0n} />
                        {row.flag ? <Badge tone="danger">{row.flag.replace("_", " ")}</Badge> : null}
                        {row.source === "simulated" ? <Badge tone="warn">simulated</Badge> : null}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{money(row.totalMinor, row.currency)}</TD>
                    <TD className="text-right tabular-nums">{row.refundedMinor > 0n ? money(row.refundedMinor, row.currency) : "—"}</TD>
                    <TD className="text-right text-ink-muted">{(row.placedAt ?? row.createdAt).toLocaleString("en-US")}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </>
  );
}

function Header() {
  return (
    <PageHeader
      title="Orders"
      description="Everything the shop has sold, newest first. Refunds are made in Stripe and recorded here by the webhook; a simulated order moved no money."
    />
  );
}

function hrefWith(
  params: { readonly filter?: string; readonly q?: string },
  change: { readonly filter?: string | undefined },
): string {
  const next = new URLSearchParams();
  const merged = { ...params, ...change };
  for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
  const query = next.toString();
  return query ? `/admin/orders?${query}` : "/admin/orders";
}

function FilterLink({ href, active, children }: { readonly href: string; readonly active: boolean; readonly children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full border px-3 py-1 text-xs ${active ? "border-accent text-accent" : "border-line text-ink-muted hover:text-ink"}`}
    >
      {children}
    </Link>
  );
}
