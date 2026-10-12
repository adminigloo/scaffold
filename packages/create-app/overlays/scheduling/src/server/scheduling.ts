import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { auditEntry } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { principalRole, roleTemplate, roleTemplateGrant } from "__SCOPE__/permissions/schema";
import { users } from "__SCOPE__/auth/schema";
import {
  backfillVisitInstants,
  clientIpKey,
  createCachedMapsProvider,
  createGoogleMapsProvider,
  createHaversineMapsProvider,
  createResource,
  getSchedulingSettings,
  listResources,
  updateSchedulingSettings,
  type CrewMemberChange,
  type MapsProvider,
  type PersonOption,
  type SchedulingPermission,
  type SchedulingRateLimitBucket,
} from "__SCOPE__/scheduling";
import { db as sharedDb } from "@/db";
import { env } from "@/env";
import { staffCatalog } from "@/permissions/catalog";
import { auditRegistry } from "@/server/audit";
import { currentPrincipal } from "@/server/auth";
import { log } from "@/server/logger";
import { loadStaffPermissions } from "@/server/permissions";
import { limiter } from "@/server/rate-limit";
import { requestContext } from "@/server/request-context";
import {
  CREW_ROLE,
  CREW_ROLE_KEYS,
  FIRST_CREW,
  SCHEDULING_RATE_LIMITS,
  SCHEDULING_STAFF_KEYS,
  SCHEDULING_STAFF_KEY_LIST,
  SCHEDULING_TENANT,
  crewAccessChange,
  firstSchedulingSettings,
  schedulingLinks,
} from "@/server/scheduling-config";
import { ensureSchedulingEmailTemplates } from "@/server/scheduling-notify";

/**
 * The app's side of __SCOPE__/scheduling: which maps provider, which
 * business, who may use the staff screens, the first-boot setup, and who can
 * open a crew's route. The two route handlers (app/api/schedule and
 * app/api/admin/schedule) are the package's handlers with these injected;
 * the widgets on /book-visit, /visit/[token] and /admin/schedule speak to
 * them.
 */

/**
 * Drive times and addresses.
 *
 * GOOGLE_MAPS_API_KEY IS THE WHOLE SWITCH. With it, addresses are geocoded
 * when a visit is booked and drive times come from Google's Distance Matrix,
 * cached in the database so the same pair of places is asked once. Without
 * it, the package's straight-line estimate stands in: drive times are marked
 * as estimates, and an address is stored as typed.
 *
 * `region: "us"` biases the geocoder to the United States, so a partial
 * address ("12 Main St, Springfield") lands in this country rather than in
 * whichever Springfield Google ranks first. Change it (a two-letter country
 * code) for a business elsewhere.
 *
 * Written out rather than through `selectMapsProvider` for one reason: the
 * `onError` below. A key with the Distance Matrix API not enabled answers
 * REQUEST_DENIED, and without a log line the only symptom is drive times that
 * quietly stop appearing. The error never contains the key.
 */
export const schedulingMaps: MapsProvider = env.GOOGLE_MAPS_API_KEY
  ? createCachedMapsProvider(
      createGoogleMapsProvider({
        apiKey: env.GOOGLE_MAPS_API_KEY,
        region: "us",
        onError: (error) => log.warn({ err: error }, "google maps request failed"),
      }),
      sharedDb,
    )
  : createHaversineMapsProvider();

/** Links on this deployment: the booking page, a customer's manage page, the staff calendar, sign-in. */
export const schedulingUrls = schedulingLinks(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");

let setup: Promise<void> | null = null;
let setupRan = false;

/**
 * Settings, a crew, crew access, the email templates and the 0.3 backfill —
 * once per process, before the first scheduling request is answered.
 *
 * WHAT IT DOES, in order, under one advisory lock so two cold starts can't
 * both do it:
 *
 *   1. The first settings (firstSchedulingSettings) — the zone, an address
 *      required, one service, and ONLINE BOOKING OFF until the owner has
 *      looked — ONLY when this business has never saved any. After that the
 *      row is the owner's.
 *   2. A demo crew, ONLY for a business that has never had one — removed
 *      crews count. A business that removed every crew to stop online
 *      booking must not find a new "Field crew" taking visits on the next
 *      cold start. To stop customers booking a crew, use its online-booking
 *      switch in Schedule settings; to stop it working, clear its hours.
 *   3. Crew access (`ensureCrewAccess`): the crew role, and the scheduling
 *      staff keys on the seeded staff roles.
 *   4. The visit emails, so the owner can read and edit them in Messages
 *      BEFORE the first customer books — they used to appear only after.
 *   5. `backfillVisitInstants`: visits written by scheduling 0.3 get their
 *      real start and end in the business's zone. A no-op once done.
 *
 * Memoised as a promise, and forgotten on failure: with no DATABASE_URL yet
 * every call fails the same way and the next request tries again, rather than
 * the first failure being cached for the life of the process.
 */
export function ensureSchedulingSetup(db = sharedDb): Promise<void> {
  if (!setup) {
    setup = runSetup(db)
      .then(() => {
        setupRan = true;
      })
      .catch((error: unknown) => {
        setup = null;
        throw error;
      });
  }
  return setup;
}

async function runSetup(db: typeof sharedDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling-setup:${SCHEDULING_TENANT}`}))`);
    const settings = await getSchedulingSettings(tx, SCHEDULING_TENANT);
    if (!settings.saved) {
      await updateSchedulingSettings(tx, SCHEDULING_TENANT, firstSchedulingSettings({ timeZone: env.SCHEDULING_TIME_ZONE }));
    }
    const crews = await listResources(tx, SCHEDULING_TENANT, { includeInactive: true });
    if (crews.length === 0) {
      await createResource(tx, { tenantId: SCHEDULING_TENANT, ...FIRST_CREW });
    }
    await ensureCrewAccess(tx);
  });
  try {
    await ensureSchedulingEmailTemplates();
  } catch (error) {
    // Logged, never fatal: a missing comms table must not take the booking
    // page down with it. The package's own listener says so again on the
    // first email.
    log.error({ err: error }, "scheduling: the visit email templates couldn't be added");
  }
  await backfillVisitInstants(db, SCHEDULING_TENANT);
}

