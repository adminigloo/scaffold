import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "__SCOPE__/auth";
import { asTenantUser, buildPrincipal } from "__SCOPE__/testing/auth";
import { withPermissions } from "__SCOPE__/testing/permissions";
import { createScaffoldContext } from "__SCOPE__/trpc";
import type { PermissionLoaders } from "__SCOPE__/trpc";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";
import type { TenantPermission } from "@/permissions/catalog";

/**
 * The invitations router: the rung each procedure sits on, and what it does
 * with each answer the service can give.
 *
 * WHAT IS REAL HERE: the router, the procedure ladder, the permission
 * middleware, the audit call and the outcome mapping. WHAT IS FAKED: the
 * invitation service, the mailer and the database. The split is deliberate —
 * every rule about tokens, expiry and single use belongs to
 * @__SCOPE_NAME__/tenancy and is tested there, and re-testing it through four
 * layers of tRPC would only prove that two copies of the same rule agree. What
 * cannot be tested anywhere else is the part this file is about: that `accept`
 * is reachable by somebody who is not a member, that everything else is not,
 * that a refusal never writes an audit row, and that the token never leaves
 * except in the one case that needs it.
 *
 * `accept` IS THE CASE WORTH THE MOST ATTENTION. It is the only procedure in
 * the project built from `protectedProcedure` rather than a tenant or staff
 * rung, and the reason is structural: an invitee is by definition not a member
 * of the tenant they are joining, so `requireTenant` would deny exactly the
 * person the feature exists for. That makes the token the authorisation, and it
 * makes "does a non-member reach this handler" a property worth pinning rather
 * than assuming.
 */

const loaders = vi.hoisted(() => ({
  loadTenantPermissions: vi.fn<PermissionLoaders["loadTenantPermissions"]>(),
  loadStaffPermissions: vi.fn<PermissionLoaders["loadStaffPermissions"]>(),
}));

vi.mock("@/server/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/permissions")>()),
  ...loaders,
}));

/**
 * The service, as the router sees it.
 *
 * Replaced wholesale rather than partially, so importing this test never
 * constructs the real one — which would open a database handle and read the
 * environment for a suite that touches neither.
 */
const service = vi.hoisted(() => ({
  send: vi.fn(),
  accept: vi.fn(),
  revoke: vi.fn(),
  listForTenant: vi.fn(),
}));

vi.mock("@/server/invitations", () => ({
  invitations: service,
  INVITATION_EXPIRY_HOURS: 168,
  invitationUrl: (token: string) => `https://example.test/invite/${token}`,
}));

const mail = vi.hoisted(() => ({ sendInvitationEmail: vi.fn() }));
vi.mock("@/server/invitation-mail", () => mail);

/**
 * Just enough Drizzle to satisfy the two things this router asks a database
 * for: the actor's role template, and somewhere to put an audit row.
 *
 * Hand-rolled rather than mocked away entirely, because `written` is an
 * assertion target in half the tests below — "the refusal wrote nothing" is
 * only checkable if the writes are observable.
 */
const database = vi.hoisted(() => ({
  /** Every row handed to `db.insert(...).values(...)`, in order. */
  written: [] as Record<string, unknown>[],
  /** What the actor's role lookup returns. Set per test. */
  actorRole: [{ key: "owner" }] as { key: string }[],
  tenantName: "Northwind Trading" as string | null,
}));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        database.written.push(row);
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve(database.actorRole) }),
        }),
      }),
    }),
    query: {
      tenants: {
        findFirst: () =>
          Promise.resolve(
            database.tenantName === null ? undefined : { name: database.tenantName },
          ),
      },
    },
  },
}));

const createCaller = createCallerFactory(appRouter);

/** A fresh context per call: the permission cache inside one is request-scoped. */
function caller(principal: Principal | null) {
  return createCaller(createScaffoldContext({ principal }));
}

const TENANT = "tenant_northwind";
const INVITER = asTenantUser();
const INVITEE = buildPrincipal({ userId: "user_invitee", email: "grace@example.com" });

/** The audit actions this router wrote during one test. */
function auditedActions(): string[] {
  return database.written.flatMap((row) =>
    typeof row["action"] === "string" ? [row["action"]] : [],
  );
}

