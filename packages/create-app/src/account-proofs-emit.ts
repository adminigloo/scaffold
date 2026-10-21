/**
 * THE PROOFS OF THE CONSUMER-FIT REVIEW (create-app 0.39), emitted into the
 * projects they're about and run on every `pnpm test` there, on PGlite:
 *
 *   src/server/__tests__/first-administrator.test.ts   every project: a
 *       production build is never handed to the first stranger, and a set
 *       BOOTSTRAP_ADMIN_EMAIL always wins
 *   src/server/__tests__/one-person-accounts.test.ts    consumers: on a
 *       database a business seed wrote, `pnpm db:seed` takes the team keys
 *       back and suspends shared memberships, and the loaders refuse
 *       somebody else's account (requireEntitlement included) even before it
 *   src/server/__tests__/account-plans.test.ts         personal plans: the
 *       account pages say what the plan check says — free months that ended,
 *       a checkout that never finished
 *   src/server/__tests__/refusals.test.ts              wherever plans are
 *       sold: a refusal never names a plan that isn't on sale
 */
import { personalPlans } from "./personal-plans-emit.js";
import type { Answers } from "./answers.js";

// ---------------------------------------------------------------------------
// src/server/__tests__/first-administrator.test.ts
// ---------------------------------------------------------------------------

