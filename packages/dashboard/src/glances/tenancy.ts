import { and, count, countDistinct, desc, eq, gte, isNotNull, isNull, ne } from "drizzle-orm";
import { users } from "@adminigloo/auth/schema";
import { staffInvitations, tenantInvitations, tenants } from "@adminigloo/tenancy/schema";
import { FIRM_WIDE } from "@adminigloo/permissions";
import { principalRole } from "@adminigloo/permissions/schema";
import { ago, daySeries, plural, type Glance } from "../glance.js";
import { BY_FIRST_COLUMN, dayOf } from "../glance-sql.js";
import type { DashboardDb } from "../handlers.js";

/**
 * Glances over @adminigloo/tenancy: every company and every person, across
 * the whole platform. These mirror the operator's companies console and
 * People screen (and the counts the generated admin dashboard used before
 * glances existed), so neither function takes a tenantId — there is no
 * "one company" version of "how many companies are there".
 */
export interface TenancyGlanceInput {
  readonly db: DashboardDb;
  readonly now: Date;
  /** Only peopleGlance's spark uses this. Default UTC. */
  readonly timeZone?: string;
  /** The full page. */
  readonly href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SPARK_DAYS = 14;
const NEW_COMPANY_WINDOW_DAYS = 30;
const NEW_PERSON_WINDOW_DAYS = 7;

/**
 * Companies: how many, how many are new, how many are suspended, and what is
 * still waiting to be accepted.
 *
 * CUSTOMER COMPANIES ONLY. A personal workspace is minted for every signed-in
 * user and outnumbers real customers by an order of magnitude; counting them
 * would make this a sign-up counter wearing the wrong label (the same rule
 * the generated admin dashboard's "Companies" tile followed).
 */
export async function companiesGlance(input: TenancyGlanceInput): Promise<Glance> {
  const { db, now } = input;
  const href = input.href ?? "/admin/companies";
  const since = new Date(now.getTime() - NEW_COMPANY_WINDOW_DAYS * DAY_MS);
  const notPersonal = ne(tenants.kind, "personal");

  const [totalRows, freshRows, suspendedRows, openInviteRows, latest] = await Promise.all([
    db.select({ n: count() }).from(tenants).where(notPersonal),
    db.select({ n: count() }).from(tenants).where(and(notPersonal, gte(tenants.createdAt, since))),
    db.select({ n: count() }).from(tenants).where(and(notPersonal, isNotNull(tenants.suspendedAt))),
    // Expired-but-unaccepted invitations are counted too, on purpose: one that
    // quietly timed out is still a person waiting to be let in.
    db
      .select({ n: count() })
      .from(tenantInvitations)
      .where(and(isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt))),
    db
      .select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt, suspendedAt: tenants.suspendedAt })
      .from(tenants)
      .where(notPersonal)
      .orderBy(desc(tenants.createdAt))
      .limit(6),
  ]);

  const total = totalRows[0]?.n ?? 0;
  const fresh = freshRows[0]?.n ?? 0;
  const suspended = suspendedRows[0]?.n ?? 0;
  const openInvitations = openInviteRows[0]?.n ?? 0;
  const companiesHref = `${href}?kind=org`;

  return {
    status:
      suspended > 0
        ? { text: `${plural(suspended, "company", "companies")} suspended.`, tone: "warn" }
        : fresh > 0
          ? { text: `${plural(fresh, "new company", "new companies")} in the last ${NEW_COMPANY_WINDOW_DAYS} days.`, tone: "good" }
          : { text: "No new companies in the last 30 days.", tone: "neutral" },
    tiles: [
      {
        label: "Companies",
        value: total,
        href: companiesHref,
        hint: "Customer companies. Personal workspaces are not counted.",
      },
      {
        label: "New, 30 days",
        value: fresh,
        href: companiesHref,
        hint: "Created in the last 30 days.",
      },
      {
        label: "Suspended",
        value: suspended,
        href: `${companiesHref}&status=suspended`,
        tone: suspended > 0 ? "warn" : undefined,
        hint: "Blocked from signing in, kept for the record.",
      },
      {
        label: "Open invitations",
        value: openInvitations,
        href,
        tone: openInvitations > 0 ? "warn" : undefined,
        hint: "Sent, not accepted, not withdrawn.",
      },
    ],
    list: {
      title: "Newest",
      empty: "No companies yet.",
      rows: latest.map((row) => ({
        title: row.name,
        meta: ago(row.createdAt, now),
        badge: row.suspendedAt ? "Suspended" : undefined,
        tone: row.suspendedAt ? "warn" : undefined,
        href: `/admin/companies/${row.id}`,
      })),
    },
    link: { href, label: "Open companies" },
  };
}

