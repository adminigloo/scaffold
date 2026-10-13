import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function setup() {
  const owner = await h.user("owner@summit.test");
  const member = await h.user("member@summit.test");
  const tenantId = await h.company(owner, "Summit", { [member]: "member" });
  return { owner, member, tenantId };
}

describe("branding (6.5): warn, never block", () => {
  it("stores the colour and the text colour that reads on it; never refuses for contrast", async () => {
    h = await harness();
    const s = await setup();
    const out = await h.tenancy.updateBranding({ actorUserId: s.owner, tenantId: s.tenantId, brandColor: "#0F766E" });
    expect(out.company).toMatchObject({ brandColor: "#0f766e", onBrandColor: "#ffffff" });
    expect(out.brand).toMatchObject({ readable: true, textOnColor: "#ffffff" });
    const pale = await h.tenancy.updateBranding({ actorUserId: s.owner, tenantId: s.tenantId, brandColor: "#fefefe" });
    expect(pale.brand?.warning).toBeTruthy();
    expect(pale.company.brandColor).toBe("#fefefe");
    expect(await codeOf(h.tenancy.updateBranding({ actorUserId: s.owner, tenantId: s.tenantId, brandColor: "teal" }))).toBe("invalid");
    expect(await codeOf(h.tenancy.updateBranding({ actorUserId: s.member, tenantId: s.tenantId, brandColor: "#000000" }))).toBe("forbidden");
  });
});

describe("logos", () => {
  it("no store → logo_storage_off, and the profile says uploads are off before anyone tries (review T1-11)", async () => {
    h = await harness({ logos: false });
    const s = await setup();
    expect((await h.tenancy.getCompany({ actorUserId: s.owner, tenantId: s.tenantId })).logoUploads).toBe(false);
    expect(await codeOf(h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } }))).toBe("logo_storage_off");
  });

  it("SVG, a mislabelled type (wrong magic bytes) or more than 1 MB → logo_invalid", async () => {
    h = await harness();
    const s = await setup();
    expect((await h.tenancy.getCompany({ actorUserId: s.owner, tenantId: s.tenantId })).logoUploads).toBe(true);
    const tries = [
      { bytes: SVG, contentType: "image/svg+xml" },
      { bytes: SVG, contentType: "image/png" },
      { bytes: new Uint8Array(1_048_577).fill(0x89), contentType: "image/png" },
    ];
    for (const file of tries) expect(await codeOf(h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file }))).toBe("logo_invalid");
    expect(h.logos.puts).toEqual([]);
  });

  it("a replacement puts first, then deletes the old key after the commit", async () => {
    h = await harness();
    const s = await setup();
    const first = await h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    const second = await h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    expect(second.logoUrl).not.toBe(first.logoUrl);
    expect(h.logos.deleted).toEqual([first.logoUrl!.replace("https://blob.test/", "")]);
    expect(h.logos.puts[0]).toMatch(new RegExp(`^tenancy/logos/${s.tenantId}/[0-9a-f-]+\\.png$`));
  });

  it("a failed transaction deletes the new key, and the old logo stays", async () => {
    let fail = false;
    h = await harness({
      audit: async () => {
        if (fail) throw new Error("audit down");
      },
    });
    const s = await setup();
    const first = await h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    fail = true;
    await expect(h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } })).rejects.toThrow(/audit down/);
    expect(h.logos.deleted).toHaveLength(1);
    expect(h.logos.deleted[0]).not.toBe(first.logoUrl!.replace("https://blob.test/", ""));
    fail = false;
    expect((await h.tenancy.getCompany({ actorUserId: s.owner, tenantId: s.tenantId })).company.logoUrl).toBe(first.logoUrl);
  });

  it("a stranger's upload is refused BEFORE anything is stored (review T1-06)", async () => {
    h = await harness();
    const s = await setup();
    const stranger = await h.user("stranger@x.test");
    expect(await codeOf(h.tenancy.setLogo({ actorUserId: stranger, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } }))).toBe("not_a_member");
    expect(await codeOf(h.tenancy.setLogo({ actorUserId: s.member, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } }))).toBe("forbidden");
    expect(h.logos.puts).toEqual([]);
  });
});