export function renderFirstAdministratorTest(_answers: Answers): string {
  return `import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapPolicy } from "@/server/tenancy";

/**
 * WHO BECOMES THE FIRST ADMINISTRATOR (create-app 0.39, review). A self-hosted
 * production server that loaded the project's .env.local — whose app URL is
 * http://localhost:3000 — passed for the founder's laptop, and handed /admin
 * to the first stranger to sign up, BOOTSTRAP_ADMIN_EMAIL set or not.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

const set = vi.hoisted(() => ({ email: undefined as string | undefined }));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "BOOTSTRAP_ADMIN_EMAIL") return set.email;
        return Reflect.get(target, prop);
      },
    }),
  };
});

/** A production build nothing labelled, on a localhost app URL: \`pnpm start\` on a laptop and a self-hosted server look the same. */
function productionOnLocalhost(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
}

afterEach(() => {
  vi.unstubAllEnvs();
  set.email = undefined;
});

describe("the first administrator", () => {
  it("a production build on a localhost app URL is never handed to the first person to sign in", () => {
    productionOnLocalhost();
    expect(bootstrapPolicy()).toEqual({ mode: "off" });
  });

  it("a set BOOTSTRAP_ADMIN_EMAIL is the one address made administrator, on any machine", () => {
    productionOnLocalhost();
    set.email = "founder@example.test";
    expect(bootstrapPolicy()).toEqual({ mode: "email", email: "founder@example.test" });
    vi.stubEnv("NODE_ENV", "development");
    expect(bootstrapPolicy()).toEqual({ mode: "email", email: "founder@example.test" });
  });

  it("NEGATIVE CONTROL: the dev server, with no address set, makes the first person to sign in administrator", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("APP_ENV", "");
    expect(bootstrapPolicy()).toEqual({ mode: "first-user" });
  });
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/one-person-accounts.test.ts (consumers)
// ---------------------------------------------------------------------------

export function renderOnePersonAccountsTest(answers: Answers): string {
  const scope = answers.scope;
  const paid = personalPlans(answers);
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Principal } from "${scope}/auth";
import { users } from "${scope}/auth/schema";${paid ? `
import { planOnSale } from "${scope}/billing";
import { plans as planTable } from "${scope}/billing/schema";` : ""}
import { definePermissions, STAFF_ROLE_TEMPLATES } from "${scope}/permissions";
import { assignRoleTemplate, seedPermissionCatalog } from "${scope}/permissions/server";
import { tenancyPermissions } from "${scope}/tenancy";
import { tenantMembers } from "${scope}/tenancy/schema";
import { createScaffoldContext } from "${scope}/trpc";
import { db } from "@/db";
import { HELD_BY_NOBODY, staffCatalog } from "@/permissions/catalog";
import { TENANT_ROLES } from "@/permissions/roles";
import { seedPermissions } from "@/permissions/seed";${paid ? `
import { plans } from "@/plans";
import { requireEntitlement } from "@/server/access";
import { applySubscription } from "@/server/subscription";` : ""}
import { loadTenantPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";
import { currentTenantFor } from "@/server/tenant";
import { createCallerFactory, createTRPCRouter, requireTenant } from "@/server/trpc";

/**
 * ONE PERSON PER ACCOUNT, ON A DATABASE THAT RAN AS A BUSINESS FIRST
 * (create-app 0.39, review). \`upgrade --audience consumers\` changes the
 * files; the database still holds what the business seed wrote — the shipped
 * roles holding the invite, remove, change-role and hand-over keys — and the
 * memberships its invitations made. Proved here on that database:
 *
 *   - the permission loaders refuse somebody else's account at once, so a
 *     membership left from before can't use what that account pays for
 *   - \`pnpm db:seed\` (seedPermissions) takes the keys back from the shipped
 *     roles, and suspends the membership, naming it
 *   - nobody loses their own account
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

/** The tenant catalog a --audience business project seeds: tenancy's keys, with their own defaults. */
const businessTenantCatalog = definePermissions("tenant", { ...tenancyPermissions }, { contributedBy: [tenancyPermissions] });

${paid ? `/** A feature the record sells on a tier on sale, and the free tier doesn't give: what A pays for. */
function paidOnly(): { readonly tierKey: string; readonly feature: string; readonly rowKey: string } | null {
  for (const tier of plans.tiers) {
    if (!planOnSale(tier)) continue;
    const row = plans.rows.find((candidate) => candidate.tierKey === tier.key && candidate.interval === "month");
    if (row === undefined) continue;
    const free = plans.line(tier.line)?.free ?? null;
    for (const held of Object.values(tier.features)) {
      const sells = (held.kind === "flag" && held.included) || (held.kind === "quota" && (held.limit === null || held.limit > 0));
      if (!sells) continue;
      const given = free?.features[held.feature];
      const freeGives = given !== undefined && ((given.kind === "flag" && given.included) || (given.kind === "quota" && (given.limit === null || given.limit > 0)));
      if (!freeGives) return { tierKey: tier.key, feature: held.feature, rowKey: row.key };
    }
  }
  return null;
}
const PAID = paidOnly();

` : ""}const router = createTRPCRouter({
  whose: requireTenant("tenant.view").query(({ ctx }) => ctx.tenantId),${paid ? `
  paid: requireEntitlement(PAID?.feature ?? "none").query(({ ctx }) => ctx.tenantId),` : ""}
});

function as(who: { readonly id: string; readonly email: string }) {
  const principal: Principal = { userId: who.id, externalId: \`ext_\${who.id}\`, email: who.email };
  return createCallerFactory(router)(createScaffoldContext({ principal }));
}

interface Person {
  readonly id: string;
  readonly email: string;
  readonly workspace: string;
}

async function person(tag: string): Promise<Person> {
  const email = \`\${tag}@example.test\`;
  const [row] = await db.insert(users).values({ externalId: \`ext_\${tag}\`, email, displayName: tag }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  const session = await tenancy.resolveSession({ userId: row.id });
  if (session.state !== "ready") throw new Error(\`no account for \${tag}: \${session.state}\`);
  return { id: row.id, email, workspace: session.company.id };
}

async function membership(tenantId: string, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: tenantMembers.status })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
  return row?.status;
}

const fx = {} as { A: Person; B: Person };

beforeAll(async () => {
  // 1. What the database held while the project was --audience business.
  await seedPermissionCatalog(db, {
    staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
    tenant: { catalog: businessTenantCatalog, templates: TENANT_ROLES.templates },
  });
  fx.A = await person("one_a");
  fx.B = await person("one_b");
  // B joined A's account through an invitation, back then.
  await db.insert(tenantMembers).values({ tenantId: fx.A.workspace, userId: fx.B.id, status: "active" });
  await assignRoleTemplate(db, { scope: "tenant", principalId: fx.B.id, tenantId: fx.A.workspace, templateKey: "member", actor: { system: "test" } });${paid ? `
  // A pays for a plan.
  for (const row of plans.rows) {
    await db.insert(planTable).values({
      key: row.key,
      name: row.name,
      description: row.description,
      interval: row.interval,
      priceMinor: row.priceMinor,
      currency: row.currency,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  }
  if (PAID !== null) {
    const now = new Date();
    await applySubscription({
      tenantId: fx.A.workspace,
      tierKey: PAID.tierKey,
      planKey: PAID.rowKey,
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEndsAt: null,
      observedAt: now,
      source: "simulated",
    });
  }` : ""}
});

describe("one person per account, on a database that ran as a business", () => {
  it("1. NEGATIVE CONTROL: what the switch alone leaves — the owner holds the team keys, and B is in A's account", async () => {
    const owner = await loadTenantPermissions({ principal: { userId: fx.A.id }, tenantId: fx.A.workspace });
    expect(HELD_BY_NOBODY.filter((key) => owner?.can(key))).toEqual([...HELD_BY_NOBODY]);
    expect(await membership(fx.A.workspace, fx.B.id)).toBe("active");
  });

  it("2. even before the seed, nobody acts in somebody else's account: B is refused A's, each keeps their own", async () => {
    expect(await loadTenantPermissions({ principal: { userId: fx.B.id }, tenantId: fx.A.workspace })).toBeNull();
    await expect(as(fx.B).whose({ tenantId: fx.A.workspace })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as(fx.B).whose({ tenantId: fx.B.workspace })).toBe(fx.B.workspace);
    expect(await as(fx.A).whose({ tenantId: fx.A.workspace })).toBe(fx.A.workspace);
    expect((await currentTenantFor(fx.B.id))?.id).toBe(fx.B.workspace);
  });
${paid ? `
  it("3. B can't use what A pays for by naming A's account (review: requireEntitlement served A's plan to B)", async () => {
    if (PAID === null) {
      expect(PAID, "src/plans.ts sells nothing the free tier doesn't give, so there is nothing to take").toBeNull();
      return;
    }
    // NEGATIVE CONTROL: A, on A's own account, gets it.
    expect(await as(fx.A).paid({ tenantId: fx.A.workspace })).toBe(fx.A.workspace);
    await expect(as(fx.B).paid({ tenantId: fx.A.workspace })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(fx.B).paid({ tenantId: fx.B.workspace })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
` : ""}
  it("${paid ? "4" : "3"}. pnpm db:seed takes the team keys back from the shipped roles and suspends B's membership of A's account, naming it", async () => {
    const lines: string[] = [];
    const report = await seedPermissions(db, { log: (line) => lines.push(line) });
    expect(report.withdrawn).toEqual(expect.arrayContaining(["tenant/owner/members.invite", "tenant/owner/tenant.transfer"]));
    const owner = await loadTenantPermissions({ principal: { userId: fx.A.id }, tenantId: fx.A.workspace });
    expect(HELD_BY_NOBODY.filter((key) => owner?.can(key))).toEqual([]);
    // Refused for want of the key now, not only by the seat limit.
    await expect(
      tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.A.workspace, email: "friend@example.test", roleKey: "member" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await membership(fx.A.workspace, fx.B.id)).toBe("suspended");
    expect(lines.join("\\n")).toContain(\`\${fx.B.id} in \${fx.A.workspace}\`);
    // NEGATIVE CONTROL: nobody loses their own account.
    expect(await membership(fx.A.workspace, fx.A.id)).toBe("active");
    expect(await membership(fx.B.workspace, fx.B.id)).toBe("active");
    expect((await currentTenantFor(fx.A.id))?.id).toBe(fx.A.workspace);
    expect((await currentTenantFor(fx.B.id))?.id).toBe(fx.B.workspace);
  });

  it("${paid ? "5" : "4"}. and the seed again changes nothing", async () => {
    const report = await seedPermissions(db, { log: () => {} });
    expect(report.withdrawn).toEqual([]);
    expect(await membership(fx.A.workspace, fx.B.id)).toBe("suspended");
  });
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/account-plans.test.ts (personal plans)
// ---------------------------------------------------------------------------

export function renderAccountPlansTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { planOnSale } from "${scope}/billing";
import { users } from "${scope}/auth/schema";
import { plans as planTable } from "${scope}/billing/schema";
import { db } from "@/db";
import { plans } from "@/plans";
import { seedPermissions } from "@/permissions/seed";
import { entitlementOf } from "@/server/access";
import { readLineHoldings, readSubscriptionsForTenant } from "@/server/account";
import { personalPlan } from "@/server/plan-gate";
import { applySubscription } from "@/server/subscription";
import { tenancy } from "@/server/tenancy";

/**
 * THE ACCOUNT PAGES SAY WHAT THE PLAN CHECK SAYS (create-app 0.39, review).
 * /account and /account/billing used to read the subscription row's status:
 * free months stay "active" for ever (nothing closes them), and a checkout
 * whose first payment never went through is "incomplete", which the
 * database's live-row rule counts — so the pages said "You're on Pro" and
 * listed Pro's features while the check had gone back to the free tier. They
 * read the check's own standing now (\`readLineHoldings\`).
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
const DAY = 24 * 60 * 60 * 1000;

const LINE = plans.lines[0]!;
/** The first line's priciest tier on sale, sold monthly: what free months are given of. */
const TOP = plans.rows
  .filter((row) => row.interval === "month" && row.isActive && plans.tier(row.tierKey)?.line === LINE.key && planOnSale(plans.tier(row.tierKey)!))
  .sort((a, b) => (a.priceMinor < b.priceMinor ? 1 : -1))[0]!;

async function person(tag: string): Promise<string> {
  const email = \`\${tag}@example.test\`;
  const [row] = await db.insert(users).values({ externalId: \`ext_\${tag}\`, email, displayName: tag }).returning();
  await tenancy.provisionUser({ userId: row!.id, email });
  const session = await tenancy.resolveSession({ userId: row!.id });
  if (session.state !== "ready") throw new Error(\`no account for \${tag}\`);
  return session.company.id;
}

const fx = {} as { comped: string; stuck: string };

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  for (const row of plans.rows) {
    await db.insert(planTable).values({
      key: row.key,
      name: row.name,
      description: row.description,
      interval: row.interval,
      priceMinor: row.priceMinor,
      currency: row.currency,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  }
  const now = new Date();
  // Give free months: exactly billing.compPlan's write (src/server/routers/billing.ts).
  fx.comped = await person("acct_comped");
  await applySubscription({
    tenantId: fx.comped,
    tierKey: TOP.tierKey,
    planKey: TOP.key,
    stripeSubscriptionId: null,
    stripeCustomerId: null,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY),
    cancelAtPeriodEnd: true,
    canceledAt: null,
    trialEndsAt: null,
    observedAt: now,
    observedBy: "comp:staff_1",
    source: "simulated",
    action: "billing.subscription.comped",
  });
  // A checkout whose first payment never went through.
  fx.stuck = await person("acct_stuck");
  await applySubscription({
    tenantId: fx.stuck,
    tierKey: TOP.tierKey,
    planKey: TOP.key,
    stripeSubscriptionId: "sub_incomplete1",
    stripeCustomerId: "cus_incomplete1",
    status: "incomplete",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEndsAt: null,
    observedAt: now,
    source: "stripe",
  });
});

describe("the account pages and the plan check agree", () => {
  it("NEGATIVE CONTROL: during the free months, both say the paid tier", async () => {
    expect((await personalPlan(fx.comped)).lines.get(LINE.key)?.standing).toMatchObject({ open: true, tierKey: TOP.tierKey });
    expect((await readLineHoldings(fx.comped)).get(LINE.key)).toEqual({ line: LINE.key, open: true, tierKey: TOP.tierKey, onFree: false });
  });

  it("once the free months are over, the check is back on the free tier — and so are the pages", async () => {
    vi.setSystemTime(new Date(Date.now() + 60 * DAY));
    expect((await personalPlan(fx.comped)).lines.get(LINE.key)?.standing.open).toBe(false);
    expect((await readLineHoldings(fx.comped)).get(LINE.key)).toEqual({ line: LINE.key, open: false, tierKey: null, onFree: LINE.free !== null });
    // The row still says live, which is why the pages don't read it.
    expect((await readSubscriptionsForTenant(fx.comped)).get(LINE.key)?.live).toBe(true);
    // What the overview lists is what the check grants: the free tier's, and none of the paid tier's.
    if (LINE.free !== null) {
      for (const feature of Object.values(LINE.free.features)) {
        if (feature.kind !== "flag") continue;
        expect((await entitlementOf(fx.comped, feature.feature)).allowed, feature.feature).toBe(feature.included);
      }
    }
  });

  it("a checkout that never finished is not a plan: neither the check nor the pages put the account on it", async () => {
    expect((await personalPlan(fx.stuck)).lines.get(LINE.key)?.standing.open).toBe(false);
    expect((await readLineHoldings(fx.stuck)).get(LINE.key)).toMatchObject({ open: false, tierKey: null });
    expect((await readSubscriptionsForTenant(fx.stuck)).get(LINE.key)?.live).toBe(true);
  });
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/refusals.test.ts (wherever plans are sold)
// ---------------------------------------------------------------------------

export function renderRefusalsTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { describe, expect, it, vi } from "vitest";
import { definePlans } from "${scope}/billing";
import { refusalFor } from "@/server/access";

/**
 * A REFUSAL NAMES ONLY PLANS ON SALE (billing 0.6, review): "comes with Team.
 * See plans to add it." for a Team that is still "coming", or a founding
 * members' tier no page offers, sends people to a plan they can't buy. The
 * same rule checkout uses (\`planOnSale\`).
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

const tiers = (reportsOn: { readonly pro: boolean }) =>
  definePlans({
    features: { reports: { kind: "flag", label: "Reports" } },
    tiers: [
      { key: "basic", name: "Basic", prices: { month: { usd: 500n } }, features: { reports: false } },
      { key: "pro", name: "Pro", prices: { month: { usd: 2000n } }, features: { reports: reportsOn.pro } },
      { key: "team", name: "Team", onSale: "coming", prices: { month: { usd: 5000n } }, features: { reports: true } },
      { key: "founders", name: "Founders", onSale: false, prices: { month: { usd: 1000n } }, features: { reports: true } },
      { key: "legacy", name: "Legacy", isActive: false, prices: { month: { usd: 900n } }, features: { reports: true } },
    ],
  });

describe("what a refusal says", () => {
  it("names the plans on sale that include it, and no other", () => {
    expect(refusalFor("reports", { reason: "no-entitlement" }, tiers({ pro: true }))).toBe("Reports comes with Pro. See plans to add it.");
  });

  it("NEGATIVE CONTROL: with nothing on sale that has it, says so rather than naming a plan nobody can buy", () => {
    expect(refusalFor("reports", { reason: "no-entitlement" }, tiers({ pro: false }))).toBe("Reports isn't on any plan right now.");
  });
});
`;
}
