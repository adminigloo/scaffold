import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * src/server/dashboard.ts — the four numbers a company's dashboard shows once
 * its setup is done (create-app 0.36, the showroom): visits today, new leads,
 * money owed and money paid this week. Real figures from the company's own
 * rows, and only the ones this project has (a project without invoicing has
 * no "Money owed") and this person may see (no "Money owed" for someone who
 * can't open Invoices).
 *
 * Generated rather than copied because which numbers exist is a question
 * about which packages were installed, and an emitted file carrying an `if`
 * about a package it can't import is what the generator refuses to write.
 * Companies mode only: a single business has no company dashboard.
 *
 * THE DATABASE DOES THE ARITHMETIC. Counts and sums are SQL aggregates over
 * the company's own rows; the code formats them in the company's currency and
 * locale. A number that can't be read (a table not migrated yet) is left out,
 * never shown as a zero that isn't true.
 */
export function renderDashboardNumbers(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const scope = answers.scope;
  const scheduling = answers.includeScheduling;
  const estimator = answers.includeEstimator;
  const invoicing = answers.includeInvoicing;
  const drizzle = [
    ...(estimator || invoicing ? ["and", "eq"] : []),
    ...(invoicing ? ["gte", "inArray"] : []),
    ...(estimator ? ["isNull", "ne"] : []),
    ...(estimator || invoicing ? ["sql"] : []),
  ];
  const imports = [
    drizzle.length > 0 ? `import { ${[...new Set(drizzle)].sort().join(", ")} } from "drizzle-orm";` : null,
    scheduling ? `import { getSchedulingSettings, listCalendar, todayIn } from "${scope}/scheduling";` : null,
    estimator ? `import { estimatorEstimates } from "${scope}/estimator";` : null,
    invoicing
      ? `import { endOfDayInZone, formatCents, invoicePayments, invoices, resolveInvoicingBusiness, todayInZone } from "${scope}/invoicing";`
      : null,
    scheduling || estimator || invoicing ? `import { db } from "@/db";` : null,
    invoicing ? `import { invoicingBusiness } from "@/server/invoicing";` : null,
  ].filter((line): line is string => line !== null);

  const blocks: string[] = [];
  if (scheduling) {
    blocks.push(`  // TODAY: the visits on today's calendar, in the ${noun}'s own time zone.
  if (can.includes("schedule.view")) {
    tasks.push(
      (async (): Promise<DashboardNumber> => {
        const settings = await getSchedulingSettings(db, tenantId);
        const today = todayIn(now, settings.timeZone);
        const calendar = await listCalendar(db, tenantId, { from: today, to: today }, { settings, now });
        const visits = calendar.visits.filter((visit) => BOOKED.has(visit.status)).length;
        const waiting = calendar.pending.length;
        return {
          key: "today",
          label: "Today",
          value: count(visits),
          detail: waiting > 0 ? \`\${visits === 1 ? "visit" : "visits"} · \${count(waiting)} waiting for your answer\` : visits === 1 ? "visit on the schedule" : "visits on the schedule",
          href: "/app/schedule",
        };
      })(),
    );
  }`);
  }
  if (estimator) {
    blocks.push(`  // NEW LEADS: estimate requests from the website nobody has answered yet.
  if (can.includes("estimator.view")) {
    tasks.push(
      (async (): Promise<DashboardNumber> => {
        const [row] = await db
          .select({ leads: sql<number>\`count(*)::int\` })
          .from(estimatorEstimates)
          .where(
            and(
              eq(estimatorEstimates.tenantId, tenantId),
              eq(estimatorEstimates.status, "draft"),
              ne(estimatorEstimates.source, "staff"),
              isNull(estimatorEstimates.archivedAt),
            ),
          );
        const leads = Number(row?.leads ?? 0);
        return {
          key: "leads",
          label: "New leads",
          value: count(leads),
          detail: leads === 1 ? "estimate request waiting for a quote" : "estimate requests waiting for a quote",
          href: "/app/estimates",
        };
      })(),
    );
  }`);
  }
  if (invoicing) {
    blocks.push(`  // MONEY OWED and PAID THIS WEEK: the ledger's own figures, in the ${noun}'s currency.
  if (can.includes("invoices.view")) {
    const business = invoicingBusiness(tenantId).then(resolveInvoicingBusiness);
    const money = async (cents: number) => formatCents(cents, (await business).currency, locale);
    tasks.push(
      (async (): Promise<DashboardNumber> => {
        const [row] = await db
          .select({
            owed: sql<number>\`coalesce(sum(\${invoices.total} - \${invoices.amountPaid}), 0)::bigint\`,
            open: sql<number>\`count(*)::int\`,
            overdue: sql<number>\`count(*) filter (where \${invoices.dueDate} < now())::int\`,
          })
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.status, ["sent", "viewed", "partial"])));
        const open = Number(row?.open ?? 0);
        const overdue = Number(row?.overdue ?? 0);
        return {
          key: "owed",
          label: "Money owed",
          value: await money(Number(row?.owed ?? 0)),
          detail:
            open === 0
              ? "nothing outstanding"
              : \`\${count(open)} open \${open === 1 ? "invoice" : "invoices"}\${overdue > 0 ? \` · \${count(overdue)} overdue\` : ""}\`,
          href: "/app/invoices",
        };
      })(),
      (async (): Promise<DashboardNumber> => {
        const since = startOfWeek(now, (await business).timeZone);
        const [row] = await db
          .select({ paid: sql<number>\`coalesce(sum(\${invoicePayments.amount}), 0)::bigint\`, payments: sql<number>\`count(*) filter (where \${invoicePayments.amount} > 0)::int\` })
          .from(invoicePayments)
          .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
          .where(and(eq(invoices.tenantId, tenantId), gte(invoicePayments.paidAt, since)));
        const payments = Number(row?.payments ?? 0);
        return {
          key: "paid",
          label: "Paid this week",
          value: await money(Number(row?.paid ?? 0)),
          detail: payments === 0 ? "since Monday" : \`\${count(payments)} \${payments === 1 ? "payment" : "payments"} since Monday\`,
          href: "/app/invoices",
        };
      })(),
    );
  }`);
  }

  const booked = scheduling
    ? `
/** A visit that is on today's schedule (requests are counted apart). */
const BOOKED: ReadonlySet<string> = new Set(["confirmed", "in_progress", "completed"]);
`
    : "";
  const helpers = invoicing
    ? `
/** Monday 00:00 of this week, in the ${noun}'s own time zone. */
function startOfWeek(now: Date, timeZone: string): Date {
  const today = todayInZone(now, timeZone);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const sunday = new Date(Date.UTC(y, m - 1, d - ((weekday + 6) % 7) - 1)).toISOString().slice(0, 10);
  return new Date(endOfDayInZone(sunday, timeZone).getTime() + 1);
}
`
    : "";

  const body =
    blocks.length > 0
      ? `  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const tasks: Promise<DashboardNumber>[] = [];
${blocks.join("\n")}
  // One number that can't be read is left out; the rest still show.
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));`
      : `  // This project has none of the features a number comes from (scheduling,
  // the estimator, invoicing), so the dashboard shows the setup list and the
  // ${noun}'s page only.
  void tenantId;
  void can;
  void locale;
  void now;
  return [];`;

  return `${imports.join("\n")}${imports.length > 0 ? "\n" : ""}
/** Where a crew member's dashboard sends them: their day's route${scheduling ? "" : " — none in a project without scheduling"}. */
export const CREW_HOME: string | null = ${scheduling ? '"/app/schedule/today"' : "null"};

/** One figure on the dashboard: what it is, the number, a line under it, and where it goes. */
export interface DashboardNumber {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly href: string;
}
${booked}${helpers}
/**
 * The ${noun}'s numbers for its dashboard, in this order: Today, New leads,
 * Money owed, Paid this week — each only when this project has the feature
 * and the person may open it (\`can\`, their permissions in this ${noun}).
 * Money in the ${noun}'s currency, counts and money in its \`locale\`.
 */
export async function dashboardNumbers(
  tenantId: string,
  can: readonly string[],
  locale: string,
  now: Date = new Date(),
): Promise<readonly DashboardNumber[]> {
${body}
}
`;
}

/** Is there a dashboard to put the numbers on? */
export function hasDashboard(answers: Answers): boolean {
  return companiesMode(answers);
}
