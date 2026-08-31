/**
 * A demo __TENANT_LABEL__ you can put in front of someone.
 *
 *   pnpm db:seed        role templates and their grants — run this FIRST
 *   pnpm db:seed:demo   THIS file: one organisation, five people, a permission
 *                       story, an audit trail and a triage queue
 *
 * The point is the permission checklist. It has three states per row — inherit,
 * allow, deny — plus a fourth that is not a state at all but a wall: a
 * capability the role template SEALS, which no per-person override can reopen.
 * An empty database demonstrates none of that, so the data below is arranged so
 * that opening one person's checklist shows all four at once.
 *
 * LOCAL ONLY, and the refusal at the top is not a formality. This writes
 * plausible-looking people and organisations. In a client's production database
 * they are indistinguishable from real records until someone tries to email
 * one, and by then they are entangled in exports, invoices and counts.
 *
 * IDEMPOTENT. Re-run it after changing the catalog; every write is an upsert on
 * a fixed id, and every id starts with `demo_` so the whole fixture is one
 * predicate away from being found or removed.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { pointsAtLocalhost, resolveAppEnv } from "__SCOPE__/env";
import {
  auditEntry,
  defineAuditedActions,
  errorFingerprint,
} from "__SCOPE__/observability";
import { auditLog, errorLog } from "__SCOPE__/observability/schema";
import { FIRM_WIDE, type Effect } from "__SCOPE__/permissions";
import {
  principalOverride,
  principalRole,
  roleTemplate,
} from "__SCOPE__/permissions/schema";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { db } from "../src/db";
import { env } from "../src/env";

const DEMO_TENANT_ID = "demo_tenant_northwind";
const OWNER_ID = "demo_user_ada";

/**
 * `.invalid` is reserved by RFC 2606 and can never resolve.
 *
 * A demo seed with addresses at a real domain is a demo seed that eventually
 * sends mail to a stranger — the first time someone runs an invitation
 * backfill, or points a broadcast at "all members".
 */
const DEMO_USERS = [
  {
    id: OWNER_ID,
    email: "ada@demo.invalid",
    displayName: "Ada Lovelace",
    template: "owner",
    status: "active",
  },
  {
    id: "demo_user_grace",
    email: "grace@demo.invalid",
    displayName: "Grace Hopper",
    template: "admin",
    status: "active",
  },
  {
    id: "demo_user_alan",
    email: "alan@demo.invalid",
    displayName: "Alan Turing",
    template: "member",
    status: "active",
  },
  {
    id: "demo_user_katherine",
    email: "katherine@demo.invalid",
    displayName: "Katherine Johnson",
    template: "viewer",
    status: "active",
  },
  {
    // Kept, not deleted. A suspended member still owns their audit history, and
    // the list has to be able to show somebody in that state.
    id: "demo_user_marie",
    email: "marie@demo.invalid",
    displayName: "Marie Curie",
    template: "member",
    status: "suspended",
  },
] as const;

/** Internal staff, so the impersonation entry below has a real actor. */
const DEMO_STAFF_ID = "demo_user_rosalind";
const DEMO_STAFF = {
  id: DEMO_STAFF_ID,
  email: "rosalind@demo.invalid",
  displayName: "Rosalind Franklin",
  template: "cs_lead",
} as const;

/**
 * Alan is an outside contractor on the `member` template. The two rows below,
 * plus what the template already says, are the whole demonstration:
 *
 *   allow   tenant.edit      member does NOT grant it — a real elevation
 *   deny    members.view     member DOES grant it — a real revocation
 *   inherit tenant.view      untouched, straight from the template
 *   sealed  tenant.transfer  the template denies it; no override can reopen it
 *
 * The sealed row is deliberately left alone. Adding an allow override for it
 * would still resolve to denied, which is the correct behaviour and a terrible
 * fixture: the checklist would show a contradiction rather than a rule.
 */
