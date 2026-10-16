import { sql } from "drizzle-orm";
import {
  clientIpKey,
  createCachedMapsProvider,
  createGoogleMapsProvider,
  createHaversineMapsProvider,
  createSchedulingAdminHandlers,
  createSchedulingHandlers,
  getSchedulingSettings,
  listResources,
  resolveSchedulingSettings,
  SCHEDULING_CREW_ROLE,
  updateResource,
  updateSchedulingSettings,
  type MapsProvider,
  type SchedulingCompany,
  type SchedulingRateLimitBucket,
} from "__SCOPE__/scheduling";
import { db } from "@/db";
import { env } from "@/env";
import { companyLinks } from "@/server/company-links";
import {
  admitPublic,
  companyAuthorizer,
  companyRoutes,
  publicCompanies,
  resolvePublicTenant,
  type FeatureHandlerOverrides,
} from "@/server/company-routes";
import { ALERTS_SETTINGS_HREF } from "@/server/alerts-links";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";
import { limiter } from "@/server/rate-limit";
import { SCHEDULING_RATE_LIMITS, firstSchedulingSettings } from "@/server/scheduling-config";
import {
  SCHEDULING_EMAILS_ENABLED,
  ensureSchedulingEmailTemplates,
  onSchedulingEvent,
  schedulingDelivery,
} from "@/server/scheduling-notify";
import { tenancy } from "@/server/tenancy";
import { COMPANY_DETAILS_HREF } from "@/tenancy";

/**
 * The app's side of __SCOPE__/scheduling in a COMPANIES project (Tenancy 2a):
 * every company runs its own schedule. Each one's crews, hours, services,
 * visits and emails are its own, under its own id, and nothing here names a
 * business.
 *
 *   /app/schedule …                  the company's own screens, over
 *   /api/app/{company id}/schedule   the staff handler (buildSchedulingAdminHandlers)
 *   /t/{web address}/book-visit …    its public pages, over
 *   /api/t/{web address}/schedule    the public handler (buildSchedulingPublicHandlers)
 *
 * WHICH COMPANY a request is for is never read from a session or a body: the
 * staff routes name the company id in their path and ask the company's own
 * permissions for it on every call (`companyAuthorizer`: signed in → a member
 * → not suspended → holds the key); the public routes name the company's web
 * address in theirs (`resolvePublicTenant`), and a suspended company's public
 * routes are closed (`admitPublic`, the sentence its pages show).
 *
 * WHAT THE COMPANY OWNS AND SCHEDULING ONLY READS: its name, contact details
 * and time zone come from the company profile, set once in /settings/company
 * (`schedulingCompany`). Schedule settings shows them read-only with a link
 * there. The time zone is the one scheduling also STORES, because each visit's
 * reminder and cutoff are instants worked out in it: when the company's zone
 * changes, scheduling runs its own zone change, which keeps every visit at its
 * clock time and re-queues its reminder (`syncSchedulingCompany`).
 */

/**
 * Drive times and addresses — the same provider for every company.
 *
 * GOOGLE_MAPS_API_KEY IS THE WHOLE SWITCH. With it, addresses are geocoded
 * and drive times come from Google, cached in the database so the same pair of
 * places is asked once (by any company). Without it, a straight-line estimate
 * stands in and is marked as one. `region: "us"` biases partial addresses to
 * the United States; change it for businesses elsewhere. The key never
 * appears in an error.
 */
export const schedulingMaps: MapsProvider = env.GOOGLE_MAPS_API_KEY
  ? createCachedMapsProvider(
      createGoogleMapsProvider({
        apiKey: env.GOOGLE_MAPS_API_KEY,
        region: "us",
        onError: (error) => log.warn({ err: error }, "google maps request failed"),
      }),
      db,
    )
  : createHaversineMapsProvider();

/**
 * The company as its customers know it: name, contact, zone, logo, colour —
 * from the company profile, read per request, so a rename shows on the next
 * page and nothing is copied that could drift (D5). The profile is a superset
 * of what scheduling asks for. Null for an unknown id (the handler then keeps
 * the stored settings).
 */