type Tx = Parameters<Parameters<typeof sharedDb.transaction>[0]>[0];

/**
 * The crew role, and the scheduling staff keys on the staff roles that should
 * hold them — the same `defaultFor` the catalog declares, applied the way
 * `pnpm db:seed` applies it: insert-only, and only to SYSTEM templates (one a
 * client customised is never touched).
 *
 * WHY HERE AND NOT ONLY IN THE SEED. A project generated today, or one that
 * added scheduling later, has staff roles seeded before these keys existed;
 * without this the administrator would be refused their own calendar until
 * somebody re-ran the seed. It runs once per process, staff-only, and grants
 * nothing the catalog doesn't already say the role holds.
 */
async function ensureCrewAccess(tx: Tx): Promise<void> {
  const existing = await tx.query.roleTemplate.findFirst({
    where: and(eq(roleTemplate.scope, "staff"), eq(roleTemplate.tenantId, FIRM_WIDE), eq(roleTemplate.key, CREW_ROLE.key)),
  });
  if (!existing) {
    await tx
      .insert(roleTemplate)
      .values({ scope: "staff", tenantId: FIRM_WIDE, key: CREW_ROLE.key, name: CREW_ROLE.name, rank: CREW_ROLE.rank, isSystem: true })
      .onConflictDoNothing();
  }
  const templates = await tx
    .select({ id: roleTemplate.id, key: roleTemplate.key, isSystem: roleTemplate.isSystem })
    .from(roleTemplate)
    .where(and(eq(roleTemplate.scope, "staff"), eq(roleTemplate.tenantId, FIRM_WIDE)));
  for (const template of templates) {
    if (!template.isSystem) continue;
    // The crew role is this module's, not the seed's: its one key is granted
    // here. Every other system role gets what the catalog says it holds.
    const keys =
      template.key === CREW_ROLE.key
        ? CREW_ROLE_KEYS
        : staffCatalog.defaultsFor(template.key).filter((key) => SCHEDULING_STAFF_KEY_LIST.includes(key));
    for (const permission of keys) {
      await tx.insert(roleTemplateGrant).values({ templateId: template.id, permission, effect: "allow" }).onConflictDoNothing();
    }
  }
}

/**
 * The tenant seam the PUBLIC handler takes. It is also where the first-boot
 * setup runs, because it is the first thing every customer request does — so
 * no deploy step, seed command or migration hook has to remember it.
 *
 * The staff handler resolves the same tenant without it (`SCHEDULING_TENANT`,
 * in its route) and runs the setup inside `authorizeSchedulingStaff` instead,
 * once the caller is known to be staff: the handler resolves the tenant
 * BEFORE it authorizes, and a signed-out request should get its 401 without
 * touching the database.
 */
export async function resolveSchedulingTenant(): Promise<string> {
  await ensureSchedulingSetup();
  return SCHEDULING_TENANT;
}

/**
 * The public API's throttle, on the app's shared limiter (Upstash when
 * configured, this process's memory when not).
 *
 * Keyed on the caller's IP as the nearest proxy saw it (`clientIpKey`: the
 * last X-Forwarded-For entry — on Vercel, the caller). A request with no
 * forwarded IP — a laptop with no proxy in front of it — is not limited at
 * all, the same rule the tRPC ladder's anonymous floor follows: counting every
 * local request as one "anonymous" caller would refuse the developer's sixth
 * test booking of the hour and teach nothing.
 */