const DEMO_OVERRIDES: readonly {
  readonly principalId: string;
  readonly permission: string;
  readonly effect: Effect;
  readonly reason: string;
}[] = [
  {
    principalId: "demo_user_alan",
    permission: "tenant.edit",
    effect: "allow",
    reason: "Maintains the public brand assets for this quarter.",
  },
  {
    principalId: "demo_user_alan",
    permission: "members.view",
    effect: "deny",
    reason: "External contractor — the member directory is out of scope.",
  },
];

/**
 * The vocabulary for the entries below.
 *
 * A local registry rather than string literals at the insert, for the reason
 * `defineAuditedActions` exists: `isSensitive` is read from here and stamped on
 * the row, so the compliance query — a partial index over sensitive rows — sees
 * the impersonation entry. Hand-writing `isSensitive: false` on that row would
 * not mislabel it so much as delete it from the only report anyone runs.
 */
const demoActions = defineAuditedActions({
  "tenant.created": { label: "Organisation created" },
  "member.invited": { label: "Member invited" },
  "member.override.set": { label: "Per-person permission changed" },
  "member.suspended": { label: "Member suspended" },
  "tenant.impersonated": {
    label: "Staff opened a customer's screen",
    sensitive: true,
  },
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Three distinct bugs, not three occurrences.
 *
 * The stacks are written out by hand rather than captured from a real throw so
 * the fingerprints do not change when this file does. A captured stack would
 * point at this script's own line numbers, and editing a comment above would
 * mint three new rows and orphan the three that were here.
 */
const DEMO_ERRORS = [
  {
    name: "TRPCError",
    message: "UNAUTHORIZED: no active tenant for principal",
    stack:
      "TRPCError: UNAUTHORIZED\n" +
      "    at requireTenant (trpc.ts:118:11)\n" +
      "    at resolveMiddleware (initTRPC.ts:71:20)\n" +
      "    at handler (route.ts:24:9)",
    source: "trpc",
    occurrences: 47,
    firstSeenDaysAgo: 9,
    lastSeenHoursAgo: 2,
    resolvedDaysAgo: null,
  },
  {
    name: "NeonDbError",
    message: "terminating connection due to administrator command",
    stack:
      "NeonDbError: terminating connection due to administrator command\n" +
      "    at Socket.onEnd (session.js:212:24)\n" +
      "    at NeonPreparedQuery.execute (session.js:88:15)\n" +
      "    at listTenants (tenants.ts:41:18)",
    source: "db",
    // The number that decides what gets fixed first, and the reason error_log
    // upserts on a fingerprint instead of inserting a row per occurrence.
    occurrences: 3812,
    firstSeenDaysAgo: 2,
    lastSeenHoursAgo: 1,
    resolvedDaysAgo: null,
  },
  {
    name: "WebhookVerificationError",
    message: "svix signature did not match the request body",
    stack:
      "WebhookVerificationError: svix signature did not match\n" +
      "    at verifyClerkWebhook (route.ts:37:11)\n" +
      "    at POST (route.ts:58:22)",
    source: "webhook:clerk",
    occurrences: 6,
    firstSeenDaysAgo: 21,
    lastSeenHoursAgo: 19 * 24,
    // Resolved rows are excluded from the dashboard's partial index. One of
    // them is here so the view has something to be excluding.
    resolvedDaysAgo: 18,
  },
] as const;

function fail(message: string): never {
  console.error("");
  console.error("SEED REFUSED");
  console.error(message);
  console.error("");
  process.exit(1);
}

/**
 * Two gates, because one of them is nearly always satisfied.
 *
 * `resolveAppEnv()` now recognises every host — a platform variable, an
 * explicit `APP_ENV`, or `NODE_ENV` as the fallback discriminator — so it does
 * stop a run from inside a deployment, wherever that deployment lives. What it
 * still cannot see is the dangerous case, and that one is the ordinary one: a
 * developer running this under `tsx` on their own laptop, where the answer is
 * honestly "local", with a `.env.local` filled in from
 * `vercel env pull --environment=production`. Nothing about the process says
 * anything is wrong; the connection string does. The app URL is the tell,
 * because it came from the same pull.
 */
function assertLocal(): void {
  const appEnv = resolveAppEnv();
  if (appEnv !== "local") {
    fail(
      `resolveAppEnv() is "${appEnv}". This script writes fictional people and ` +
        `organisations, and there is no way to tell them apart from real ones ` +
        `once they are in a customer's database.`,
    );
  }
  if (!pointsAtLocalhost(env.NEXT_PUBLIC_APP_URL)) {
    fail(
      `NEXT_PUBLIC_APP_URL is ${env.NEXT_PUBLIC_APP_URL}, not localhost.\n` +
        `That means .env.local is pointing at a deployed environment — most ` +
        `likely pulled with \`vercel env pull\` — so DATABASE_URL is pointing ` +
        `there too. Restore the local values before running this.`,
    );
  }
}

/** Host and database only. The connection string carries a password. */
function describeDatabase(connectionString: string | undefined): string {
  if (connectionString === undefined) return "not configured";
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return "unparseable";
  }
}

/**
 * The seeded system templates, by key.
 *
 * Read rather than created. `scripts/seed-roles.ts` owns these rows and applies
 * the catalog's `defaultFor` grants to them; minting one here would produce a
 * template with a name and no permissions, and the checklist would render every
 * row as "not granted" with nothing to explain why.
 */
async function loadTemplates(
  scope: "staff" | "tenant",
  keys: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = await db
    .select({ id: roleTemplate.id, key: roleTemplate.key })
    .from(roleTemplate)
    .where(
      and(
        eq(roleTemplate.scope, scope),
        eq(roleTemplate.tenantId, FIRM_WIDE),
        inArray(roleTemplate.key, [...keys]),
      ),
    );

  const found = new Map(rows.map((row) => [row.key, row.id]));
  const missing = keys.filter((key) => !found.has(key));
  if (missing.length > 0) {
    fail(
      `No ${scope} role template for: ${missing.join(", ")}.\n` +
        `Run \`pnpm db:seed\` first — it creates the templates and applies the ` +
        `catalog's defaults to them.`,
    );
  }
  return found;
}

async function seedPeople(): Promise<void> {
  for (const person of [...DEMO_USERS, DEMO_STAFF]) {
    await db
      .insert(users)
      .values({
        id: person.id,
        /**
         * NOT "clerk". The unique index is on (identity_provider, external_id),
         * so a demo row claiming the Clerk provider could collide with a real
         * webhook for a real person — and the loser of that collision is a
         * signed-in customer whose account cannot be created.
         */
        identityProvider: "demo",
        externalId: person.id,
        email: person.email,
        displayName: person.displayName,
        activeTenantId: DEMO_TENANT_ID,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email: person.email, displayName: person.displayName },
      });
  }
}