function mayInvite() {
  loaders.loadTenantPermissions.mockResolvedValue(
    withPermissions<TenantPermission>(["members.view", "members.invite"]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  database.written = [];
  database.actorRole = [{ key: "owner" }];
  database.tenantName = "Northwind Trading";
  // Deny by default. A suite whose default is "member of everything" only ever
  // exercises the happy path, and the middleware could be deleted unnoticed.
  loaders.loadTenantPermissions.mockResolvedValue(null);
  loaders.loadStaffPermissions.mockResolvedValue(null);
  mail.sendInvitationEmail.mockResolvedValue({ status: "sent", delivered: true });
  service.listForTenant.mockResolvedValue([]);
});

describe("the rung each procedure sits on", () => {
  it("refuses to list invitations for somebody who is not signed in", async () => {
    await expect(
      caller(null).invitations.list({ tenantId: TENANT }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to list invitations for somebody who is not a member", async () => {
    // NULL, not an empty set. An empty set means "a member granted nothing",
    // and had the loader returned that, the call would have reached the handler
    // with ctx.tenantId set to a tenant the caller merely typed.
    loaders.loadTenantPermissions.mockResolvedValue(null);

    await expect(
      caller(INVITER).invitations.list({ tenantId: TENANT }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a member who can see the roster but not invite", async () => {
    // The two keys are separate on purpose: an invitation is the address of
    // somebody who is not in the tenant, so it does not travel with the member
    // list. This is the assertion that keeps them apart.
    loaders.loadTenantPermissions.mockResolvedValue(
      withPermissions<TenantPermission>(["members.view"]),
    );

    await expect(
      caller(INVITER).invitations.list({ tenantId: TENANT }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied: members.invite",
    });
  });

  it("admits a member who holds members.invite", async () => {
    mayInvite();
    service.listForTenant.mockResolvedValue([]);

    await expect(
      caller(INVITER).invitations.list({ tenantId: TENANT }),
    ).resolves.toEqual({ invitations: [] });
  });

  it("lets somebody who is a member of NOTHING accept an invitation", async () => {
    // The whole point. `loadTenantPermissions` returns null — this principal
    // belongs to no tenant at all — and the call still reaches the handler,
    // because acceptance is what makes them a member. Built from
    // `requireTenant` instead, this would deny every invitee who ever followed
    // a link, and the message would be "Not a member of tenant …".
    loaders.loadTenantPermissions.mockResolvedValue(null);
    service.accept.mockResolvedValue({ status: "accepted", tenantId: TENANT });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "accepted",
      tenantName: "Northwind Trading",
    });
  });

  it("still refuses to accept for somebody with no account", async () => {
    // One rung lower than tenant, not off the ladder. Acceptance has to attach
    // a membership to an account, and there is nothing to attach it to here.
    await expect(
      caller(null).invitations.accept({ token: "t" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(service.accept).not.toHaveBeenCalled();
  });
});

describe("what acceptance answers", () => {
  beforeEach(() => {
    loaders.loadTenantPermissions.mockResolvedValue(null);
  });

  it("reports an expired token instead of joining anybody", async () => {
    service.accept.mockResolvedValue({ status: "expired" });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "expired",
    });
    // Nothing happened, so nothing is recorded. An audit row for an acceptance
    // that did not occur is worse than no row: it is the row a review would
    // read as the moment this person gained access.
    expect(auditedActions()).toEqual([]);
  });

  it("reports a revoked token instead of joining anybody", async () => {
    service.accept.mockResolvedValue({ status: "revoked" });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "revoked",
    });
    expect(auditedActions()).toEqual([]);
  });

  it("reports a mismatched address without naming the invited one", async () => {
    // The service knows who it was for. Whoever is holding the link may not be
    // that person, and a refusal that names them hands a stranger a
    // colleague's email address.
    service.accept.mockResolvedValue({
      status: "wrong-email",
      invitedEmail: "someone.else@example.com",
    });

    const result = await caller(INVITEE).invitations.accept({ token: "t" });

    expect(result).toEqual({ status: "wrong-email" });
    expect(JSON.stringify(result)).not.toContain("someone.else@example.com");
  });

  it("says nothing about whether an unknown token ever existed", async () => {
    service.accept.mockResolvedValue({ status: "unknown-token" });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "unknown",
    });
  });

  it("fails closed on an outcome this build does not recognise", async () => {
    // A future release of the package can add a case. Until this app knows
    // what it means, the only safe reading is "this link cannot be used" — the
    // alternative is a `default` that falls through to success.
    service.accept.mockResolvedValue({ status: "suspended-tenant" });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "unknown",
    });
    expect(auditedActions()).toEqual([]);
  });

  it("leaves an existing member exactly as they were", async () => {
    service.accept.mockResolvedValue({ status: "already-a-member", tenantId: TENANT });

    await expect(caller(INVITEE).invitations.accept({ token: "t" })).resolves.toEqual({
      status: "already-a-member",
      tenantName: "Northwind Trading",
    });
    // Not an acceptance, so not audited as one. Recording it would put a second
    // "joined" event in the trail for one join.
    expect(auditedActions()).toEqual([]);
  });

  it("records the invitee as the actor when somebody does join", async () => {
    service.accept.mockResolvedValue({ status: "accepted", tenantId: TENANT });

    await caller(INVITEE).invitations.accept({ token: "t" });

    expect(auditedActions()).toEqual(["invitation.accepted"]);
    expect(database.written[0]).toMatchObject({
      action: "invitation.accepted",
      actorUserId: INVITEE.userId,
      tenantId: TENANT,
      // Read from the registry, never from the caller. This is the event the
      // "who could have seen this data" review starts from.
      isSensitive: true,
    });
  });

  it("never writes the token into the trail", async () => {
    service.accept.mockResolvedValue({ status: "accepted", tenantId: TENANT });

    await caller(INVITEE).invitations.accept({ token: "a-real-looking-token" });

    expect(JSON.stringify(database.written)).not.toContain("a-real-looking-token");
  });
});