export const schedulingCompany = (tenantId: string): Promise<SchedulingCompany | null> => tenancy.companyProfile(tenantId);

/**
 * An error the handlers didn't expect: a 500 with a fixed sentence for the
 * caller, and the error itself in the app's error log (/admin/errors), with
 * the company it happened to.
 */
export function reportSchedulingError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "scheduling", route: context.route },
  });
}

/**
 * The public API's throttle, on the app's shared limiter (Upstash when
 * configured, this process's memory when not), counted PER COMPANY: one
 * company's busy morning never spends another's budget for a visitor behind
 * the same office network.
 *
 * Keyed on the caller's IP as the nearest proxy saw it (`clientIpKey`). A
 * request with no forwarded IP — a laptop with no proxy, the project's own
 * tests — is not limited, the rule the tRPC ladder's anonymous floor follows.
 * The company comes from the public seam's per-request cache, so this asks the
 * database nothing new.
 */
export async function schedulingRateLimit(req: Request, bucket: SchedulingRateLimitBucket): Promise<boolean> {
  const caller = clientIpKey(req);
  if (!caller) return true;
  const tenantId = (await publicCompanies.resolveTenant(req)) ?? "unknown";
  const result = await limiter.limit({
    key: `scheduling:${tenantId}:${bucket}:${caller}`,
    policy: SCHEDULING_RATE_LIMITS[bucket],
  });
  return result.allowed;
}

/**
 * The staff side, for one company per request: what /app/schedule, today's
 * route and Schedule settings talk to, at /api/app/{company id}/schedule.
 *
 * `overrides.principal` is how the project's own isolation proof
 * (src/server/__tests__/feature-isolation.test.ts) calls it as somebody else.
 *
 *   listPeople    who can be picked to open a crew's route: THIS company's
 *                 members, never the site's whole user list (Summit's people
 *                 must not appear in Green Acres' picker). Picking somebody
 *                 changes no role — the owner invites a crew member with the
 *                 Crew role from the Team page, then picks them here. Each
 *                 person's role rides along, so the schedule names a crew
 *                 member who isn't on a crew yet (review T2A-BO-04).
 *   delivery      whether this company's customer emails and reminders really
 *                 leave (the calendar's banner).
 *
 * No `onCrewMemberChange`: that is the single-business mode's crew STAFF role.
 * Here a crew member is a company member with the Crew role, which holds only
 * `schedule.route` — their own route, nothing else.
 */
export function buildSchedulingAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createSchedulingAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    company: schedulingCompany,
    companySettingsHref: COMPANY_DETAILS_HREF,
    maps: schedulingMaps,
    onEvent: onSchedulingEvent,
    delivery: (tenantId) => schedulingDelivery(tenantId),
    listPeople: async (_req, tenantId) =>
      (await tenancy.listMemberPeople(tenantId)).map((person) => ({
        userId: person.userId,
        name: person.name,
        email: person.email,
        roleKey: person.roleKey,
      })),
    // Where the crew notice's "Pick their crew" link goes.
    settingsHref: "/app/schedule/settings",
    // Who hears about new requests is chosen in Alert settings when this
    // project has alerts (Tenancy 2b-1, D6): the settings screen links there
    // instead of offering its own list. ALERTS_SETTINGS_HREF is generated —
    // null without alerts, and the package keeps 2a's list.
    alertsHref: ALERTS_SETTINGS_HREF,
    onError: reportSchedulingError,
  });
}

/**
 * The customer side, for the company whose web address the path names: what
 * /t/{web address}/book-visit and /t/{web address}/visit/[token] talk to.
 *
 * Every link it builds is the company's (`companyLinks`, from its CURRENT web
 * address), and every token it reads is looked up inside that company only, so
 * a Summit manage link opened under Green Acres' address is "not found".
 * `emailsEnabled` is the truth about this deployment's email, because the
 * picker reads it: with no email it hands the customer their link to keep.
 */
