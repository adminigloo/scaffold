import { describe, expect, it } from "vitest";
import { FIRM_WIDE } from "@adminigloo/permissions";
import {
  createInvitationService,
  UnknownRoleTemplateError,
  type InvitationService,
} from "../service.js";
import {
  generateInvitationToken,
  hashInvitationToken,
  normaliseInviteEmail,
} from "../invitations.js";
import { createFakePostgres, type FakePostgres, type InvitationRow } from "./fake-postgres.js";

/**
 * What the invitation service does to the database, which is the only part of
 * invitations that cannot be checked by reading the code.
 *
 * THE MEMBERSHIP WRITE IS THE SUBJECT. Everything else here — the token, the
 * hash, the four lifecycle states — is arithmetic tested in
 * `invitations.test.ts`, and all of it can be perfectly correct while the
 * feature does nothing at all. What makes an invitation real is a row in
 * `tenant_members` and a row in `principal_role`, written in the same
 * transaction that spends the token. These tests exist because a previous
 * version of this package shipped without them and the entire accept path was
 * missing behind a green suite.
 */

const TENANT = "tenant_northwind";
const INVITEE = "user_grace";
const INVITER = "user_ada";
const INVITEE_EMAIL = "grace@example.com";
const TEMPLATE_ID = "tmpl_member";
const NOW = new Date("2026-03-01T12:00:00.000Z");

function templates() {
  return [
    {
      id: TEMPLATE_ID,
      scope: "tenant",
      // Pinned to the real sentinel from @adminigloo/permissions rather than to
      // a literal. The service copies the value instead of importing it — the
      // permissions barrel re-exports it from the module that declares the
      // tables, which would drag drizzle-orm/pg-core into every client bundle
      // that touches this package's root — so this is the one place the copy is
      // checked against the original.
      tenant_id: FIRM_WIDE,
      key: "member",
      deleted_at: null,
    },
    {
      id: "tmpl_admin",
      scope: "tenant",
      tenant_id: FIRM_WIDE,
      key: "admin",
      deleted_at: null,
    },
  ];
}

function invitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: "inv_1",
    tenant_id: TENANT,
    email: INVITEE_EMAIL,
    template_id: TEMPLATE_ID,
    token_hash: hashInvitationToken("unused"),
    expires_at: new Date("2026-03-08T12:00:00.000Z"),
    revoked_at: null,
    revoked_by: null,
    accepted_at: null,
    invited_by: INVITER,
    created_at: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  readonly pg: FakePostgres;
  readonly service: InvitationService;
  readonly token: string;
}

/**
 * One tenant, one seeded template, one pending invitation for Grace, and Grace
 * signed in with the address it was sent to.
 */
function harness(
  overrides: Partial<InvitationRow> = {},
  options: { readonly requireMatchingEmail?: boolean; readonly accepterEmail?: string | null } = {},
): Harness {
  const { token, tokenHash } = generateInvitationToken();
  const pg = createFakePostgres({
    templates: templates(),
    invitations: [invitation({ token_hash: tokenHash, ...overrides })],
    users: [
      {
        id: INVITEE,
        email: options.accepterEmail === undefined ? INVITEE_EMAIL : options.accepterEmail,
        deleted_at: null,
      },
    ],
  });
  const service = createInvitationService({
    db: pg.db,
    now: () => NOW,
    ...(options.requireMatchingEmail === undefined
      ? {}
      : { requireMatchingEmail: options.requireMatchingEmail }),
  });
  return { pg, service, token };
}

