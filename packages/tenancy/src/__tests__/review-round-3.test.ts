import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTenancyHandlers, INVITATION_EMAILS_PER_ADDRESS_PER_DAY } from "../server.js";
import { call, handlersFor, harness, jsonOf, type Harness } from "./harness.js";

/**
 * Review round 3 (Tenancy 1), the server half: the per-address email limits
 * on invitations (SEC-T1-B) and the wrong-account note an owner sees beside
 * an invitation (T1BO-07). Through the HTTP handlers, the way the team page
 * reaches them, on a real Postgres (PGlite).
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

interface IssuedBody {
  delivery: string;
  link: string | null;
  note: string | null;
  replaced: boolean;
  invitation: { id: string; roleKey: string | null; wrongAccount: { signedInAs: string | null; at: string } | null };
}

const MINUTE = 60_000;

async function summit() {
  const owner = await h.user("olivia@summit.test", { name: "Olivia" });
  const tenantId = await h.company(owner, "Summit Windows");
  const outbox: { to: string; url: string }[] = [];
  const { company } = handlersFor(h, {
    deliverInvitation: async (input) => {
      outbox.push({ to: input.to, url: input.url });
      return { status: "sent" };
    },
  });
  const invite = async (email: string, roleKey = "member") =>
    jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations`, { email, roleKey }));
  const resend = async (invitationId: string) =>
    jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations/${invitationId}/resend`, {}));
  const later = (ms: number) => {
    h.clock.now = new Date(h.clock.now.getTime() + ms);
  };
  return { owner, tenantId, company, outbox, invite, resend, later };
}

describe("SEC-T1-B: one company emails one address at most once every 10 minutes, and a few times a day", () => {
  it("a Resend inside 10 minutes is saved but not emailed, says why in plain words, and hands over the link", async () => {
    h = await harness();
    const s = await summit();
    const first = await s.invite("crew@summit.test");
    expect(first).toMatchObject({ delivery: "sent", link: null, note: null });
    expect(s.outbox).toHaveLength(1);

    s.later(3 * MINUTE);
    const again = await s.resend(first.invitation.id);
    expect(again.delivery).toBe("held");
    expect(again.link).toMatch(/^https:\/\/app\.test\/invite\//);
    expect(again.note).toBe(
      "We emailed crew@summit.test 3 minutes ago, so we didn't email them again yet. Emails can take a few minutes to arrive. " +
        "The link in the email we already sent still works. You can email it again in 7 minutes, or copy the link below and send it yourself.",
    );
    expect(s.outbox).toHaveLength(1);
    // The first email's link still lets them in (nothing was lost by holding).
    const crew = await h.user("crew@summit.test");
    expect((await h.tenancy.acceptInvitation({ token: s.outbox[0]!.url.split("/").pop()!, userId: crew })).status).toBe("accepted");
  });

  it("never blocks the first send, another address, another company, or a re-invite at a different role from being saved", async () => {
    h = await harness();
    const s = await summit();
    const first = await s.invite("crew@summit.test", "member");
    // Re-inviting the same address as an Admin a minute later: the role
    // change is SAVED (and audited); only the email waits.
    s.later(MINUTE);
    const promoted = await s.invite("crew@summit.test", "admin");
    expect(promoted).toMatchObject({ delivery: "held", replaced: true, invitation: { id: first.invitation.id, roleKey: "admin" } });
    expect(promoted.note).toContain("The link in the email we already sent still works and now gives the Admin role.");
    const row = (await h.db.execute(sql`select (select key from role_template where id = template_id) as role from tenant_invitations where id = ${first.invitation.id}`)).rows[0];
    expect(row).toEqual({ role: "admin" });
    expect(h.audit.filter((e) => e.action === "invitation.sent").at(-1)?.metadata).toMatchObject({ previousRoleKey: "member", roleKey: "admin", emailHeld: "cooldown" });

    // Another address, and the same address from another company: emailed.
    expect((await s.invite("office@summit.test")).delivery).toBe("sent");
    const bea = await h.user("bea@beta.test");
    const beta = await h.company(bea, "Beta Plumbing");
    const other = await call(s.company, bea, "POST", `v1/companies/${beta}/invitations`, { email: "crew@summit.test", roleKey: "member" });
    expect((await jsonOf<IssuedBody>(other)).delivery).toBe("sent");
    expect(s.outbox.map((m) => m.to)).toEqual(["crew@summit.test", "office@summit.test", "crew@summit.test"]);

    // Ten minutes after the last email, Resend emails again.
    s.later(9 * MINUTE);
    expect((await s.resend(first.invitation.id)).delivery).toBe("sent");
    expect(s.outbox).toHaveLength(4);
  });

  it(`at most ${INVITATION_EMAILS_PER_ADDRESS_PER_DAY} a day to one address, withdrawing and inviting again counted too; the next day it emails again`, async () => {
    h = await harness();
    const s = await summit();
    let current = await s.invite("crew@summit.test");
    for (let i = 1; i < INVITATION_EMAILS_PER_ADDRESS_PER_DAY; i += 1) {
      s.later(11 * MINUTE);
      current = await s.resend(current.invitation.id);
      expect(current.delivery, `email ${i + 1}`).toBe("sent");
    }
    expect(s.outbox).toHaveLength(INVITATION_EMAILS_PER_ADDRESS_PER_DAY);

    s.later(11 * MINUTE);
    const capped = await s.resend(current.invitation.id);
    expect(capped.delivery).toBe("held");
    expect(capped.note).toContain(`crew@summit.test has had ${INVITATION_EMAILS_PER_ADDRESS_PER_DAY} invitation emails from Summit Windows in the last day, so we didn't email them again.`);
    expect(capped.note).toContain("You can email it again in about 23 hours");

    // Withdraw and invite again: a new invitation is saved (it's on the
    // list), but it isn't a way round the day's emails.
    await call(s.company, s.owner, "POST", `v1/companies/${s.tenantId}/invitations/${current.invitation.id}/revoke`, {});
    const fresh = await s.invite("crew@summit.test");
    expect(fresh.delivery).toBe("held");
    expect(fresh.note).not.toContain("still works");
    const listed = await jsonOf<{ invitations: { id: string }[] }>(await call(s.company, s.owner, "GET", `v1/companies/${s.tenantId}/invitations`));
    expect(listed.invitations.map((i) => i.id)).toContain(fresh.invitation.id);
    expect(s.outbox).toHaveLength(INVITATION_EMAILS_PER_ADDRESS_PER_DAY);

    s.later(24 * 60 * MINUTE);
    expect((await s.resend(fresh.invitation.id)).delivery).toBe("sent");
  });

  it("with no deliverer nobody is emailed, so nothing is held: the link every time", async () => {
    h = await harness();
    const owner = await h.user("olivia@summit.test");
    const tenantId = await h.company(owner, "Summit Windows");
    const { company } = handlersFor(h);
    const first = await jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations`, { email: "crew@summit.test", roleKey: "member" }));
    const again = await jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations/${first.invitation.id}/resend`, {}));
    expect([first.delivery, again.delivery]).toEqual(["skipped", "skipped"]);
    expect(again.note).toBeNull();
  });
});

describe("T1BO-07: the owner sees, beside the invitation, that someone tried it signed in as someone else", () => {
  it("a wrong-account Accept is noted, masked, at most once per 10 minutes; the team list says so; no email", async () => {
    h = await harness();
    const s = await summit();
    const sent = await s.invite("crew@summit.test");
    const token = s.outbox[0]!.url.split("/").pop()!;
    const jake = await h.user("jake.crew@gmail.com");
    const mallory = await h.user("mallory@elsewhere.test");

    expect((await call(s.company, jake, "POST", "v1/invitations/accept", { token }).then(jsonOf)).status).toBe("wrong-email");
    const at = h.clock.now.toISOString();
    const list = async () =>
      (await jsonOf<{ invitations: IssuedBody["invitation"][] }>(await call(s.company, s.owner, "GET", `v1/companies/${s.tenantId}/invitations`))).invitations.find(
        (i) => i.id === sent.invitation.id,
      )!;
    expect((await list()).wrongAccount).toEqual({ signedInAs: "j•••@gmail.com", at });
    // Never the whole address, anywhere on the row.
    expect(JSON.stringify((await h.db.execute(sql`select * from tenant_invitations where id = ${sent.invitation.id}`)).rows)).not.toContain("jake.crew@gmail.com");

    // Pressed again a minute later, by someone else: the note stands.
    s.later(MINUTE);
    await call(s.company, mallory, "POST", "v1/invitations/accept", { token });
    expect((await list()).wrongAccount).toEqual({ signedInAs: "j•••@gmail.com", at });
    // Ten minutes on, the latest attempt replaces it.
    s.later(10 * MINUTE);
    await call(s.company, mallory, "POST", "v1/invitations/accept", { token });
    expect((await list()).wrongAccount).toEqual({ signedInAs: "m•••@elsewhere.test", at: h.clock.now.toISOString() });
    // Nobody was emailed about it.
    expect(s.outbox).toHaveLength(1);

    // The right person accepting still works, and an invitation nobody
    // pressed carries no note.
    const crew = await h.user("crew@summit.test");
    expect((await call(s.company, crew, "POST", "v1/invitations/accept", { token }).then(jsonOf)).status).toBe("accepted");
    const quiet = await s.invite("office@summit.test");
    expect(quiet.invitation.wrongAccount).toBeNull();
  });
});

describe("TB2-10 (round 3): the accept ROUTE hands the package every verified address", () => {
  it("a second verified address is accepted through the handler; one the identity provider didn't verify is refused", async () => {
    h = await harness();
    const owner = await h.user("olivia@summit.test");
    const tenantId = await h.company(owner, "Summit Windows");
    // Pat's account row carries the home address; the work one is verified too.
    const pat = await h.user("pat.home@example.test");
    const toWork = await h.tenancy.sendInvitation({ actorUserId: owner, tenantId, email: "pat.work@summit.test", roleKey: "member" });
    const toTyped = await h.tenancy.sendInvitation({ actorUserId: owner, tenantId, email: "pat.typed@summit.test", roleKey: "member" });
    const { company } = handlersFor(h, { verifiedEmails: async () => ["pat.home@example.test", "Pat.Work@Summit.test"] });
    const accept = async (token: string) => (await jsonOf<{ status: string }>(await call(company, pat, "POST", "v1/invitations/accept", { token }))).status;
    expect(await accept(toTyped.token)).toBe("wrong-email");
    expect(await accept(toWork.token)).toBe("accepted");
    expect(await h.tenancy.membership({ userId: pat, tenantId })).toBe("member");
  });
});

// ---------------------------------------------------------------------------
// Review round 4: "We emailed" only ever means an email went (SEC-T1-B), and
// the wrong-account note's two guards (T1BO-07).
// ---------------------------------------------------------------------------

type Outcome = "sent" | "skipped" | "failed" | "throws" | "queued";

/**
 * Summit's team page with a mailer whose answers the test scripts: each
 * delivery takes the next outcome (then "sent"), or waits on a gate.
 */