describe("issuing one", () => {
  beforeEach(() => {
    mayInvite();
    service.send.mockResolvedValue({
      id: "inv_1",
      token: "fresh-token",
      expiresAt: new Date("2026-01-08T00:00:00.000Z"),
    });
  });

  it("hands the link back when no mail could be sent", async () => {
    // The state every generated project starts in: no Resend key, so the send
    // is recorded as skipped and nothing leaves the building. Without the link
    // the feature would be unusable until somebody found a credential.
    mail.sendInvitationEmail.mockResolvedValue({ status: "skipped", delivered: false });

    const result = await caller(INVITER).invitations.send({
      tenantId: TENANT,
      email: "grace@example.com",
      roleTemplateKey: "member",
    });

    expect(result.delivery).toBe("skipped");
    expect(result.link).toBe("https://example.test/invite/fresh-token");
  });

  it("withholds the link once a provider has taken the message", async () => {
    // The invitee has it in their inbox. Returning it as well would put a
    // bearer credential for somebody else's account in the inviter's browser
    // history for no benefit at all.
    mail.sendInvitationEmail.mockResolvedValue({ status: "sent", delivered: true });

    const result = await caller(INVITER).invitations.send({
      tenantId: TENANT,
      email: "grace@example.com",
      roleTemplateKey: "member",
    });

    expect(result.delivery).toBe("sent");
    expect(result.link).toBeNull();
  });

  it("keeps the token out of the audit row", async () => {
    await caller(INVITER).invitations.send({
      tenantId: TENANT,
      email: "grace@example.com",
      roleTemplateKey: "member",
    });

    expect(auditedActions()).toEqual(["invitation.sent"]);
    expect(JSON.stringify(database.written)).not.toContain("fresh-token");
    expect(database.written[0]).toMatchObject({
      action: "invitation.sent",
      tenantId: TENANT,
      resourceId: "inv_1",
    });
  });

  it("refuses to hand out a role at or above the inviter's own", async () => {
    // `members.invite` says you may invite. It does not say you may create your
    // own replacement: an admin who can issue an owner invitation mails it to
    // an address they control and collects `tenant.transfer`, which the catalog
    // seals precisely so it cannot be granted one person at a time.
    database.actorRole = [{ key: "admin" }];

    await expect(
      caller(INVITER).invitations.send({
        tenantId: TENANT,
        email: "grace@example.com",
        roleTemplateKey: "owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.send).not.toHaveBeenCalled();

    // Equal ranks fail too. Two admins who can each create the other's
    // replacement turn a disagreement into a race, and no rank changed, so
    // nothing in the trail looks like an escalation.
    await expect(
      caller(INVITER).invitations.send({
        tenantId: TENANT,
        email: "grace@example.com",
        roleTemplateKey: "admin",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an actor holding the permission but no role template", async () => {
    // Reachable only through a per-person override. "No rank" must never read
    // as "no restriction".
    database.actorRole = [];

    await expect(
      caller(INVITER).invitations.send({
        tenantId: TENANT,
        email: "grace@example.com",
        roleTemplateKey: "viewer",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a role the shipped templates do not contain", async () => {
    await expect(
      caller(INVITER).invitations.send({
        tenantId: TENANT,
        email: "grace@example.com",
        roleTemplateKey: "superuser",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("acting on one that already exists", () => {
  beforeEach(mayInvite);

  const open = {
    id: "inv_1",
    email: "grace@example.com",
    roleTemplateKey: "member",
    state: "pending" as const,
    expiresAt: new Date("2026-01-08T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("will not revoke an id that belongs to a different tenant", async () => {
    // `revoke(id, byUserId)` takes no tenant, so an id alone would be enough to
    // cancel a stranger's invitation from inside your own organisation. The
    // ladder cannot catch it — the caller really does hold `members.invite`,
    // just somewhere else — so the id is resolved through this tenant's list
    // first. Anything not in it is NOT_FOUND, which is also the truth.
    service.listForTenant.mockResolvedValue([open]);

    await expect(
      caller(INVITER).invitations.revoke({ tenantId: TENANT, id: "inv_somebody_else" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(service.revoke).not.toHaveBeenCalled();
    expect(auditedActions()).toEqual([]);
  });

  it("revokes one of its own and records what it was", async () => {
    service.listForTenant.mockResolvedValue([{ ...open, state: "expired" as const }]);

    await caller(INVITER).invitations.revoke({ tenantId: TENANT, id: "inv_1" });

    expect(service.revoke).toHaveBeenCalledWith("inv_1", INVITER.userId);
    expect(auditedActions()).toEqual(["invitation.revoked"]);
  });

  it("resends by issuing a NEW token, because there is no old one left", async () => {
    // Only the hash is stored. The string that went out exists in one place —
    // the mail — so re-sending the same link is not something this system can
    // do, and that is the property that makes a database dump useless.
    service.listForTenant.mockResolvedValue([open]);
    service.send.mockResolvedValue({
      id: "inv_1",
      token: "rotated-token",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    mail.sendInvitationEmail.mockResolvedValue({ status: "skipped", delivered: false });

    const result = await caller(INVITER).invitations.resend({
      tenantId: TENANT,
      id: "inv_1",
    });

    expect(service.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        email: "grace@example.com",
        roleTemplateKey: "member",
      }),
    );
    expect(result.link).toBe("https://example.test/invite/rotated-token");
  });

  it("re-checks rank on resend rather than trusting the original send", async () => {
    // The person pressing resend may not be the person who sent it, and a
    // demotion between the two is exactly when it matters.
    service.listForTenant.mockResolvedValue([{ ...open, roleTemplateKey: "admin" }]);
    database.actorRole = [{ key: "admin" }];

    await expect(
      caller(INVITER).invitations.resend({ tenantId: TENANT, id: "inv_1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.send).not.toHaveBeenCalled();
  });

  it("lists only what is still worth acting on", async () => {
    service.listForTenant.mockResolvedValue([
      open,
      { ...open, id: "inv_2", state: "expired" as const },
      { ...open, id: "inv_3", state: "accepted" as const },
      { ...open, id: "inv_4", state: "revoked" as const },
    ]);

    const { invitations: rows } = await caller(INVITER).invitations.list({
      tenantId: TENANT,
    });

    // An accepted invitation is a member now and belongs in the roster; a
    // revoked one is a decision already taken. Leaving both in turns a short
    // actionable table into an event log with two buttons that do nothing.
    expect(rows.map((row) => row.id)).toEqual(["inv_1", "inv_2"]);
    expect(rows[0]?.roleName).toBe("Member");
  });
});