async function seedTenant(): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: DEMO_TENANT_ID,
      kind: "org",
      slug: "northwind-traders",
      name: "Northwind Traders",
      ownerUserId: OWNER_ID,
      branding: { accentColor: "#1f6feb" },
      settings: { locale: "en-GB", timeZone: "Europe/London" },
    })
    .onConflictDoUpdate({
      target: tenants.id,
      set: { name: "Northwind Traders", ownerUserId: OWNER_ID },
    });

  for (const person of DEMO_USERS) {
    await db
      .insert(tenantMembers)
      .values({
        tenantId: DEMO_TENANT_ID,
        userId: person.id,
        status: person.status,
      })
      .onConflictDoUpdate({
        target: [tenantMembers.tenantId, tenantMembers.userId],
        set: { status: person.status },
      });
  }
}

async function seedRoles(): Promise<void> {
  const tenantTemplates = await loadTemplates(
    "tenant",
    [...new Set(DEMO_USERS.map((person) => person.template))],
  );
  const staffTemplates = await loadTemplates("staff", [DEMO_STAFF.template]);

  for (const person of DEMO_USERS) {
    const templateId = tenantTemplates.get(person.template);
    if (templateId === undefined) continue;
    await db
      .insert(principalRole)
      .values({
        principalId: person.id,
        scope: "tenant",
        // The template is firm-wide; the ASSIGNMENT is per tenant. That split
        // is what lets one person hold "admin" in one organisation and "viewer"
        // in another without duplicating the template.
        tenantId: DEMO_TENANT_ID,
        templateId,
      })
      .onConflictDoUpdate({
        target: [
          principalRole.principalId,
          principalRole.scope,
          principalRole.tenantId,
        ],
        set: { templateId },
      });
  }

  const staffTemplateId = staffTemplates.get(DEMO_STAFF.template);

  // Only once a REAL staff member exists.
  //
  // `grantBootstrapAdminIfFirst` gives the first person to sign in an admin
  // role, and it is guarded by "no staff role exists yet". Seeding a demo staff
  // row satisfies that guard, so the very next real sign-in silently gets
  // nothing and lands on "You do not have access to the admin panel" with no
  // way in short of hand-writing SQL. The demo data would lock you out of the
  // demo.
  //
  // Seeded after you have your own role, the demo lead is still useful: it puts
  // a second person in /admin/people and gives the impersonation audit entry a
  // real actor.
  const realStaff = await db
    .select({ principalId: principalRole.principalId })
    .from(principalRole)
    .where(
      and(
        eq(principalRole.scope, "staff"),
        ne(principalRole.principalId, DEMO_STAFF_ID),
      ),
    )
    .limit(1);

  const seedDemoStaff = staffTemplateId !== undefined && realStaff.length > 0;

  if (!seedDemoStaff && staffTemplateId !== undefined) {
    console.log(
      "  staff     skipped — no real staff member yet. Sign in first so " +
        "the bootstrap grant can reach you, then re-run this seed.",
    );
  }

  if (seedDemoStaff) {
    await db
      .insert(principalRole)
      .values({
        principalId: DEMO_STAFF_ID,
        scope: "staff",
        tenantId: FIRM_WIDE,
        templateId: staffTemplateId,
      })
      .onConflictDoUpdate({
        target: [
          principalRole.principalId,
          principalRole.scope,
          principalRole.tenantId,
        ],
        set: { templateId: staffTemplateId },
      });
  }

  for (const override of DEMO_OVERRIDES) {
    await db
      .insert(principalOverride)
      .values({
        principalId: override.principalId,
        scope: "tenant",
        tenantId: DEMO_TENANT_ID,
        permission: override.permission,
        effect: override.effect,
        // An override without provenance is unauditable: six months later the
        // only question anyone asks is who decided this, and why.
        grantedBy: OWNER_ID,
        reason: override.reason,
      })
      .onConflictDoUpdate({
        target: [
          principalOverride.principalId,
          principalOverride.scope,
          principalOverride.tenantId,
          principalOverride.permission,
        ],
        set: { effect: override.effect, reason: override.reason },
      });
  }
}