export function buildSchedulingPublicHandlers() {
  return createSchedulingHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    company: schedulingCompany,
    manageUrl: async (token, tenantId) => (await companyLinks(tenantId)).manageVisit(token),
    maps: schedulingMaps,
    onEvent: onSchedulingEvent,
    emailsEnabled: SCHEDULING_EMAILS_ENABLED,
    requesterKey: clientIpKey,
    rateLimit: schedulingRateLimit,
    onError: reportSchedulingError,
  });
}

/**
 * A company's first scheduling setup, ONCE (src/server/company-setup.ts runs
 * it when the company is created, and again before its first scheduling
 * request in each process — insert-if-absent, so a second run writes nothing).
 *
 *   1. Its first settings — the company's zone (else SCHEDULING_TIME_ZONE,
 *      else Mountain Time), an address required, one service, and ONLINE
 *      BOOKING OFF until the owner has looked — only when it has never saved
 *      any, under a lock per company so two cold starts can't both write.
 *   2. The visit emails, so the owner can read and edit them in Messages
 *      before the first customer books. Logged, never fatal: a missing comms
 *      table must not take the company's booking page down with it.
 *
 * No crew: the setup checklist asks the owner to add one ("Add your crew and
 * their hours") — a made-up "Field crew" taking real customers' visits is the
 * single-business demo's convenience, not a company's.
 */
export async function setupSchedulingFor(tenantId: string): Promise<void> {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling-setup:${tenantId}`}))`);
    const settings = await getSchedulingSettings(tx, tenantId);
    if (!settings.saved) {
      await updateSchedulingSettings(
        tx,
        tenantId,
        firstSchedulingSettings({ timeZone: profile.timeZone ?? env.SCHEDULING_TIME_ZONE, businessName: profile.name }),
      );
    }
  });
  try {
    await ensureSchedulingEmailTemplates(tenantId);
  } catch (error) {
    log.error({ err: error, tenantId }, "scheduling: a company's visit email templates couldn't be added");
  }
}

/**
 * Bring this company's schedule into step with its company profile — today,
 * that is the time zone (D5). An in-memory compare; it writes only when the
 * zones differ, and then it is scheduling's own zone change: every booked
 * visit keeps its clock time, its instants are worked out again under the
 * settings lock, and its reminder is re-queued (customers are not emailed
 * about it). Safe to call any number of times.
 *
 * Called at three moments, so a crash between any two costs nothing: right
 * after the owner saves company settings (src/server/company-setup.ts), on
 * every scheduling request (the handlers read settings through the same
 * function), and in the scheduling cron for every company.
 */
/**
 * A new crew member's first morning shouldn't be a dead end (review
 * T2A-BO-04). When somebody joins a company as a CREW MEMBER — invited with
 * the Crew role, or moved to it — and the company has exactly ONE active crew
 * that nobody opens yet, they are put on it, so their route opens the first
 * time they look. With several crews, or the one crew already taken, nothing
 * is guessed: the schedule names them until the owner picks their crew in
 * Schedule settings → Crews.
 *
 * Called from tenancy's events (src/server/company-setup.ts). Never throws:
 * the member joined either way.
 */
export async function linkNewCrewMember(tenantId: string, userId: string): Promise<void> {
  try {
    const person = (await tenancy.listMemberPeople(tenantId)).find((p) => p.userId === userId);
    if (!person || person.roleKey !== SCHEDULING_CREW_ROLE.key) return;
    const crews = await listResources(db, tenantId);
    if (crews.some((crew) => crew.userId !== null && String(crew.userId) === userId)) return;
    if (crews.length !== 1 || crews[0]!.userId !== null) return;
    await updateResource(db, tenantId, crews[0]!.id, { userId });
  } catch (error) {
    log.warn({ err: error, tenantId }, "scheduling: couldn't put a new crew member on the company's crew");
  }
}

export async function syncSchedulingCompany(tenantId: string): Promise<void> {
  await resolveSchedulingSettings(db, tenantId, {
    company: schedulingCompany,
    onEvent: onSchedulingEvent,
    onError: (error) => log.warn({ err: error, tenantId }, "scheduling: couldn't read the company profile"),
  });
}