async function summitMailer(outcomes: Outcome[] = []) {
  const owner = await h.user("olivia@summit.test", { name: "Olivia" });
  const tenantId = await h.company(owner, "Summit Windows");
  const attempts: { to: string; url: string; outcome: Outcome | "gated" }[] = [];
  const queue = [...outcomes];
  let gate: Promise<Outcome> | null = null;
  let entered: (() => void) | null = null;
  const reported: unknown[] = [];
  const { company } = handlersFor(h, {
    deliverInvitation: async (input) => {
      const gated = gate !== null;
      entered?.();
      const outcome = gate ? await gate : (queue.shift() ?? "sent");
      attempts.push({ to: input.to, url: input.url, outcome: gated ? "gated" : outcome });
      if (outcome === "throws") throw new Error("the mail provider timed out");
      return { status: outcome as "sent" };
    },
    onError: (error) => void reported.push(error),
  });
  const invite = async (email: string, roleKey = "member") =>
    jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations`, { email, roleKey }));
  const resend = async (invitationId: string) =>
    jsonOf<IssuedBody>(await call(company, owner, "POST", `v1/companies/${tenantId}/invitations/${invitationId}/resend`, {}));
  const withdraw = async (invitationId: string) =>
    call(company, owner, "POST", `v1/companies/${tenantId}/invitations/${invitationId}/revoke`, {});
  const later = (ms: number) => {
    h.clock.now = new Date(h.clock.now.getTime() + ms);
  };
  /** Hold the next delivery until `open(outcome)`; `reached` settles once the mailer is waiting. */
  const hold = () => {
    let open!: (o: Outcome) => void;
    const reached = new Promise<void>((resolve) => {
      entered = () => {
        entered = null;
        resolve();
      };
    });
    gate = new Promise<Outcome>((resolve) => {
      open = (o) => {
        gate = null;
        resolve(o);
      };
    });
    return { open, reached };
  };
  const row = async (id: string) =>
    (await h.db.execute(sql`select cardinality(emailed_at) as emails, email_sending_at from tenant_invitations where id = ${id}`)).rows[0] as {
      emails: number;
      email_sending_at: unknown;
    };
  return { owner, tenantId, company, attempts, reported, invite, resend, withdraw, later, hold, row };
}

describe("SEC-T1-B (round 4): only an email the provider took counts as emailed", () => {
  for (const outcome of ["skipped", "failed", "throws"] as const) {
    it(`a delivery that ${outcome === "throws" ? "threw" : `was ${outcome}`} isn't 'emailed': Resend straight after emails, never 'held', never 'We emailed'`, async () => {
      h = await harness();
      const s = await summitMailer([outcome, "sent"]);
      const first = await s.invite("crew@summit.test");
      expect(first).toMatchObject({ delivery: outcome === "skipped" ? "skipped" : "failed", note: null });
      expect(first.link).toMatch(/^https:\/\/app\.test\/invite\//);
      expect(await s.row(first.invitation.id)).toEqual({ emails: 0, email_sending_at: null });

      s.later(MINUTE);
      const again = await s.resend(first.invitation.id);
      expect(again.delivery, JSON.stringify(again)).toBe("sent");
      expect(again.note).toBeNull();
      expect(s.attempts.map((a) => a.outcome)).toEqual([outcome, "sent"]);
      expect(await s.row(first.invitation.id)).toEqual({ emails: 1, email_sending_at: null });

      // The one that went IS counted: a minute later the limits hold, and say so truly.
      s.later(MINUTE);
      const third = await s.resend(first.invitation.id);
      expect(third.delivery).toBe("held");
      expect(third.note).toContain("We emailed crew@summit.test a minute ago");
      expect(s.attempts).toHaveLength(2);
    });
  }

  it("a deliverer answering anything but sent/skipped/failed is a failure: the link, and nothing counted", async () => {
    h = await harness();
    const s = await summitMailer(["queued"]);
    const first = await s.invite("crew@summit.test");
    expect(first.delivery).toBe("failed");
    expect(first.link).toMatch(/^https:\/\/app\.test\/invite\//);
    expect(await s.row(first.invitation.id)).toEqual({ emails: 0, email_sending_at: null });
    expect((await s.resend(first.invitation.id)).delivery).toBe("sent");
  });

  it("two Resends at once: the second never claims the first's email went; if it then fails, nothing was emailed", async () => {
    h = await harness();
    const s = await summitMailer(["failed"]);
    const first = await s.invite("crew@summit.test");
    expect(first.delivery).toBe("failed");

    s.later(MINUTE);
    const { open, reached } = s.hold();
    const inFlight = s.resend(first.invitation.id);
    let second: IssuedBody;
    try {
      // The first Resend is saved and its email is on its way (the mailer is waiting).
      await reached;
      second = await s.resend(first.invitation.id);
    } finally {
      open("failed");
    }
    expect((await inFlight).delivery).toBe("failed");
    expect(second.delivery).toBe("held");
    expect(second.link).toMatch(/^https:\/\/app\.test\/invite\//);
    expect(second.note).not.toMatch(/We emailed|already sent/);
    expect(second.note).toBe(
      "We started emailing crew@summit.test less than a minute ago and haven't heard back yet, so we didn't start another. " +
        "If that email arrives, its link works too. Copy the link below if you'd like to send it yourself.",
    );
    expect(s.attempts.map((a) => a.outcome)).toEqual(["failed", "gated"]);
    expect(await s.row(first.invitation.id)).toEqual({ emails: 0, email_sending_at: null });
    // Nothing went, so nothing holds the next one.
    const third = await s.resend(first.invitation.id);
    expect(third.delivery).toBe("sent");
    expect(await s.row(first.invitation.id)).toEqual({ emails: 1, email_sending_at: null });
  });

  it("an email whose outcome never came back (the server stopped mid-send) holds the address at most 10 minutes, says so honestly, and is never counted", async () => {
    h = await harness();
    const owner = await h.user("olivia@summit.test");
    const tenantId = await h.company(owner, "Summit Windows");
    const send = () => h.tenancy.sendInvitation({ actorUserId: owner, tenantId, email: "crew@summit.test", roleKey: "member", sendsEmail: true });
    const first = await send();
    expect(first.emailHold).toBeNull();
    expect(first.emailReservation).toMatchObject({ invitationId: first.invitation.id });
    // …and nobody settles it.

    h.clock.now = new Date(h.clock.now.getTime() + 3 * MINUTE);
    const second = await send();
    expect(second.emailHold?.reason).toBe("sending");
    expect(second.emailHold?.message).toBe(
      "We started emailing crew@summit.test 3 minutes ago and haven't heard back yet, so we didn't start another. " +
        "If that email arrives, its link works too. Copy the link below if you'd like to send it yourself.",
    );
    expect(second.emailReservation).toBeNull();

    h.clock.now = new Date(h.clock.now.getTime() + 8 * MINUTE);
    const third = await send();
    expect(third.emailHold).toBeNull();
    expect(third.emailReservation).not.toBeNull();
    const rows = (await h.db.execute(sql`select cardinality(emailed_at) as emails from tenant_invitations where id = ${first.invitation.id}`)).rows;
    expect(rows).toEqual([{ emails: 0 }]);
  });

  it("settling is exact: only the reservation it names, once; a 'sent' is stamped when the provider took it", async () => {
    h = await harness();
    const owner = await h.user("olivia@summit.test");
    const tenantId = await h.company(owner, "Summit Windows");
    const first = await h.tenancy.sendInvitation({ actorUserId: owner, tenantId, email: "crew@summit.test", roleKey: "member", sendsEmail: true });
    const r = first.emailReservation!;
    // Someone else's company, or a reservation that isn't this one: nothing.
    const bea = await h.user("bea@beta.test");
    const beta = await h.company(bea, "Beta Plumbing");
    await h.tenancy.settleInvitationEmail({ tenantId: beta, invitationId: r.invitationId, reservedAt: r.reservedAt, sent: true });
    await h.tenancy.settleInvitationEmail({ tenantId, invitationId: r.invitationId, reservedAt: new Date(r.reservedAt.getTime() - 1), sent: true });
    const read = async () =>
      (await h.db.execute(sql`select cardinality(emailed_at) as emails, email_sending_at is not null as sending from tenant_invitations where id = ${r.invitationId}`)).rows[0];
    expect(await read()).toEqual({ emails: 0, sending: true });
    h.clock.now = new Date(h.clock.now.getTime() + 2_000);
    await h.tenancy.settleInvitationEmail({ tenantId, invitationId: r.invitationId, reservedAt: r.reservedAt, sent: true });
    await h.tenancy.settleInvitationEmail({ tenantId, invitationId: r.invitationId, reservedAt: r.reservedAt, sent: true });
    expect(await read()).toEqual({ emails: 1, sending: false });
    const stamped = (await h.db.execute(sql`select emailed_at[1] as at from tenant_invitations where id = ${r.invitationId}`)).rows[0] as { at: unknown };
    expect(new Date(stamped.at as string).toISOString()).toBe(h.clock.now.toISOString());
  });

  it("the answer is still right when recording the outcome fails: reported, never a 500", async () => {
    h = await harness();
    const owner = await h.user("olivia@summit.test");
    const tenantId = await h.company(owner, "Summit Windows");
    const reported: unknown[] = [];
    const tenancy: typeof h.tenancy = { ...h.tenancy, settleInvitationEmail: async () => Promise.reject(new Error("db went away")) };
    const company = createTenancyHandlers({
      tenancy,
      principal: async () => ({ userId: owner, email: "olivia@summit.test" }),
      invitationUrl: (token) => `https://app.test/invite/${token}`,
      deliverInvitation: async () => ({ status: "sent" }),
      onError: (error) => void reported.push(error),
    });
    const res = await call(company, owner, "POST", `v1/companies/${tenantId}/invitations`, { email: "crew@summit.test", roleKey: "member" });
    expect(res.status).toBe(200);
    expect(await jsonOf<IssuedBody>(res)).toMatchObject({ delivery: "sent", link: null });
    expect(reported.map((e) => (e as Error).message)).toEqual(["db went away"]);
  });

  it("a caller that doesn't email the link is never held, even straight after an email went", async () => {
    h = await harness();
    const s = await summitMailer();
    const first = await s.invite("crew@summit.test");
    expect(first.delivery).toBe("sent");
    // The host's own server code, re-issuing without emailing: no hold, nothing reserved.
    const quiet = await h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: first.invitation.id });
    expect(quiet.emailHold).toBeNull();
    expect(quiet.emailReservation ?? null).toBeNull();
    // A team page wired with no mailer: the link, never "held".
    const { company } = handlersFor(h);
    const bare = await jsonOf<IssuedBody>(await call(company, s.owner, "POST", `v1/companies/${s.tenantId}/invitations/${first.invitation.id}/resend`, {}));
    expect(bare).toMatchObject({ delivery: "skipped", note: null });
    expect(s.attempts).toHaveLength(1);
  });

  it("withdrawing and inviting again skips the 10-minute wait, but every email still counts toward the day's five", async () => {
    h = await harness();
    const s = await summitMailer();
    let current = await s.invite("crew@summit.test");
    expect(current.delivery).toBe("sent");
    for (let i = 1; i < INVITATION_EMAILS_PER_ADDRESS_PER_DAY; i += 1) {
      s.later(MINUTE);
      expect((await s.withdraw(current.invitation.id)).status).toBe(200);
      current = await s.invite("crew@summit.test");
      // A new invitation, a minute after the last email: emailed, not made to wait.
      expect(current.delivery, `invitation ${i + 1}`).toBe("sent");
    }
    expect(s.attempts).toHaveLength(INVITATION_EMAILS_PER_ADDRESS_PER_DAY);

    s.later(MINUTE);
    await s.withdraw(current.invitation.id);
    const sixth = await s.invite("crew@summit.test");
    expect(sixth.delivery).toBe("held");
    expect(sixth.note).toContain(`crew@summit.test has had ${INVITATION_EMAILS_PER_ADDRESS_PER_DAY} invitation emails from Summit Windows in the last day`);
    expect(s.attempts).toHaveLength(INVITATION_EMAILS_PER_ADDRESS_PER_DAY);
    // Re-sending THAT one: it was never emailed, so nothing may say an email of it went.
    s.later(11 * MINUTE);
    const again = await s.resend(sixth.invitation.id);
    expect(again.delivery).toBe("held");
    expect(again.note).not.toMatch(/already sent|still works/);
    expect(s.attempts).toHaveLength(INVITATION_EMAILS_PER_ADDRESS_PER_DAY);
  });
});