describe("profile and web addresses (D14)", () => {
  it("a slug change retires the old one; it resolves to the company; nobody else can claim it; getting your own back works", async () => {
    h = await harness();
    const s = await setup();
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-windows" });
    const old = await h.tenancy.resolveCompanyBySlug("summit");
    expect(old).toMatchObject({ retiredSlug: "summit", company: { id: s.tenantId, slug: "summit-windows" } });
    const other = await h.user("other@x.test");
    expect(await codeOf(h.tenancy.createCompany({ userId: other, name: "Other", slug: "summit", requestKey: "key-otherone", purpose: "onboarding" }))).toBe("slug_taken");
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit" });
    expect(await h.tenancy.resolveCompanyBySlug("summit")).toMatchObject({ retiredSlug: null });
    expect(h.audit.filter((a) => a.action === "company.profile.updated")).toHaveLength(2);
  });

  it("is bounded (review T1-07): three changes a day, and only the last three old addresses are kept", async () => {
    h = await harness();
    const s = await setup();
    for (const slug of ["summit-a", "summit-b", "summit-c"]) {
      h.clock.now = new Date(h.clock.now.getTime() + 60_000);
      await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug });
    }
    const fourth = await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-d" }).catch((e: unknown) => e);
    expect(fourth).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/3 times today/) });
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-d" });
    const kept = await h.db.execute(sql`select slug from tenant_retired_slugs where tenant_id = ${s.tenantId} order by slug`);
    expect(kept.rows.map((r: unknown) => (r as { slug: string }).slug)).toEqual(["summit-a", "summit-b", "summit-c"]);
    // The oldest ("summit") was released: anyone may claim it now.
    expect(await h.tenancy.resolveCompanyBySlug("summit")).toBeNull();
  });

  it("a personal workspace can't change its address", async () => {
    h = await harness({ mode: "personal" });
    const u = await h.user("u@x.test");
    const s = await h.tenancy.resolveSession({ userId: u });
    const id = s.state !== "needs-onboarding" ? s.company.id : "";
    expect(await codeOf(h.tenancy.updateCompanyProfile({ actorUserId: u, tenantId: id, slug: "my-place" }))).toBe("invalid");
  });
});

describe("web address changes, counted so they can't be dodged (review R2 F5, F6, SEC-T1-C)", () => {
  it("F6: switching back and forth still counts: the fourth change in a day is refused", async () => {
    h = await harness();
    const s = await setup();
    const results: string[] = [];
    for (const slug of ["summit-a", "summit-b", "summit-a", "summit-b"]) {
      h.clock.now = new Date(h.clock.now.getTime() + 60_000);
      results.push(await codeOf(h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug })));
    }
    expect(results).toEqual(["ok", "ok", "ok", "rate_limited"]);
  });

  it("SEC-T1-C: one person's address changes across ALL their companies are counted too", async () => {
    h = await harness();
    const s = await setup();
    const ids = [s.tenantId];
    for (let i = 0; i < 2; i += 1) ids.push(await h.company(s.owner, `Other ${i}`));
    const results: string[] = [];
    for (const [i, id] of ids.entries()) {
      for (const n of [1, 2]) {
        h.clock.now = new Date(h.clock.now.getTime() + 60_000);
        results.push(await codeOf(h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: id, slug: `name-${i}-${n}` })));
      }
    }
    // Five a day per person: the sixth, in a third company, is refused.
    expect(results).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited"]);
  });

  it("F5: losing a race for an address answers slug_taken with a free suggestion, not a 500", async () => {
    h = await harness();
    const s = await setup();
    const rival = await h.user("rival@x.test");
    const rivalCo = await h.company(rival, "Rival");
    // Another company claims "summit-roofing" between the availability check
    // and the update (two connections on real Postgres; here the claim is
    // slipped into the same transaction after the check, before the update).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = h.t.client as any;
    const realTx = client.transaction.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.transaction = (fn: (tx: any) => Promise<unknown>) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realTx(async (tx: any) => {
        const query = tx.query.bind(tx);
        tx.query = async (text: string, params?: unknown, opts?: unknown) => {
          if (text.includes("adminigloo:tenancy/log-slug-change")) {
            await query("update tenants set slug = 'summit-roofing' where id = $1", [rivalCo]);
          }
          return query(text, params, opts);
        };
        return fn(tx);
      });
    const out = await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-roofing" }).catch((e: unknown) => e);
    client.transaction = realTx;
    expect(out).toMatchObject({ code: "slug_taken", details: { suggestion: expect.stringMatching(/^summit-roofing-\d+$/) } });
  });
});