/**
 * People: everyone with an account, who is new, who holds a staff role, and
 * who is still waiting to claim a staff invitation.
 *
 * STAFF ROLES ARE NOT A TENANCY TABLE. They are rows of `principal_role`
 * (scope 'staff', the firm-wide '*'), owned by @adminigloo/permissions, which
 * every app with a staff panel has.
 */
export async function peopleGlance(input: TenancyGlanceInput): Promise<Glance> {
  const { db, now } = input;
  const href = input.href ?? "/admin/people";
  const timeZone = input.timeZone ?? "UTC";
  const since = new Date(now.getTime() - NEW_PERSON_WINDOW_DAYS * DAY_MS);
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * DAY_MS);
  const notDeleted = isNull(users.deletedAt);

  const [totalRows, freshRows, staff, pendingRows, perDay, latest] = await Promise.all([
    db.select({ n: count() }).from(users).where(notDeleted),
    db.select({ n: count() }).from(users).where(and(notDeleted, gte(users.createdAt, since))),
    staffCount(db),
    db
      .select({ n: count() })
      .from(staffInvitations)
      .where(and(isNull(staffInvitations.claimedAt), isNull(staffInvitations.revokedAt))),
    db
      .select({ day: dayOf(users.createdAt, timeZone), n: count() })
      .from(users)
      .where(and(notDeleted, gte(users.createdAt, sparkFrom)))
      .groupBy(BY_FIRST_COLUMN),
    db
      .select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt })
      .from(users)
      .where(notDeleted)
      .orderBy(desc(users.createdAt))
      .limit(6),
  ]);

  const total = totalRows[0]?.n ?? 0;
  const fresh = freshRows[0]?.n ?? 0;
  const pending = pendingRows[0]?.n ?? 0;

  return {
    status:
      pending > 0
        ? { text: `${plural(pending, "staff invitation")} still open.`, tone: "neutral" }
        : fresh > 0
          ? { text: `${plural(fresh, "new sign-up")} in the last ${NEW_PERSON_WINDOW_DAYS} days.`, tone: "good" }
          : { text: "No new sign-ups in the last 7 days.", tone: "neutral" },
    tiles: [
      { label: "People", value: total, href, hint: "Everyone with an account." },
      { label: "New, 7 days", value: fresh, href, hint: "Signed up in the last 7 days." },
      {
        label: "Staff",
        value: staff,
        href: `${href}?staffOnly=true`,
        hint: "Hold a staff role on this platform.",
      },
      {
        label: "Pending invites",
        value: pending,
        href,
        tone: pending > 0 ? "warn" : undefined,
        hint: "A staff role waiting for someone to sign up.",
      },
    ],
    spark: { label: "Sign-ups by day", points: daySeries(perDay, SPARK_DAYS, now, timeZone) },
    list: {
      title: "Newest",
      empty: "No one has signed up yet.",
      rows: latest.map((row) => ({
        title: row.displayName ?? row.email ?? "Someone with no name yet",
        meta: ago(row.createdAt, now),
        href,
      })),
    },
    link: { href, label: "Open people" },
  };
}

async function staffCount(db: DashboardDb): Promise<number> {
  const rows = await db
    .select({ n: countDistinct(principalRole.principalId) })
    .from(principalRole)
    .innerJoin(users, eq(users.id, principalRole.principalId))
    .where(and(eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE), isNull(users.deletedAt)));
  return rows[0]?.n ?? 0;
}