describe("T1BO-07 (round 4): the wrong-account note's guards", () => {
  async function noteOf(invitationId: string) {
    const r = (await h.db.execute(sql`select wrong_account_at, wrong_account_email from tenant_invitations where id = ${invitationId}`)).rows[0] as {
      wrong_account_at: unknown;
      wrong_account_email: unknown;
    };
    return { at: r.wrong_account_at, who: r.wrong_account_email };
  }

  it("is written only on an OPEN invitation: never on one that was withdrawn or already accepted", async () => {
    h = await harness();
    const s = await summitMailer();
    const jake = await h.user("jake.crew@gmail.com");
    const tokenOf = (i: number) => s.attempts[i]!.url.split("/").pop()!;
    const press = async (userId: string, token: string) => (await jsonOf<{ status: string }>(await call(s.company, userId, "POST", "v1/invitations/accept", { token }))).status;

    const withdrawn = await s.invite("crew@summit.test");
    await s.withdraw(withdrawn.invitation.id);
    expect(await press(jake, tokenOf(0))).toBe("wrong-email");
    expect(await noteOf(withdrawn.invitation.id)).toEqual({ at: null, who: null });

    const taken = await s.invite("office@summit.test");
    const office = await h.user("office@summit.test");
    expect(await press(office, tokenOf(1))).toBe("accepted");
    s.later(MINUTE);
    expect(await press(jake, tokenOf(1))).toBe("wrong-email");
    expect(await noteOf(taken.invitation.id)).toEqual({ at: null, who: null });

    // The control: the same press on an open one IS noted.
    const open = await s.invite("yard@summit.test");
    expect(await press(jake, tokenOf(2))).toBe("wrong-email");
    expect((await noteOf(open.invitation.id)).who).toBe("j•••@gmail.com");
  });

  it("is written only for the wrong-account answer: never when the RIGHT person's link is expired, the company is full or paused, or they're already in", async () => {
    let limit: number | null = null;
    h = await harness({ seats: { limitFor: async () => limit } });
    const s = await summitMailer();
    const tokenOf = (i: number) => s.attempts[i]!.url.split("/").pop()!;
    const press = async (userId: string, token: string) => (await jsonOf<{ status: string }>(await call(s.company, userId, "POST", "v1/invitations/accept", { token }))).status;

    // Expired.
    const late = await s.invite("late@summit.test");
    const lateUser = await h.user("late@summit.test");
    s.later(8 * 24 * 60 * MINUTE);
    expect(await press(lateUser, tokenOf(0))).toBe("expired");
    expect(await noteOf(late.invitation.id)).toEqual({ at: null, who: null });

    // The company is full when they press.
    const full = await s.invite("full@summit.test");
    const fullUser = await h.user("full@summit.test");
    limit = 1;
    expect(await press(fullUser, tokenOf(1))).toBe("seats-full");
    expect(await noteOf(full.invitation.id)).toEqual({ at: null, who: null });
    limit = null;

    // Already on the team (added another way since).
    const inAlready = await s.invite("in@summit.test");
    const inUser = await h.user("in@summit.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${s.tenantId}, ${inUser}, 'active')`);
    expect(await press(inUser, tokenOf(2))).toBe("already-a-member");
    expect(await noteOf(inAlready.invitation.id)).toEqual({ at: null, who: null });

    // The company is suspended when they press.
    const paused = await s.invite("paused@summit.test");
    const pausedUser = await h.user("paused@summit.test");
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    expect(await press(pausedUser, tokenOf(3))).toBe("company-unavailable");
    expect(await noteOf(paused.invitation.id)).toEqual({ at: null, who: null });
  });
});
