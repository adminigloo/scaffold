import Link from "next/link";
import type { ReactNode } from "react";
import { isDbConfigured } from "__SCOPE__/db";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { AdjustCredits } from "@/components/admin/AdjustCredits";
import { creditsLabel } from "@/credits";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

/**
 * EVERYONE'S CREDITS (wallet 0.1, create-app 0.43): what a `credits` grant put
 * in people's accounts, what they did with it, and the one thing staff may
 * change by hand.
 *
 * Read through the router (`api()`), never from `db` directly, so the page is
 * authorized by the same `requireStaff(...)` rungs a browser request meets.
 * `?unit=` narrows to one kind of credit, `?q=` searches people, `?holder=`
 * opens one person's ledger and fills the adjustment form with them.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  readonly searchParams: Promise<{ readonly unit?: string; readonly q?: string; readonly holder?: string }>;
}

const REASON_TONE = { grant: "ok", spend: "neutral", refund: "warn", adjust: "accent" } as const;

export default async function CreditsPage({ searchParams }: PageProps) {
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
  // Checked here as well as on every procedure: a page can be reached by a
  // route that doesn't sit under the admin layout.
  if (!can?.can("credits.balances.view")) {
    return (
      <>
        <Header />
        <p className="mt-4 text-sm text-ink-muted">You do not have permission to view credit balances.</p>
      </>
    );
  }

  const params = await searchParams;
  const caller = await api();
  const { units } = await caller.credits.units();
  const unit = units.find((candidate) => candidate === params.unit);
  const holder = typeof params.holder === "string" && params.holder.length <= 200 ? params.holder : undefined;
  const [{ rows }, { entries }] = await Promise.all([
    caller.credits.balances({ ...(unit ? { unit } : {}), ...(params.q ? { search: params.q } : {}), limit: 100 }),
    caller.credits.ledger({ ...(holder ? { holderId: holder } : {}), ...(unit ? { unit } : {}), limit: 50 }),
  ]);
  const canAdjust = can.can("credits.balances.adjust");
  const holderRow = holder ? rows.find((row) => row.holderId === holder) : undefined;

  return (
    <>
      <Header />

      {units.length === 0 ? (
        <EmptyState title="Nobody holds any credits yet">
          Give a product variant a Credits grant in the product builder; each
          purchase then adds to the buyer&rsquo;s balance here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Filter by unit">
            <FilterLink active={unit === undefined} href={hrefWith(params, { unit: undefined })}>
              All units
            </FilterLink>
            {units.map((candidate) => (
              <FilterLink key={candidate} active={unit === candidate} href={hrefWith(params, { unit: candidate })}>
                {candidate}
              </FilterLink>
            ))}
            <form className="ml-auto flex gap-2" action="/admin/credits">
              {unit ? <input type="hidden" name="unit" value={unit} /> : null}
              <label htmlFor="credits-q" className="sr-only">
                Search people
              </label>
              <input
                id="credits-q"
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Search by email or name"
                className="rounded-[--radius-card] border border-line bg-surface px-3 py-1.5 text-sm"
              />
            </form>
          </nav>

          <Card>
            <CardHeader title="Balances" hint="Largest first. A balance spent to zero still shows, as 0." />
            <CardBody>
              {rows.length === 0 ? (
                <p className="text-sm text-ink-muted">No balances match.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Who</TH>
                      <TH>Unit</TH>
                      <TH className="text-right">Balance</TH>
                      <TH className="text-right">Last moved</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row) => (
                      <TR key={`${row.holderId}:${row.unit}`}>
                        <TD>
                          <Link href={hrefWith(params, { holder: row.holderId })} className="text-accent underline-offset-2 hover:underline">
                            {row.email ?? row.holderId}
                          </Link>
                          {row.name ? <span className="block text-xs text-ink-muted">{row.name}</span> : null}
                        </TD>
                        <TD className="text-ink-muted">{row.unit}</TD>
                        <TD className="text-right tabular-nums">{creditsLabel(row.balance, row.unit)}</TD>
                        <TD className="text-right text-ink-muted">{row.updatedAt.toLocaleString("en-US")}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={holder ? `Ledger: ${holderRow?.email ?? holder}` : "Ledger"}
              hint="Every grant, spend, refund and adjustment, newest first."
              actions={
                holder ? (
                  <Link href={hrefWith(params, { holder: undefined })} className="text-sm text-accent">
                    Everyone
                  </Link>
                ) : undefined
              }
            />
            <CardBody>
              {entries.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing has moved yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>When</TH>
                      <TH>Who</TH>
                      <TH>What</TH>
                      <TH className="text-right">Change</TH>
                      <TH>Reference and note</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {entries.map((entry) => (
                      <TR key={entry.id}>
                        <TD className="whitespace-nowrap text-ink-muted">{entry.createdAt.toLocaleString("en-US")}</TD>
                        <TD>{entry.holderEmail ?? entry.holderId}</TD>
                        <TD>
                          <Badge tone={REASON_TONE[entry.reason]}>{entry.reason}</Badge>
                        </TD>
                        <TD className="text-right tabular-nums">
                          {entry.delta > 0 ? "+" : ""}
                          {creditsLabel(entry.delta, entry.unit)}
                        </TD>
                        <TD className="text-xs text-ink-muted">
                          <span className="font-mono">{entry.ref}</span>
                          {entry.note ? <span className="block">{entry.note}</span> : null}
                          {entry.actorEmail ? <span className="block">by {entry.actorEmail}</span> : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {canAdjust ? (
        <div className="mt-6">
          <AdjustCredits holderId={holder ?? ""} holderLabel={holderRow?.email ?? null} units={units} unit={unit ?? units[0] ?? ""} />
        </div>
      ) : null}
    </>
  );
}

function Header() {
  return (
    <PageHeader
      title="Credits"
      description="Balances a purchase put in people's accounts — packs of credits sold through the product builder's Credits grant — and every movement since."
    />
  );
}

function hrefWith(
  params: { readonly unit?: string; readonly q?: string; readonly holder?: string },
  change: { readonly unit?: string | undefined; readonly holder?: string | undefined },
): string {
  const next = new URLSearchParams();
  const merged = { ...params, ...change };
  for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
  const query = next.toString();
  return query ? `/admin/credits?${query}` : "/admin/credits";
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
