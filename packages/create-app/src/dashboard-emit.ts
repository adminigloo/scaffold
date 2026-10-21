import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * src/server/dashboard.ts — what a company's dashboard shows: the four numbers
 * (create-app 0.36, the showroom) — visits today, new leads, money owed and
 * money paid this week — and, under them (0.36.1), up to three short lists:
 * today's visits, the newest leads and the overdue invoices. Real figures
 * from the company's own rows, and only the ones this project has (a project
 * without invoicing has no "Money owed" and no overdue list) and this person
 * may see (none of either for someone who can't open Invoices).
 *
 * Generated rather than copied because which numbers and lists exist is a
 * question about which packages were installed, and an emitted file carrying
 * an `if` about a package it can't import is what the generator refuses to
 * write. Companies mode only: a single business has no company dashboard.
 *
 * THE DATABASE DOES THE ARITHMETIC. Counts and sums are SQL aggregates over
 * the company's own rows, and the lists come from the packages' own read
 * functions (the calendar, the estimates queue's search, the ledger's overdue
 * rule) wherever they have one; the code formats them in the company's
 * currency, locale and time zone. A part that can't be read (a table not
 * migrated yet) is left out, never shown as a zero that isn't true.
 *
 * EVERY READ IS THE COMPANY'S OWN: each one is given `tenantId` and filters
 * on it (the estimate lines, which carry no company, through a join to their
 * estimate). The project's isolation proof plants rows for two companies and
 * checks one's dashboard never shows the other's (feature-isolation.test.ts).
 */