describe("send", () => {
  it("stores only the hash, and hands the plaintext back exactly once", async () => {
    const pg = createFakePostgres({ templates: templates() });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    const sent = await service.send({
      tenantId: TENANT,
      email: "Grace@Example.com  ",
      roleTemplateKey: "member",
      invitedByUserId: INVITER,
      expiresInHours: 48,
    });

    const row = pg.tables.invitations[0];
    expect(row).toBeDefined();
    // The credential itself appears nowhere in the row. This is the property
    // that makes a database dump useless and "resend the same link" impossible.
    expect(JSON.stringify(row)).not.toContain(sent.token);
    expect(row?.token_hash).toBe(hashInvitationToken(sent.token));
    // Canonicalised at the boundary, because the partial unique index compares
    // bytes: Grace@Example.com and grace@example.com would otherwise be two
    // open invitations to one person.
    expect(row?.email).toBe(normaliseInviteEmail("Grace@Example.com"));
    expect(sent.expiresAt.toISOString()).toBe("2026-03-03T12:00:00.000Z");
    expect(sent.id).toBe(row?.id);
  });

  it("re-issuing rotates the hash on the SAME row rather than opening a second", async () => {
    const pg = createFakePostgres({ templates: templates() });
    const service = createInvitationService({ db: pg.db, now: () => NOW });
    const input = {
      tenantId: TENANT,
      email: INVITEE_EMAIL,
      roleTemplateKey: "member",
      invitedByUserId: INVITER,
    };

    const first = await service.send(input);
    const second = await service.send(input);

    // Pressing resend twice must not leave two live invitations racing for one
    // address — which is exactly what the partial unique index exists to stop
    // and why the write is an upsert.
    expect(pg.tables.invitations).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(second.token).not.toBe(first.token);
    expect(pg.tables.invitations[0]?.token_hash).toBe(
      hashInvitationToken(second.token),
    );
  });

  it("falls back to seven days when nobody names an expiry", async () => {
    const pg = createFakePostgres({ templates: templates() });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    const sent = await service.send({
      tenantId: TENANT,
      email: INVITEE_EMAIL,
      roleTemplateKey: "member",
      invitedByUserId: INVITER,
    });

    expect(sent.expiresAt.toISOString()).toBe("2026-03-08T12:00:00.000Z");
  });

  it("refuses a role nothing is seeded under, before minting a token", async () => {
    const pg = createFakePostgres({ templates: templates() });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    await expect(
      service.send({
        tenantId: TENANT,
        email: INVITEE_EMAIL,
        roleTemplateKey: "overlord",
        invitedByUserId: INVITER,
      }),
    ).rejects.toBeInstanceOf(UnknownRoleTemplateError);

    // Nothing written. An invitation carrying a role that does not exist would
    // spend correctly and grant nothing, which is the worst of both.
    expect(pg.tables.invitations).toHaveLength(0);
  });
});

