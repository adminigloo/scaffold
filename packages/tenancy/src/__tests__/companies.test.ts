import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { assertOwnerInvariant, codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const count = async (q: ReturnType<typeof sql>) => Number(((await h.db.execute(q)).rows[0] as { n: number }).n);

describe("createCompany (6.4, scenario step 1)", () => {
  it("writes the company, an active membership, the owner role, the pointer and an audit row", async () => {
    h = await harness();
    const olivia = await h.user("olivia@summit.test");
    const out = await h.tenancy.createCompany({ userId: olivia, name: "Summit Window Co.", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    expect(out.status).toBe("created");
    expect(out.company).toMatchObject({ name: "Summit Window Co.", slug: "summit-window-co", role: "owner", isOwner: true, kind: "org" });
    expect(await count(sql`select count(*)::int as n from tenant_members where tenant_id = ${out.company.id} and user_id = ${olivia} and status = 'active'`)).toBe(1);
    expect(((await h.db.execute(sql`select active_tenant_id from users where id = ${olivia}`)).rows[0] as { active_tenant_id: string }).active_tenant_id).toBe(out.company.id);
    expect(h.audit.find((a) => a.action === "company.created")?.metadata).toEqual({ name: "Summit Window Co.", slug: "summit-window-co", purpose: "onboarding" });
    await assertOwnerInvariant(h.db, out.company.id);
  });

  it("the same requestKey again → replayed, same id, no second row", async () => {
    h = await harness();
    const olivia = await h.user("olivia@summit.test");
    const a = await h.tenancy.createCompany({ userId: olivia, name: "Summit", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    const b = await h.tenancy.createCompany({ userId: olivia, name: "Summit", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    expect(b).toMatchObject({ status: "replayed", company: { id: a.company.id } });
    expect(await count(sql`select count(*)::int as n from tenants`)).toBe(1);
  });

  it("two onboardings with different keys, fired together → one created, one already-onboarded, one company (serial on PGlite; the create lock is proved in team.test.ts)", async () => {
    h = await harness();
    const olivia = await h.user("olivia@summit.test");
    const [x, y] = await Promise.all([
      h.tenancy.createCompany({ userId: olivia, name: "Summit", requestKey: "key-tab-one-1", purpose: "onboarding" }),
      h.tenancy.createCompany({ userId: olivia, name: "Summit", requestKey: "key-tab-two-2", purpose: "onboarding" }),
    ]);
    expect([x.status, y.status].sort()).toEqual(["already-onboarded", "created"]);
    expect(x.company.id).toBe(y.company.id);
    expect(await count(sql`select count(*)::int as n from tenants`)).toBe(1);
  });

  it("purpose additional → a second company", async () => {
    h = await harness();
    const sam = await h.user("sam@summit.test");
    await h.tenancy.createCompany({ userId: sam, name: "Summit", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    const side = await h.tenancy.createCompany({ userId: sam, name: "Sam's Side Gig", requestKey: "key-bbbbbbbb", purpose: "additional" });
    expect(side.status).toBe("created");
    expect(side.company.slug).toBe("sams-side-gig");
  });

  it("takes the per-user advisory lock first", async () => {
    h = await harness();
    const olivia = await h.user("olivia@summit.test");
    h.t.queries.length = 0;
    await h.tenancy.createCompany({ userId: olivia, name: "Summit", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    expect(h.t.queries[0]?.sql).toContain("adminigloo:tenancy/create-lock");
    expect(h.t.queries[0]?.params).toEqual([`adminigloo:tenancy:create:${olivia}`]);
  });

  it("slugs: a suggested collision gets -2; an explicit taken one is refused with a free suggestion; retired counts as taken", async () => {
    h = await harness();
    const a = await h.user("a@a.test");
    const b = await h.user("b@b.test");
    const first = await h.tenancy.createCompany({ userId: a, name: "Summit", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    const second = await h.tenancy.createCompany({ userId: b, name: "Summit", requestKey: "key-bbbbbbbb", purpose: "onboarding" });
    expect(second.company.slug).toBe("summit-2");
    const c = await h.user("c@c.test");
    const taken = await h.tenancy.createCompany({ userId: c, name: "X Co", slug: "summit", requestKey: "key-cccccccc", purpose: "onboarding" }).catch((e: unknown) => e);
    expect(taken).toMatchObject({ code: "slug_taken", details: { suggestion: "summit-3" } });
    // Summit renames its address: "summit" is retired, still points at it, and
    // stays taken for everyone else.
    await h.tenancy.updateCompanyProfile({ actorUserId: a, tenantId: first.company.id, slug: "summit-windows" });
    const retired = await h.tenancy.createCompany({ userId: c, name: "Y Co", slug: "summit", requestKey: "key-dddddddd", purpose: "onboarding" }).catch((e: unknown) => e);
    expect(retired).toMatchObject({ code: "slug_taken" });
  });

  it("reserved → slug_reserved; invalid → slug_invalid (each with a suggestion); bad names → name_invalid", async () => {
    h = await harness();
    const a = await h.user("a@a.test");
    const reserved = await h.tenancy.createCompany({ userId: a, name: "Admin Co", slug: "admin", requestKey: "key-aaaaaaaa", purpose: "onboarding" }).catch((e: unknown) => e);
    expect(reserved).toMatchObject({ code: "slug_reserved", details: { suggestion: "admin-co" } });
    expect(await codeOf(h.tenancy.createCompany({ userId: a, name: "X Co", slug: "Bad Slug", requestKey: "key-aaaaaaaa", purpose: "onboarding" }))).toBe("slug_invalid");
    for (const name of ["   ", "🙂🙂", "x".repeat(81)]) {
      expect(await codeOf(h.tenancy.createCompany({ userId: a, name, requestKey: "key-aaaaaaaa", purpose: "onboarding" }))).toBe("name_invalid");
    }
  });

  it("an unseeded database: the tenant templates are seeded inside the creation and the owner holds a role (D10)", async () => {
    h = await harness({ seed: false });
    const a = await h.user("a@a.test");
    const out = await h.tenancy.createCompany({ userId: a, name: "First Co", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    expect(out.company.role).toBe("owner");
    await assertOwnerInvariant(h.db, out.company.id);
    const team = await h.tenancy.getTeam({ actorUserId: a, tenantId: out.company.id });
    expect(team.you.canInvite).toBe(true);
  });

  it("personal mode → unavailable", async () => {
    h = await harness({ mode: "personal" });
    const a = await h.user("a@a.test");
    expect(await codeOf(h.tenancy.createCompany({ userId: a, name: "X Co", requestKey: "key-aaaaaaaa", purpose: "onboarding" }))).toBe("unavailable");
  });
});

describe("replay is read-only (review T1-01): a removed creator can't buy their way back in", () => {
  it("create → transfer → remove → replay the original request = not_found, and D4 still holds", async () => {
    h = await harness();
    const alice = await h.user("alice@co.test");
    const bob = await h.user("bob@co.test");
    const made = await h.tenancy.createCompany({ userId: alice, name: "Alice Co", requestKey: "key-original-1", purpose: "onboarding" });
    const id = made.company.id;
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${id}, ${bob})`);
    await h.tenancy.transferOwnership({ actorUserId: alice, tenantId: id, toUserId: bob, confirmName: "Alice Co" });
    await h.tenancy.removeMember({ actorUserId: bob, tenantId: id, targetUserId: alice });

    expect(await codeOf(h.tenancy.createCompany({ userId: alice, name: "Alice Co", requestKey: "key-original-1", purpose: "onboarding" }))).toBe("not_found");
    expect(await count(sql`select count(*)::int as n from tenant_members where tenant_id = ${id} and user_id = ${alice}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from principal_role where tenant_id = ${id} and principal_id = ${alice}`)).toBe(0);
    await assertOwnerInvariant(h.db, id);
  });
});

describe("checkSlug", () => {
  it("with only a name, answers the first FREE address; with a slug, says why it can't be used and offers one", async () => {
    h = await harness({ reservedSlugs: ["igloo-back-office"] });
    const a = await h.user("a@a.test");
    expect(await h.tenancy.checkSlug({ actorUserId: a, name: "Summit Window Co." })).toEqual({
      slug: "summit-window-co",
      available: true,
      problem: null,
      message: null,
      suggestion: "summit-window-co",
    });
    await h.tenancy.createCompany({ userId: a, name: "Summit Window Co.", requestKey: "key-aaaaaaaa", purpose: "onboarding" });
    const b = await h.user("b@b.test");
    expect((await h.tenancy.checkSlug({ actorUserId: b, name: "Summit Window Co." })).slug).toBe("summit-window-co-2");
    const taken = await h.tenancy.checkSlug({ actorUserId: b, slug: "summit-window-co" });
    expect(taken).toMatchObject({ available: false, problem: "taken", suggestion: "summit-window-co-2" });
    const project = await h.tenancy.checkSlug({ actorUserId: b, slug: "igloo-back-office" });
    expect(project).toMatchObject({ available: false, problem: "reserved" });
  });

  it("with a tenantId the caller can't see → not_found", async () => {
    h = await harness();
    const a = await h.user("a@a.test");
    const b = await h.user("b@b.test");
    const id = await h.company(a, "A Co");
    expect(await codeOf(h.tenancy.checkSlug({ actorUserId: b, slug: "anything", tenantId: id }))).toBe("not_found");
  });
});

describe("a lost answer never makes a twin (review R2 T1BO-01)", () => {
  it("'Create another' retried after a lost answer — with the offered '-2' address, or a fresh key after a reload — opens the company it already made", async () => {
    h = await harness();
    const cal = await h.user("cal@lawn.test", { name: "Cal" });
    await h.tenancy.createCompany({ userId: cal, name: "Cal Lawn", requestKey: "key-onboard-1", purpose: "onboarding" });
    const first = await h.tenancy.createCompany({ userId: cal, name: "Cal's Snow Removal", slug: "calsnow", requestKey: "key-another-1", purpose: "additional" });
    // The answer was lost. The form offers "calsnow-2"; he takes it and presses Create (a new key: the address changed).
    const retry = await h.tenancy.createCompany({ userId: cal, name: "Cal's Snow Removal", slug: "calsnow-2", requestKey: "key-another-2", purpose: "additional" });
    expect(retry).toMatchObject({ status: "replayed", company: { id: first.company.id, slug: "calsnow" } });
    // Or he reloads and types it again: a fresh key, no address.
    const reload = await h.tenancy.createCompany({ userId: cal, name: "  cal's snow   removal ", requestKey: "key-another-3", purpose: "additional" });
    expect(reload).toMatchObject({ status: "replayed", company: { id: first.company.id } });
    expect(await count(sql`select count(*)::int as n from tenants where created_by = ${cal}`)).toBe(2);
  });

  it("the same name again much later is a deliberate second company, and another person's same name is theirs", async () => {
    h = await harness();
    const cal = await h.user("cal@lawn.test");
    const first = await h.tenancy.createCompany({ userId: cal, name: "Green Acres", requestKey: "key-another-1", purpose: "additional" });
    await h.db.execute(sql`update tenants set created_at = now() - interval '1 hour' where id = ${first.company.id}`);
    const later = await h.tenancy.createCompany({ userId: cal, name: "Green Acres", requestKey: "key-another-2", purpose: "additional" });
    expect(later.status).toBe("created");
    const dee = await h.user("dee@lawn.test");
    expect((await h.tenancy.createCompany({ userId: dee, name: "Green Acres", requestKey: "key-dee-1", purpose: "additional" })).status).toBe("created");
  });

  it("the address check doesn't call your own company's address 'another company's'", async () => {
    h = await harness();
    const cal = await h.user("cal@lawn.test");
    await h.tenancy.createCompany({ userId: cal, name: "Cal's Snow Removal", slug: "calsnow", requestKey: "key-another-1", purpose: "additional" });
    const mine = await h.tenancy.checkSlug({ actorUserId: cal, slug: "calsnow" });
    expect(mine).toMatchObject({ available: false, problem: "taken" });
    expect(mine.message).toMatch(/Cal's Snow Removal/);
    expect(mine.message).not.toMatch(/another/);
    const stranger = await h.user("x@x.test");
    expect((await h.tenancy.checkSlug({ actorUserId: stranger, slug: "calsnow" })).message).toMatch(/another/);
  });
});

describe("one account, a bounded number of companies (review R2 SEC-T1-B, SEC-T1-C)", () => {
  it("past the per-account limit, creating another company is refused with a plain sentence", async () => {
    h = await harness({ companiesPerAccount: 3 });
    const sam = await h.user("sam@x.test");
    for (let i = 0; i < 3; i += 1) {
      await h.tenancy.createCompany({ userId: sam, name: `Company ${i}`, requestKey: `key-company-${i}`, purpose: "additional" });
    }
    const fourth = await h.tenancy.createCompany({ userId: sam, name: "Company 3", requestKey: "key-company-3", purpose: "additional" }).catch((e: unknown) => e);
    expect(fourth).toMatchObject({ code: "forbidden", message: expect.stringMatching(/3 companies/) });
  });

  it("the default is ten", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    for (let i = 0; i < 10; i += 1) {
      await h.tenancy.createCompany({ userId: sam, name: `Company ${i}`, requestKey: `key-company-${i}`, purpose: "additional" });
    }
    expect(await codeOf(h.tenancy.createCompany({ userId: sam, name: "Company 10", requestKey: "key-company-10", purpose: "additional" }))).toBe("forbidden");
  });
});
