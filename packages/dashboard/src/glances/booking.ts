import { and, asc, count, eq, gte, inArray, lt } from "drizzle-orm";
import { addDays, dateIn, startOfDayIn } from "@adminigloo/booking";
import { bookingBookings, bookingTypes, type BookingStatus } from "@adminigloo/booking/schema";
import { plural, type Glance, type GlanceRow } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/booking: this company's own calls. Every
 * query is scoped to `tenantId`. No spark here (not asked for): a booking
 * count is naturally small, and a 14-day bar chart of appointment volume
 * says less than the count itself.
 */
export interface CallsGlanceInput {
  readonly db: DashboardDb;
  readonly tenantId: string;
  readonly now: Date;
  /**
   * What counts as "today" for the first tile, in this zone — there is no
   * single company-wide zone stored anywhere (a host's own zone is on
   * `bookingHosts.timezone`, copied onto each booking), so this is the
   * caller's own. Default UTC. Each LISTED call's own time uses that
   * booking's `hostTimezone` instead (see `formatCallTime`), since two
   * hosts on one company's calendar can sit in different zones.
   */
  readonly timeZone?: string;
  readonly href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const NEXT_CALLS_LIMIT = 5;

/** A call is really on the books in one of these — never 'hold' (a ten-minute claim mid-flow) or 'cancelled'. */
const TODAY_STATUSES: BookingStatus[] = ["requested", "confirmed", "completed", "no_show"];
/** Still ahead of us: requested or confirmed, not yet resolved either way. */
const LIVE_STATUSES: BookingStatus[] = ["requested", "confirmed"];

interface NextCallRow {
  startUtc: Date;
  hostTimezone: string;
  status: BookingStatus;
  inviteeName: string | null;
  typeName: string | null;
}

/** "Thu, Nov 20, 2:00 PM", in the call's own host's zone. */
function formatCallTime(startUtc: Date, hostTimezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: hostTimezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(startUtc);
  } catch {
    return startUtc.toISOString();
  }
}

function rowOf(call: NextCallRow, href: string): GlanceRow {
  return {
    title: call.inviteeName?.trim() || call.typeName || "Call",
    meta: formatCallTime(call.startUtc, call.hostTimezone),
    badge: call.status === "requested" ? "Needs confirmation" : undefined,
    tone: call.status === "requested" ? "warn" : undefined,
    href,
  };
}

export async function callsGlance(input: CallsGlanceInput): Promise<Glance> {
  const { db, tenantId, now } = input;
  const href = input.href ?? "/app/calls";
  const timeZone = input.timeZone ?? "UTC";

  const today = dateIn(now, timeZone);
  const todayStart = startOfDayIn(today, timeZone);
  const todayEnd = startOfDayIn(addDays(today, 1), timeZone);
  const weekEnd = new Date(now.getTime() + WEEK_DAYS * DAY_MS);

  const forTenant = eq(bookingBookings.tenantId, tenantId);

  const [todayRows, upcomingRows, waitingRows, nextCalls] = await Promise.all([
    db
      .select({ n: count() })
      .from(bookingBookings)
      .where(and(forTenant, inArray(bookingBookings.status, TODAY_STATUSES), gte(bookingBookings.startUtc, todayStart), lt(bookingBookings.startUtc, todayEnd))),
    db
      .select({ n: count() })
      .from(bookingBookings)
      .where(and(forTenant, inArray(bookingBookings.status, LIVE_STATUSES), gte(bookingBookings.startUtc, now), lt(bookingBookings.startUtc, weekEnd))),
    db
      .select({ n: count() })
      .from(bookingBookings)
      .where(and(forTenant, eq(bookingBookings.status, "requested"))),
    db
      .select({
        startUtc: bookingBookings.startUtc,
        hostTimezone: bookingBookings.hostTimezone,
        status: bookingBookings.status,
        inviteeName: bookingBookings.inviteeName,
        typeName: bookingTypes.name,
      })
      .from(bookingBookings)
      .leftJoin(bookingTypes, and(eq(bookingTypes.id, bookingBookings.typeId), eq(bookingTypes.tenantId, tenantId)))
      .where(and(forTenant, inArray(bookingBookings.status, LIVE_STATUSES), gte(bookingBookings.startUtc, now)))
      .orderBy(asc(bookingBookings.startUtc), asc(bookingBookings.id))
      .limit(NEXT_CALLS_LIMIT),
  ]);

  const todayCount = todayRows[0]?.n ?? 0;
  const upcomingCount = upcomingRows[0]?.n ?? 0;
  const waitingCount = waitingRows[0]?.n ?? 0;

  return {
    status:
      waitingCount > 0
        ? { text: `${plural(waitingCount, "call")} waiting for your response.`, tone: "warn" }
        : todayCount > 0
          ? { text: `${plural(todayCount, "call")} today.`, tone: "neutral" }
          : { text: "No calls today.", tone: "good" },
    attention: waitingCount,
    tiles: [
      { label: "Today", value: todayCount, href },
      { label: "Next 7 days", value: upcomingCount, href },
      { label: "Needs a response", value: waitingCount, href, tone: waitingCount > 0 ? "warn" : "good" },
    ],
    list: {
      title: "Next calls",
      empty: "No calls on the books.",
      rows: nextCalls.map((call) => rowOf(call, href)),
    },
    link: { href, label: "Open calls" },
  };
}