async function seedAuditTrail(now: number): Promise<void> {
  /**
   * The one place a delete against `audit_log` is defensible.
   *
   * The table is append-only because an editable audit trail answers a
   * different question than the one it is kept for. These rows are fixtures,
   * not history, and the predicate is the demo tenant id — which no real row
   * can ever carry, because no real tenant is created with a hardcoded
   * `demo_` id. Without it, every run stacks another copy of the same trail.
   */
  await db.delete(auditLog).where(eq(auditLog.tenantId, DEMO_TENANT_ID));

  const entries = [
    {
      at: now - 30 * DAY,
      entry: auditEntry(demoActions, {
        action: "tenant.created",
        actor: { userId: OWNER_ID },
        scope: "tenant",
        tenantId: DEMO_TENANT_ID,
        resourceType: "tenant",
        resourceId: DEMO_TENANT_ID,
      }),
    },
    {
      at: now - 12 * DAY,
      entry: auditEntry(demoActions, {
        action: "member.invited",
        actor: { userId: "demo_user_grace" },
        scope: "tenant",
        tenantId: DEMO_TENANT_ID,
        resourceType: "user",
        resourceId: "demo_user_alan",
        metadata: { email: "alan@demo.invalid", template: "member" },
      }),
    },
    {
      at: now - 11 * DAY,
      entry: auditEntry(demoActions, {
        action: "member.override.set",
        actor: { userId: OWNER_ID },
        scope: "tenant",
        tenantId: DEMO_TENANT_ID,
        resourceType: "user",
        resourceId: "demo_user_alan",
        metadata: { permission: "tenant.edit", effect: "allow" },
      }),
    },
    {
      at: now - 4 * DAY,
      entry: auditEntry(demoActions, {
        action: "member.suspended",
        actor: { userId: OWNER_ID },
        scope: "tenant",
        tenantId: DEMO_TENANT_ID,
        resourceType: "user",
        resourceId: "demo_user_marie",
        metadata: { reason: "Leave of absence" },
      }),
    },
    {
      at: now - 6 * HOUR,
      entry: auditEntry(demoActions, {
        action: "tenant.impersonated",
        /**
         * Two ids, and both are needed. The customer's id says whose data was
         * touched; the staff id says who touched it. Fold them into one column
         * and the trail either loses the customer or says the customer did it.
         */
        actor: { userId: OWNER_ID, impersonatedBy: DEMO_STAFF_ID },
        scope: "staff",
        tenantId: DEMO_TENANT_ID,
        resourceType: "tenant",
        resourceId: DEMO_TENANT_ID,
        request: { ipAddress: "203.0.113.24", userAgent: "Mozilla/5.0" },
        metadata: { ticket: "SUP-4192" },
      }),
    },
  ];

  await db.insert(auditLog).values(
    entries.map(({ at, entry }) => ({ ...entry, createdAt: new Date(at) })),
  );
}