export function renderDashboardNumbers(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const scope = answers.scope;
  const scheduling = answers.includeScheduling;
  const estimator = answers.includeEstimator;
  const invoicing = answers.includeInvoicing;
  const drizzle = [
    ...(estimator || invoicing ? ["and", "eq", "inArray"] : []),
    ...(estimator ? ["asc"] : []),
    ...(invoicing ? ["gt", "gte", "lt", "sql"] : []),
  ];
  const imports = [
    drizzle.length > 0 ? `import { ${[...new Set(drizzle)].sort().join(", ")} } from "drizzle-orm";` : null,
    scheduling ? `import { getSchedulingSettings, listCalendar, todayIn } from "${scope}/scheduling";` : null,
    estimator
      ? `import { estimatorEstimateItems, estimatorEstimates, formatMoney, searchEstimates, type EstimateListRow } from "${scope}/estimator";`
      : null,
    invoicing
      ? `import {
  endOfDayInZone,
  formatCents,
  invoicePayments,
  invoices,
  listOverdueInvoices,
  resolveInvoicingBusiness,
  todayInZone,
} from "${scope}/invoicing";`
      : null,
    scheduling || estimator || invoicing ? `import { db } from "@/db";` : null,
    invoicing ? `import { invoicingBusiness } from "@/server/invoicing";` : null,
  ].filter((line): line is string => line !== null);

  const blocks: string[] = [];
  if (scheduling) {
    blocks.push(`  // TODAY: the visits on today's calendar, in the ${noun}'s own time zone —
  // the count, and the day's first few as a list, from the one calendar read.
  if (can.includes("schedule.view")) {
    tasks.push(
      (async (): Promise<Piece> => {
        const settings = await getSchedulingSettings(db, tenantId);
        const today = todayIn(now, settings.timeZone);
        const calendar = await listCalendar(db, tenantId, { from: today, to: today }, { settings, now });
        const booked = calendar.visits.filter((visit) => BOOKED.has(visit.status));
        const visits = booked.length;
        const waiting = calendar.pending.length;
        const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: settings.timeZone });
        // The day in time order, as the owner reads a schedule; a finished
        // visit says "Done" in its place rather than moving to the bottom
        // (an 8:00 AM below a 4:00 PM read as a mistake).
        const shown = [...booked].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
        // The schedule opened on today's day, not wherever it was left.
        const todayHref = \`/app/schedule?date=\${today}&view=day\`;
        return {
          number: {
            key: "today",
            label: "Today",
            value: count(visits),
            detail: waiting > 0 ? \`\${visits === 1 ? "visit" : "visits"} · \${count(waiting)} waiting for your answer\` : visits === 1 ? "visit on the schedule" : "visits on the schedule",
            href: todayHref,
          },
          list: {
            key: "visits",
            title: "Today's visits",
            empty: "No visits today",
            href: todayHref,
            rows: shown.slice(0, DASHBOARD_LIST_ROWS).map((visit) => {
              const note = VISIT_NOTES[visit.status];
              return {
                id: visit.id,
                // The schedule opens this visit (?visit=): a visit has no page of its own.
                href: \`/app/schedule?visit=\${encodeURIComponent(visit.id)}\`,
                time: clock.format(new Date(visit.startsAt)),
                title: visit.customerName ?? "No name given",
                detail: visit.address ?? visit.serviceName,
                figure: visit.resourceName ?? "No crew yet",
                ...(note ? { note } : {}),
              };
            }),
          },
          busy: visits + waiting > 0,
          source: "the visits you book",
        };
      })(),
    );
  }`);
  }
  if (estimator) {
    blocks.push(`  // NEW LEADS: estimate requests nobody has answered yet — the Estimates
  // page's own "Leads", its count and its newest few, through the queue's search.
  if (can.includes("estimator.view")) {
    tasks.push(
      (async (): Promise<Piece> => {
        const found = await searchEstimates(db, tenantId, { filter: "leads", limit: DASHBOARD_LIST_ROWS });
        const leads = found.counts.leads;
        const asked = await askedFor(tenantId, found.rows.map((row) => row.id));
        return {
          number: {
            key: "leads",
            label: "New leads",
            value: count(leads),
            detail: leads === 1 ? "estimate request waiting for a quote" : "estimate requests waiting for a quote",
            href: "/app/estimates?filter=leads",
          },
          list: {
            key: "leads",
            title: "Newest leads",
            empty: "No new leads",
            // "See all" opens the Estimates page on Leads, the same list.
            href: "/app/estimates?filter=leads",
            rows: found.rows.map((row) => ({
              id: row.id,
              href: \`/app/estimates/\${encodeURIComponent(row.id)}\`,
              title: row.customerName || row.customerEmail || "No name yet",
              detail: asked.get(row.id) || row.number,
              figure: leadPrice(row, locale),
              note: ago(row.createdAt, now, locale),
            })),
          },
          busy: leads > 0,
          source: "estimate requests from your website",
        };
      })(),
    );
  }`);
  }
  if (invoicing) {
    blocks.push(`  // MONEY OWED, PAID THIS WEEK and the OVERDUE INVOICES: the ledger's own
  // figures and its own overdue rule (past due, money still owed), in the
  // ${noun}'s currency and time zone.
  if (can.includes("invoices.view")) {
    const business = invoicingBusiness(tenantId).then(resolveInvoicingBusiness);
    const money = async (cents: number) => formatCents(cents, (await business).currency, locale);
    tasks.push(
      (async (): Promise<Piece> => {
        const [row] = await db
          .select({
            owed: sql<number>\`coalesce(sum(\${invoices.total} - \${invoices.amountPaid}), 0)::bigint\`,
            open: sql<number>\`count(*)::int\`,
            // The overdue list's own rule, so the count and the list agree.
            overdue: sql<number>\`count(*) filter (where \${and(lt(invoices.dueDate, now), gt(invoices.total, invoices.amountPaid))})::int\`,
          })
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.status, ["sent", "viewed", "partial"])));
        const open = Number(row?.open ?? 0);
        const overdue = Number(row?.overdue ?? 0);
        return {
          number: {
            key: "owed",
            label: "Money owed",
            value: await money(Number(row?.owed ?? 0)),
            detail:
              open === 0
                ? "nothing outstanding"
                : \`\${count(open)} open \${open === 1 ? "invoice" : "invoices"}\${overdue > 0 ? \` · \${count(overdue)} overdue\` : ""}\`,
            href: "/app/invoices",
          },
          busy: open > 0,
          source: "the invoices you send",
        };
      })(),
      (async (): Promise<Piece> => {
        const since = startOfWeek(now, (await business).timeZone);
        const [row] = await db
          .select({ paid: sql<number>\`coalesce(sum(\${invoicePayments.amount}), 0)::bigint\`, payments: sql<number>\`count(*) filter (where \${invoicePayments.amount} > 0)::int\` })
          .from(invoicePayments)
          .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
          .where(and(eq(invoices.tenantId, tenantId), gte(invoicePayments.paidAt, since)));
        const payments = Number(row?.payments ?? 0);
        return {
          number: {
            key: "paid",
            label: "Paid this week",
            value: await money(Number(row?.paid ?? 0)),
            detail: payments === 0 ? "since Monday" : \`\${count(payments)} \${payments === 1 ? "payment" : "payments"} since Monday\`,
            href: "/app/invoices",
          },
          busy: payments > 0,
          source: "the invoices you send",
        };
      })(),
      (async (): Promise<Piece> => {
        const { currency, timeZone } = await business;
        // Every overdue invoice, however long ago it fell due — the most
        // overdue first — and the first few of them.
        const found = await listOverdueInvoices(db, tenantId, { now, timeZone, dueSince: "2000-01-01", limit: DASHBOARD_LIST_ROWS });
        const today = todayInZone(now, timeZone);
        return {
          list: {
            key: "overdue",
            title: "Overdue invoices",
            empty: "No overdue invoices",
            // "See all" opens the ledger on Overdue, never the whole ledger.
            href: "/app/invoices?status=overdue",
            rows: found.map((invoice) => {
              // Days on the ${noun}'s own calendar since the day it was due.
              const late = Math.max(1, daysBetween(todayInZone(invoice.dueDate, timeZone), today));
              return {
                id: invoice.id,
                href: \`/app/invoices/\${encodeURIComponent(invoice.id)}\`,
                title: invoice.customerName ?? "No name given",
                detail: invoice.number,
                figure: formatCents(invoice.balanceDue, currency, locale),
                note: late === 1 ? "1 day overdue" : \`\${count(late)} days overdue\`,
                tone: "danger" as const,
              };
            }),
          },
          busy: found.length > 0,
        };
      })(),
    );
  }`);
  }

  const helpers: string[] = [];
  if (scheduling) {
    helpers.push(`
/** A visit that is on today's schedule (requests are counted apart). */
const BOOKED: ReadonlySet<string> = new Set(["confirmed", "in_progress", "completed"]);

/** How a visit on today's list stands, when it isn't simply booked. */
const VISIT_NOTES: Readonly<Record<string, string>> = { in_progress: "Under way", completed: "Done" };
`);
  }
  if (estimator) {
    helpers.push(`
/**
 * What each lead asked for, in its own lines: the first line's name, then
 * "+ 2 more". Read for these estimates only and only as this ${noun}'s — a
 * line carries no ${noun} of its own, so the join to its estimate is the scope.
 */
async function askedFor(tenantId: string, estimateIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  if (estimateIds.length === 0) return new Map();
  const lines = await db
    .select({ estimateId: estimatorEstimateItems.estimateId, description: estimatorEstimateItems.description })
    .from(estimatorEstimateItems)
    .innerJoin(estimatorEstimates, eq(estimatorEstimates.id, estimatorEstimateItems.estimateId))
    .where(and(eq(estimatorEstimates.tenantId, tenantId), inArray(estimatorEstimateItems.estimateId, [...estimateIds])))
    .orderBy(asc(estimatorEstimateItems.sortOrder), asc(estimatorEstimateItems.id));
  const names = new Map<string, string[]>();
  for (const line of lines) names.set(line.estimateId, [...(names.get(line.estimateId) ?? []), line.description]);
  return new Map([...names].map(([id, all]) => [id, all.length > 1 ? \`\${all[0]} + \${all.length - 1} more\` : (all[0] ?? "")]));
}

/**
 * A lead's price as the Estimates page shows it: the range the customer was
 * shown (in whole units), or its one price when there's no range; "Needs a
 * price" while nothing on it is priced (a product priced by a person).
 */
function leadPrice(row: EstimateListRow, locale: string): string {
  const format = { currency: row.currency, locale };
  if (row.rangeHigh === 0 && row.total === 0) return "Needs a price";
  return row.rangeLow !== row.rangeHigh
    ? \`\${formatMoney(row.rangeLow, format, true)} – \${formatMoney(row.rangeHigh, format, true)}\`
    : formatMoney(row.total, format);
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "4 days ago": how long since, in the ${noun}'s locale. */
function ago(at: string, now: Date, locale: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return words.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? words.format(-hours, "hour") : words.format(-Math.floor(hours / 24), "day");
}
`);
  }
  if (invoicing) {
    helpers.push(`
/** Monday 00:00 of this week, in the ${noun}'s own time zone. */
function startOfWeek(now: Date, timeZone: string): Date {
  const today = todayInZone(now, timeZone);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const sunday = new Date(Date.UTC(y, m - 1, d - ((weekday + 6) % 7) - 1)).toISOString().slice(0, 10);
  return new Date(endOfDayInZone(sunday, timeZone).getTime() + 1);
}

/** Whole calendar days from one "YYYY-MM-DD" to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(\`\${to}T00:00:00Z\`) - Date.parse(\`\${from}T00:00:00Z\`)) / 86_400_000);
}
`);
  }

  const body =
    blocks.length > 0
      ? `  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const tasks: Promise<Piece>[] = [];
${blocks.join("\n")}
  // A part that can't be read is left out; the rest still show.
  const pieces = (await Promise.allSettled(tasks)).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const fresh = pieces.length > 0 && pieces.every((piece) => !piece.busy);
  const sources = [...new Set(pieces.flatMap((piece) => (piece.source ? [piece.source] : [])))];
  return {
    numbers: pieces.flatMap((piece) => (piece.number ? [piece.number] : [])),
    lists: pieces.flatMap((piece) => (piece.list ? [piece.list] : [])),
    fresh,
    hint: fresh ? \`Your numbers fill in as work comes in: \${sentence(sources)}.\` : null,
  };`
      : `  // This project has none of the features a number comes from (scheduling,
  // the estimator, invoicing), so the dashboard shows the setup list and the
  // ${noun}'s page only.
  void tenantId;
  void can;
  void locale;
  void now;
  return { numbers: [], lists: [], fresh: false, hint: null };`;

  const pieceTypes =
    blocks.length > 0
      ? `
/** One read's part of the dashboard: a number, a list or both, whether it found any work, and where that work comes from. */
interface Piece {
  readonly number?: DashboardNumber;
  readonly list?: DashboardList;
  readonly busy: boolean;
  readonly source?: string;
}

/** "a", "a and b", "a, b and c". */
function sentence(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : \`\${parts.slice(0, -1).join(", ")} and \${parts[parts.length - 1]}\`;
}
`
      : "";

  return `${imports.join("\n")}${imports.length > 0 ? "\n" : ""}
/** Where a crew member's dashboard sends them: their day's route${scheduling ? "" : " — none in a project without scheduling"}. */
export const CREW_HOME: string | null = ${scheduling ? '"/app/schedule/today"' : "null"};

/** The most lines one dashboard list shows; its "See all" page has the rest. */
export const DASHBOARD_LIST_ROWS = 5;

/** One figure on the dashboard: what it is, the number, a line under it, and where it goes. */
export interface DashboardNumber {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href: string;
}

/** One line of a dashboard list, every word of it written here and formatted for the ${noun}. */
export interface DashboardRow {
  readonly id: string;
  /** Where the line opens: the visit, the estimate, the invoice. */
  readonly href: string;
  /** A short first column, when the list has one: a visit's time. */
  readonly time?: string;
  /** Who: the customer. */
  readonly title: string;
  /** What or where: the address, what they asked for, the invoice's number. */
  readonly detail: string;
  /** On the right: the crew, the price, the amount still owed. */
  readonly figure: string;
  /** Under it: how long ago, how late, or how the visit stands. */
  readonly note?: string;
  /** The note is a problem (days overdue). */
  readonly tone?: "danger";
}

/** A short list under the numbers: its title, its lines, the one quiet line it shows empty, and the page with all of them. */
export interface DashboardList {
  readonly key: string;
  readonly title: string;
  readonly empty: string;
  readonly href: string;
  readonly rows: readonly DashboardRow[];
}

/** Everything the dashboard shows from the ${noun}'s own rows. */
export interface DashboardOverview {
  /** Today, New leads, Money owed, Paid this week — those this project has and this person may open. */
  readonly numbers: readonly DashboardNumber[];
  /** Today's visits, Newest leads, Overdue invoices — the same way. */
  readonly lists: readonly DashboardList[];
  /**
   * Nothing to count yet in anything this person can see: a brand-new
   * ${noun}, whose page leads with its setup list, open.
   */
  readonly fresh: boolean;
  /** For a fresh ${noun}: one plain sentence on what fills these in. Null otherwise. */
  readonly hint: string | null;
}
${pieceTypes}${helpers.join("")}
/**
 * The ${noun}'s dashboard: its numbers in this order — Today, New leads,
 * Money owed, Paid this week — and its lists — Today's visits, Newest leads,
 * Overdue invoices — each only when this project has the feature and the
 * person may open it (\`can\`, their permissions in this ${noun}). Money in the
 * ${noun}'s currency; counts, money and times in its \`locale\`; "today" and
 * "this week" on its own calendar.
 */
export async function dashboardOverview(
  tenantId: string,
  can: readonly string[],
  locale: string,
  now: Date = new Date(),
): Promise<DashboardOverview> {
${body}
}

/** The numbers alone: create-app 0.36's call, kept for a page written against it. */
export async function dashboardNumbers(
  tenantId: string,
  can: readonly string[],
  locale: string,
  now: Date = new Date(),
): Promise<readonly DashboardNumber[]> {
  return (await dashboardOverview(tenantId, can, locale, now)).numbers;
}
`;
}

/** Is there a dashboard to put the numbers on? */
export function hasDashboard(answers: Answers): boolean {
  return companiesMode(answers);
}
