import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { roleTemplate, roleTemplateGrant } from "__SCOPE__/permissions/schema";
import { assignRoleTemplate } from "__SCOPE__/permissions/server";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { createScaffoldContext } from "__SCOPE__/trpc";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";

/**
 * Per-person permission changes follow the same rank rules as giving someone
 * a role (review T1-05).
 *
 * `admin.setOverride` used to check only that the caller held
 * `staff.roles.manage`. Whoever held it could give THEMSELVES every other
 * staff key — administrator in all but name — or hand a company member access
 * their role never gave them. These prove each rule on the real router and a
 * real (in-process) Postgres.
 *
 * The "manager" role below is a custom staff template (rank 20, between the
 * customer service agent and the administrator) that holds
 * `staff.roles.manage` — the shape a business builds when it trusts a lead to
 * manage the agents.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

interface Person {
  readonly id: string;
  readonly email: string;
}

const people = {} as { admin: Person; manager: Person; agent: Person; outsider: Person };

async function person(externalId: string, email: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email }).returning();
  if (!row) throw new Error("could not create the test person");
  return { id: row.id, email };
}

async function giveStaffRole(who: Person, templateKey: string): Promise<void> {
  await assignRoleTemplate(db, {
    scope: "staff",
    principalId: who.id,
    templateKey,
    actor: { system: "test" },
  });
}

function asPerson(who: Person) {
  const principal: Principal = { userId: who.id, externalId: `ext_${who.id}`, email: who.email };
  return createCallerFactory(appRouter)(createScaffoldContext({ principal }));
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });

  const [manager] = await db
    .insert(roleTemplate)
    .values({ scope: "staff", tenantId: FIRM_WIDE, key: "manager", name: "Manager", rank: 20, isSystem: false })
    .returning({ id: roleTemplate.id });
  for (const permission of ["staff.roles.manage", "staff.roles.view", "staff.dashboard.view"]) {
    await db.insert(roleTemplateGrant).values({ templateId: manager!.id, permission, effect: "allow" });
  }

  people.admin = await person("ext_overrides_admin", "admin@platform.test");
  people.manager = await person("ext_overrides_manager", "manager@platform.test");
  people.agent = await person("ext_overrides_agent", "agent@platform.test");
  people.outsider = await person("ext_overrides_outsider", "outsider@platform.test");
  await giveStaffRole(people.admin, "admin");
  await giveStaffRole(people.manager, "manager");
  await giveStaffRole(people.agent, "cs_agent");

  // A customer's company, with the agent on its team (a staff member can also
  // be someone's employee) and the outsider not.
  await db.insert(tenants).values({ id: "t_customer", kind: "org", slug: "customer-co", name: "Customer Co", ownerUserId: people.admin.id });
  await db.insert(tenantMembers).values({ tenantId: "t_customer", userId: people.agent.id, status: "active" });
});

describe("per-person staff access", () => {
  it("refuses changing your own access", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.manager.id,
        scope: "staff",
        permission: "staff.tenants.suspend",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("your own access") });
  });

  it("refuses giving someone access you don't have yourself", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.agent.id,
        scope: "staff",
        permission: "staff.tenants.suspend",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("you have yourself") });
  });

  it("refuses changing someone at or above your rank", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.admin.id,
        scope: "staff",
        permission: "staff.dashboard.view",
        effect: "deny",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a change for someone with no staff role (it would do nothing)", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.outsider.id,
        scope: "staff",
        permission: "staff.dashboard.view",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("no staff role") });
  });

  it("allows a change below you, for access you hold", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.agent.id,
        scope: "staff",
        permission: "staff.roles.view",
        effect: "allow",
      }),
    ).resolves.toBeDefined();
  });
});

describe("per-person access inside a customer's company", () => {
  it("only the top staff rank may GIVE extra access", async () => {
    await expect(
      asPerson(people.manager).admin.setOverride({
        principalId: people.agent.id,
        scope: "tenant",
        tenantId: "t_customer",
        permission: "members.invite",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Only an administrator") });

    await expect(
      asPerson(people.admin).admin.setOverride({
        principalId: people.agent.id,
        scope: "tenant",
        tenantId: "t_customer",
        permission: "members.invite",
        effect: "allow",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses extra access for someone who isn't on that company's team (review R2 F3)", async () => {
    // A screen opened before they were removed must not give them access that
    // lies dormant until they're invited back.
    await expect(
      asPerson(people.admin).admin.setOverride({
        principalId: people.outsider.id,
        scope: "tenant",
        tenantId: "t_customer",
        permission: "tenant.edit",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("isn't on that company's team") });
    // Clearing one is always allowed: it can only take access away.
    await expect(
      asPerson(people.admin).admin.setOverride({
        principalId: people.outsider.id,
        scope: "tenant",
        tenantId: "t_customer",
        permission: "tenant.edit",
        effect: "inherit",
      }),
    ).resolves.toBeDefined();
  });
});