async function seedErrorQueue(now: number): Promise<void> {
  for (const sample of DEMO_ERRORS) {
    const fingerprint = errorFingerprint(sample);
    const lastSeenAt = new Date(now - sample.lastSeenHoursAgo * HOUR);
    const resolvedAt =
      sample.resolvedDaysAgo === null
        ? null
        : new Date(now - sample.resolvedDaysAgo * DAY);

    await db
      .insert(errorLog)
      .values({
        fingerprint,
        message: sample.message,
        stack: sample.stack,
        source: sample.source,
        tenantId: DEMO_TENANT_ID,
        occurrences: sample.occurrences,
        firstSeenAt: new Date(now - sample.firstSeenDaysAgo * DAY),
        lastSeenAt,
        resolvedAt,
      })
      // The same upsert the application uses, minus the increment: re-running
      // the seed must restore the fixture's counts, not inflate them.
      .onConflictDoUpdate({
        target: errorLog.fingerprint,
        set: { occurrences: sample.occurrences, lastSeenAt, resolvedAt },
      });
  }
}

async function main(): Promise<void> {
  assertLocal();

  // Named before anything is written, for the same reason scripts/migrate.ts
  // prints its target: the wrong database is only ever discovered afterwards.
  console.log("");
  console.log("Seeding demo data");
  console.log(`  database  ${describeDatabase(env.DATABASE_URL)}`);
  console.log(`  tenant    Northwind Traders (${DEMO_TENANT_ID})`);
  console.log(`  people    ${DEMO_USERS.length} members`);
  console.log("");

  // Relative to one instant, captured once, so the whole fixture tells a single
  // consistent story rather than one that drifts across the run.
  const now = Date.now();

  await seedPeople();
  await seedTenant();
  await seedRoles();
  await seedAuditTrail(now);
  await seedErrorQueue(now);

  console.log("Done.");
  console.log("");
  console.log("Open Alan Turing's checklist to see all four states at once:");
  console.log("  allow   tenant.edit      granted to him specifically");
  console.log("  deny    members.view     revoked from him specifically");
  console.log("  inherit tenant.view      from the member template");
  console.log("  sealed  tenant.transfer  denied by the template, unreopenable");
  console.log("");
  console.log("The admin screens are staff-gated, and the demo staff user cannot");
  console.log("sign in. Sign in as yourself, then give your own row a staff role:");
  console.log("");
  console.log('  psql "$DATABASE_URL_UNPOOLED" -c "insert into principal_role');
  console.log("    (principal_id, scope, tenant_id, template_id)");
  console.log("    select u.id, 'staff', '*', t.id from users u, role_template t");
  console.log("    where u.email = 'YOU@example.com'");
  console.log("      and t.scope = 'staff' and t.key = 'admin'\"");
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