describe("accept", () => {
  it("adds the member and the role in one transaction with the consume", async () => {
    const { pg, service, token } = harness();

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "accepted",
      tenantId: TENANT,
    });

    expect(pg.tables.members).toEqual([
      { tenant_id: TENANT, user_id: INVITEE, status: "active" },
    ]);
    expect(pg.tables.roles).toEqual([
      {
        principal_id: INVITEE,
        scope: "tenant",
        tenant_id: TENANT,
        template_id: TEMPLATE_ID,
      },
    ]);
    expect(pg.tables.invitations[0]?.accepted_at).toEqual(NOW);
    // The row is taken before anything is decided. Deciding first and locking
    // afterwards is the read-then-write that lets two redemptions both win.
    expect(pg.tags[0]).toBe("invitations/lock-by-token");
  });

  it("rolls the consume back when the membership write fails", async () => {
    const { pg, service, token } = harness();
    pg.failNext("invitations/add-member", new Error("connection reset"));

    await expect(service.accept(token, INVITEE)).rejects.toThrow("connection reset");

    // THE WHOLE POINT OF THE TRANSACTION. A consumed invitation with no
    // membership behind it cannot be repaired from the application: the
    // plaintext token is gone, and the row is outside the partial unique index
    // so a fresh invitation to the same address would sit beside it.
    expect(pg.tables.invitations[0]?.accepted_at).toBeNull();
    expect(pg.tables.members).toHaveLength(0);
    expect(pg.tables.roles).toHaveLength(0);
  });

  it("produces one membership when two redemptions of one link race", async () => {
    const { pg, service, token } = harness();

    const [first, second] = await Promise.all([
      service.accept(token, INVITEE),
      service.accept(token, INVITEE),
    ]);

    const outcomes = [first.status, second.status].sort();
    // The loser gets a real answer, not an exception and not a duplicate grant.
    // A double-click on the accept button is the ordinary case, not a thought
    // experiment.
    expect(outcomes).toEqual(["accepted", "already-a-member"]);
    expect(pg.tables.members).toHaveLength(1);
    expect(pg.tables.roles).toHaveLength(1);
    expect(
      pg.tables.invitations.filter((row) => row.accepted_at !== null),
    ).toHaveLength(1);
  });

  it("reports an expired link without joining anybody", async () => {
    const { pg, service, token } = harness({
      expires_at: new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({ status: "expired" });
    expect(pg.tables.members).toHaveLength(0);
    expect(pg.tables.invitations[0]?.accepted_at).toBeNull();
  });

  it("treats the expiry instant itself as expired", async () => {
    // Closed boundary, matching `invitationState`. The open form leaves a token
    // usable for the millisecond it is stamped dead.
    const { service, token } = harness({ expires_at: NOW });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({ status: "expired" });
  });

  it("reports a withdrawn link without joining anybody", async () => {
    const { pg, service, token } = harness({
      revoked_at: new Date("2026-02-20T00:00:00.000Z"),
      revoked_by: INVITER,
    });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({ status: "revoked" });
    expect(pg.tables.members).toHaveLength(0);
  });

  it("leaves an existing member exactly as they were, and the invitation open", async () => {
    const { pg, service, token } = harness();
    pg.tables.members.push({ tenant_id: TENANT, user_id: INVITEE, status: "active" });
    pg.tables.roles.push({
      principal_id: INVITEE,
      scope: "tenant",
      tenant_id: TENANT,
      template_id: "tmpl_admin",
    });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "already-a-member",
      tenantId: TENANT,
    });

    // The existing role is untouched: an invitation never quietly overwrites
    // access somebody already has — in this case it would have been a demotion.
    expect(pg.tables.roles[0]?.template_id).toBe("tmpl_admin");
    // And nothing is spent, so whoever sent it can still see it and withdraw it
    // rather than wondering why it vanished having changed nothing.
    expect(pg.tables.invitations[0]?.accepted_at).toBeNull();
  });

  it("refuses an account whose verified address is not the invited one", async () => {
    const { pg, service, token } = harness({}, { accepterEmail: "eve@example.com" });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "wrong-email",
      invitedEmail: INVITEE_EMAIL,
    });
    expect(pg.tables.members).toHaveLength(0);
    expect(pg.tables.invitations[0]?.accepted_at).toBeNull();
  });

  it("refuses an account with no verified address at all", async () => {
    // Fails closed. "We do not know who you are" must never read as "you match".
    const { service, token } = harness({}, { accepterEmail: null });

    await expect(service.accept(token, INVITEE)).resolves.toMatchObject({
      status: "wrong-email",
    });
  });

  it("compares addresses case-insensitively, both sides canonicalised", async () => {
    const { service, token } = harness(
      { email: "grace@example.com" },
      { accepterEmail: "Grace@Example.COM" },
    );

    await expect(service.accept(token, INVITEE)).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("answers wrong-email BEFORE reporting the state of the invitation", async () => {
    // A stranger holding a forwarded link must not learn that a token like
    // theirs exists, nor which organisation it belongs to. Every refusal to a
    // non-recipient is the same refusal.
    const { service, token } = harness(
      { expires_at: new Date("2026-01-01T00:00:00.000Z") },
      { accepterEmail: "eve@example.com" },
    );

    await expect(service.accept(token, INVITEE)).resolves.toMatchObject({
      status: "wrong-email",
    });
  });

  it("joins a mismatched address once the match is switched off", async () => {
    // The regime the token strength actually permits: 256 bits of CSPRNG output
    // means possession of the link is evidence of receipt. Documented here so
    // that switching it is a decision somebody took rather than a default
    // nobody noticed.
    const { pg, service, token } = harness(
      {},
      { accepterEmail: "eve@example.com", requireMatchingEmail: false },
    );

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "accepted",
      tenantId: TENANT,
    });
    expect(pg.tables.members).toHaveLength(1);
  });

  it("says nothing about a token it has never seen", async () => {
    const { pg, service } = harness();
    const stranger = generateInvitationToken();

    await expect(service.accept(stranger.token, INVITEE)).resolves.toEqual({
      status: "unknown-token",
    });
    expect(pg.tables.members).toHaveLength(0);
  });

  it("reports a link somebody else already spent as unrecognised", async () => {
    // Identical to a token that never existed, deliberately: telling the two
    // apart turns this into an oracle for anybody holding a list of guesses.
    const { service, token } = harness({
      accepted_at: new Date("2026-02-25T00:00:00.000Z"),
    });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "unknown-token",
    });
  });

  it("reports a link this account already spent as already-a-member", async () => {
    const { pg, service, token } = harness({
      accepted_at: new Date("2026-02-25T00:00:00.000Z"),
    });
    pg.tables.members.push({ tenant_id: TENANT, user_id: INVITEE, status: "active" });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "already-a-member",
      tenantId: TENANT,
    });
  });

  it("still joins somebody whose role template has been deleted since", async () => {
    // A member with no role is a real, renderable state — the members page says
    // so — and refusing the whole acceptance would strand the invitee with a
    // spent link and nothing to show for it.
    const { pg, service, token } = harness({ template_id: null });

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "accepted",
      tenantId: TENANT,
    });
    expect(pg.tables.members).toHaveLength(1);
    expect(pg.tables.roles).toHaveLength(0);
  });

  it("refuses a row whose stored hash has been corrupted", async () => {
    // `verifyInvitationToken` is what catches this. An equality test in the
    // database would match a truncated hash against whatever it decoded to.
    const { pg, service, token } = harness();
    const row = pg.tables.invitations[0];
    // Flip the last character to something it is NOT. Overwriting it with a
    // fixed "0" corrupted nothing on the one hash in sixteen already ending in
    // "0" — the token then verified, `accept` succeeded, and the suite failed
    // roughly every third run for reasons that looked like infrastructure.
    if (row) {
      const last = row.token_hash.slice(-1);
      row.token_hash = `${row.token_hash.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    }

    await expect(service.accept(token, INVITEE)).resolves.toEqual({
      status: "unknown-token",
    });
  });
});

describe("revoke", () => {
  it("stamps the withdrawal and records who did it", async () => {
    const { pg, service } = harness();

    await service.revoke("inv_1", INVITER);

    expect(pg.tables.invitations[0]?.revoked_at).toEqual(NOW);
    expect(pg.tables.invitations[0]?.revoked_by).toBe(INVITER);
  });

  it("keeps the first timestamp when it is withdrawn twice", async () => {
    const already = new Date("2026-02-02T00:00:00.000Z");
    const { pg, service } = harness({ revoked_at: already, revoked_by: "user_first" });

    await service.revoke("inv_1", "user_second");

    expect(pg.tables.invitations[0]?.revoked_at).toEqual(already);
    expect(pg.tables.invitations[0]?.revoked_by).toBe("user_first");
  });

  it("does not fail on an id that is not there", async () => {
    const { service } = harness();
    await expect(service.revoke("inv_nowhere", INVITER)).resolves.toBeUndefined();
  });
});

describe("listForTenant", () => {
  it("classifies every row and names the role it carries", async () => {
    const pg = createFakePostgres({
      templates: templates(),
      invitations: [
        invitation({ id: "inv_pending", created_at: new Date("2026-03-01T04:00:00Z") }),
        invitation({
          id: "inv_expired",
          expires_at: new Date("2026-01-01T00:00:00Z"),
          created_at: new Date("2026-03-01T03:00:00Z"),
        }),
        invitation({
          id: "inv_revoked",
          revoked_at: new Date("2026-02-01T00:00:00Z"),
          created_at: new Date("2026-03-01T02:00:00Z"),
        }),
        invitation({
          id: "inv_accepted",
          accepted_at: new Date("2026-02-01T00:00:00Z"),
          created_at: new Date("2026-03-01T01:00:00Z"),
        }),
        invitation({
          id: "inv_other_tenant",
          tenant_id: "tenant_elsewhere",
          created_at: new Date("2026-03-01T05:00:00Z"),
        }),
      ],
    });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    const rows = await service.listForTenant(TENANT);

    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["inv_pending", "pending"],
      ["inv_expired", "expired"],
      ["inv_revoked", "revoked"],
      ["inv_accepted", "accepted"],
    ]);
    expect(rows.every((row) => row.roleTemplateKey === "member")).toBe(true);
  });

  it("lists a row whose template has been deleted, with an empty role key", async () => {
    // Hiding it would leave an invitation that can be redeemed and cannot be
    // seen or withdrawn. The empty key then fails the rank guard downstream,
    // which is the closed direction.
    const pg = createFakePostgres({
      templates: templates(),
      invitations: [invitation({ template_id: "tmpl_deleted" })],
    });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    const rows = await service.listForTenant(TENANT);

    expect(rows[0]?.roleTemplateKey).toBe("");
    expect(rows[0]?.state).toBe("pending");
  });

  it("reports a never-expiring invitation as pending with a null expiry", async () => {
    const pg = createFakePostgres({
      templates: templates(),
      invitations: [invitation({ expires_at: null })],
    });
    const service = createInvitationService({ db: pg.db, now: () => NOW });

    const rows = await service.listForTenant(TENANT);

    expect(rows[0]?.expiresAt).toBeNull();
    expect(rows[0]?.state).toBe("pending");
  });
});
