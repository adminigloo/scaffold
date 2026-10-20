import Link from "next/link";
import type { ReactNode } from "react";
import { StatCard, cx } from "@/components/ui";
import type { DashboardList, DashboardOverview, DashboardRow } from "@/server/dashboard";

/** The stat cards' shape, so a list under them is the same card. */
const CARD = "rounded-[--radius-card] border border-line bg-surface shadow-card";

/**
 * The dashboard's body (create-app 0.36.1), drawn from what
 * src/server/dashboard.ts read — every word and figure arrives finished:
 *
 *   - THE SETUP CARD (`setup`), while the owner has something left: one line
 *     above the numbers ("2 things left to set up"), opening into the list;
 *     open from the start on a brand-new __TENANT_LABEL_LOWER__'s page.
 *   - THE NUMBERS, always: zeros on a brand-new __TENANT_LABEL_LOWER__'s page,
 *     with one plain sentence on what fills them in.
 *   - UP TO THREE SHORT LISTS under them — today's visits, the newest leads,
 *     the overdue invoices — each at most five lines with "See all", and one
 *     quiet line when it's empty. Two columns from lg, one on a phone.
 *
 * Server-rendered and stateless: the lists are links, nothing more.
 */
export function DashboardBody({ overview, setup }: { readonly overview: DashboardOverview; readonly setup?: ReactNode }) {
  const { numbers, lists, hint } = overview;
  // Two columns from lg: the first list on the left (today's visits, the
  // longest on a working day), the others stacked on the right — so a third
  // list sits beside the first, not alone under it. One column on a phone,
  // in the same order.
  const [first, ...rest] = lists;
  return (
    <div className="grid gap-6" data-dashboard="">
      {setup ? <div data-dashboard-setup="">{setup}</div> : null}
      {numbers.length > 0 ? (
        <section aria-label="At a glance" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-dashboard-numbers="">
          {numbers.map((number) => (
            <StatCard key={number.key} label={number.label} value={number.value} detail={number.detail} href={number.href} />
          ))}
        </section>
      ) : null}
      {hint ? (
        <p className="-mt-2 max-w-[68ch] text-sm leading-relaxed text-ink-muted" data-dashboard-hint="">
          {hint}
        </p>
      ) : null}
      {first ? (
        <div className="grid items-start gap-4 lg:grid-cols-2" data-dashboard-lists="">
          <ListCard list={first} />
          {rest.length > 0 ? (
            <div className="grid gap-4">
              {rest.map((list) => (
                <ListCard key={list.key} list={list} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ListCard({ list }: { readonly list: DashboardList }) {
  const headingId = `dashboard-${list.key}`;
  return (
    <section aria-labelledby={headingId} className={cx(CARD, "overflow-hidden")} data-dashboard-list={list.key}>
      <header className="flex items-center justify-between gap-3 border-b border-line pl-5 pr-3">
        <h2 id={headingId} className="py-3 text-sm font-semibold tracking-tight text-ink">
          {list.title}
        </h2>
        <Link
          href={list.href}
          className="inline-flex min-h-11 shrink-0 items-center rounded-[--radius-control] px-2 text-sm font-medium text-accent no-underline underline-offset-2 hover:underline"
        >
          See all
          <span className="sr-only"> {list.title.toLowerCase()}</span>
          <span aria-hidden="true">&nbsp;→</span>
        </Link>
      </header>
      {list.rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">{list.empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.rows.map((row) => (
            <li key={row.id}>
              <Line row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One line: [time] who / what or where — and on the right, the figure / the note. The whole line opens the record. */
function Line({ row }: { readonly row: DashboardRow }) {
  return (
    <Link
      href={row.href}
      className="flex min-h-11 items-start gap-3 px-5 py-3 no-underline transition-colors hover:bg-canvas focus-visible:bg-canvas focus-visible:-outline-offset-2"
    >
      {row.time ? <span className="w-[4.5rem] shrink-0 text-sm font-semibold tabular-nums text-ink">{row.time}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{row.title}</span>
        <span className="mt-0.5 block truncate text-sm text-ink-muted">{row.detail}</span>
      </span>
      <span className="max-w-[45%] shrink-0 text-right">
        <span className="block truncate text-sm font-medium tabular-nums text-ink">{row.figure}</span>
        {row.note ? (
          <span className={cx("mt-0.5 block truncate text-sm", row.tone === "danger" ? "text-danger" : "text-ink-muted")}>{row.note}</span>
        ) : null}
      </span>
    </Link>
  );
}