export async function schedulingRateLimit(req: Request, bucket: SchedulingRateLimitBucket): Promise<boolean> {
  const caller = clientIpKey(req);
  if (!caller) return true;
  const result = await limiter.limit({
    key: `scheduling:${bucket}:${caller}`,
    policy: SCHEDULING_RATE_LIMITS[bucket],
  });
  return result.allowed;
}

/**
 * Who may use the staff screens: the same ladder the admin shell climbs.
 *
 * A verified principal, then staff permissions resolved from THIS project's
 * tables (never from a session claim), then the staff key the scheduling
 * permission maps to (SCHEDULING_STAFF_KEYS). Nobody signed in is a 401 the
 * widget shows as "signed out"; signed in but not staff, or staff without the
 * key, is a 403.
 *
 * The first-boot setup runs once the caller is known to be staff, and the
 * permissions are read again after it the first time: the setup is what gives
 * the seeded staff roles their scheduling keys.
 *
 * The returned `userId` is who the visit's history says acted, and how
 * "Today's route" finds the crew whose linked person is the signed-in one.
 */
export async function authorizeSchedulingStaff(
  _req: Request,
  permission: SchedulingPermission,
): Promise<{ userId: string } | Response | false> {
  const principal = await currentPrincipal();
  if (!principal) {
    return Response.json(
      { error: { code: "forbidden", message: "Sign in to see the schedule." } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  let can = await loadStaffPermissions({ principal });
  if (!can) return false;
  if (!setupRan) {
    // Staff only from here: the first-boot setup (settings, a crew, crew
    // access) before anything reads — then the grants it may have added.
    await ensureSchedulingSetup();
    can = await loadStaffPermissions({ principal });
    if (!can) return false;
  }
  if (!can.can(SCHEDULING_STAFF_KEYS[permission])) return false;
  return { userId: principal.userId };
}

/**
 * Everybody who has signed in, for "Who opens this crew's route" in Schedule
 * settings: names and emails, never an id an owner would have to look up.
 * Somebody new signs in once (the settings screen says where) and appears.
 */
export async function listSchedulingPeople(): Promise<PersonOption[]> {
  const rows = await sharedDb
    .select({ id: users.id, email: users.email, name: users.displayName })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.displayName), asc(users.email))
    .limit(500);
  return rows.map((row) => ({ userId: row.id, name: row.name, email: row.email }));
}

/**
 * The owner picked (or un-picked) somebody to open a crew's route. A person
 * who holds no staff role gets the crew role — their own route and nothing
 * else — and loses it when no crew names them any more. Staff who already
 * hold a role keep it: picking the owner for a van never demotes them. Each
 * grant and revoke is written to the audit log.
 */
export async function onSchedulingCrewChange(change: CrewMemberChange): Promise<void> {
  const crews = await listResources(sharedDb, change.tenantId, { includeInactive: false });
  const people = [change.userId, change.previousUserId].filter((id): id is string => !!id);
  for (const userId of [...new Set(people)]) {
    const linked = change.userId === userId;
    const stillOnAnotherCrew = crews.some((crew) => crew.id !== change.resource.id && crew.userId === userId);
    await sharedDb.transaction(async (tx) => {
      const crewTemplate = await tx.query.roleTemplate.findFirst({
        where: and(eq(roleTemplate.scope, "staff"), eq(roleTemplate.tenantId, FIRM_WIDE), eq(roleTemplate.key, CREW_ROLE.key)),
      });
      if (!crewTemplate) return;
      const current = await tx
        .select({ key: roleTemplate.key })
        .from(principalRole)
        .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
        .where(and(eq(principalRole.principalId, userId), eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE)))
        .limit(1);
      const decision = crewAccessChange({ linked, currentRoleKey: current[0]?.key ?? null, stillOnAnotherCrew });
      if (!decision) return;
      if (decision === "grant") {
        await tx
          .insert(principalRole)
          .values({ principalId: userId, scope: "staff", tenantId: FIRM_WIDE, templateId: crewTemplate.id })
          .onConflictDoNothing();
      } else {
        await tx
          .delete(principalRole)
          .where(
            and(
              eq(principalRole.principalId, userId),
              eq(principalRole.scope, "staff"),
              eq(principalRole.tenantId, FIRM_WIDE),
              eq(principalRole.templateId, crewTemplate.id),
            ),
          );
      }
      await tx.insert(auditLog).values(
        auditEntry(auditRegistry, {
          action: decision === "grant" ? "scheduling.crew.access.granted" : "scheduling.crew.access.revoked",
          actor: change.changedBy ? { userId: change.changedBy } : null,
          scope: "staff",
          tenantId: null,
          resourceType: "user",
          resourceId: userId,
          request: await requestContext(),
          metadata: { crew: change.resource.name, resourceId: change.resource.id },
        }),
      );
    });
  }
}
