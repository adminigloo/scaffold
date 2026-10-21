import { describe, expect, it } from "vitest";
import { createTenancyAdminClient } from "../admin/client.js";
import { createTenancyClient, parseInvitation, parseIssued, parseSession, parseTeam } from "../client.js";
import { joinUrl, toClientError, WIRE_ERROR_CODES } from "../http.js";
import { BAD_RESPONSE_MESSAGE, NETWORK_MESSAGE, SIGNED_OUT_MESSAGE } from "../words.js";
import { adminDetail, adminRow, checklist, company, invitation, people, person, profile, session, settings, team } from "./fakes.js";

/**
 * The transports (contract 8.1): exact URLs and methods for every route in
 * section 7, ids encoded, no custom headers on a GET, JSON on a POST, the
 * logo as multipart with no hand-set content type, and never a throw: a
 * thrown fetch is `network`, a proxy's HTML page is `bad_response`, a 401 is
 * signed out, and the error body's `suggestion` and `upgradeHref` survive.
 */

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string> | undefined) ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return answer(url, init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const issued = { invitation: invitation(), delivery: "skipped", link: "https://app.test/invite/tok" };

/** A plausible 200 for each company route, by the URL's tail. */
function answerFor(url: string, method: string): Response {
  const path = new URL(url, "https://app.test").pathname.replace(/^\/api\/tenancy/, "");
  if (path === "/v1/session") return json(session());
  if (path === "/v1/slug") return json({ slug: "summit-window-co", available: true, problem: null, message: null, suggestion: "summit-window-co" });
  if (path === "/v1/companies" && method === "POST") return json({ status: "created", company: company() });
  if (path === "/v1/active") return json({ company: company() });
  if (path.startsWith("/v1/invitations/")) return json({ status: "accepted", company: { id: "t-summit", name: "Summit Window Co." }, message: null });
  if (/\/members$/.test(path)) return json(team());
  if (/\/members\/[^/]+\/role$/.test(path)) return json({ member: team().members[1] });
  if (/\/members\/[^/]+\/remove$/.test(path)) return json({ removed: "u-sam" });
  if (/\/leave$/.test(path)) return json({ left: "t-summit" });
  if (/\/transfer$/.test(path)) return json(team());
  if (/\/invitations$/.test(path)) return method === "GET" ? json({ invitations: [invitation()] }) : json(issued);
  if (/\/invitations\/[^/]+\/resend$/.test(path)) return json(issued);
  if (/\/invitations\/[^/]+\/revoke$/.test(path)) return json({ id: "inv-1" });
  if (/\/checklist/.test(path)) return json(checklist());
  if (/\/settings\/[^/]+$/.test(path)) return json({ section: settings().sections[0] });
  if (/\/settings$/.test(path)) return json(settings());
  if (/\/branding$/.test(path)) return json({ company: company(), brand: null });
  if (/\/logo(\/remove)?$/.test(path)) return json({ company: company() });
  if (/\/profile$/.test(path)) return json({ company: company() });
  if (/^\/v1\/companies\/[^/]+$/.test(path)) return json(profile());
  return json({ error: { code: "not_found", message: "That isn't here any more." } }, 404);
}

describe("joinUrl", () => {
  it("puts exactly one slash between base and path", () => {
    expect(joinUrl("/api/tenancy/", "/v1/session")).toBe("/api/tenancy/v1/session");
    expect(joinUrl("https://x.test/api", "v1/session")).toBe("https://x.test/api/v1/session");
  });
});

describe("createTenancyClient", () => {
  it("every company route at its exact URL and method, ids encoded, and every answer read", async () => {
    const { fetchImpl, seen } = fakeFetch((url, init) => answerFor(url, init.method ?? "GET"));
    const c = createTenancyClient({ baseUrl: "/api/tenancy/", fetch: fetchImpl });
    const t = "t/1";
    const results = [
      await c.session(),
      await c.checkSlug({ name: "Summit Window Co." }),
      await c.checkSlug({ slug: "summit", tenantId: t }),
      await c.createCompany({ name: "Summit Window Co.", requestKey: "k-123456789", purpose: "onboarding" }),
      await c.setActive(t),
      await c.acceptInvitation("tok"),
      await c.joinInvitation("inv 1"),
      await c.company(t),
      await c.updateProfile(t, { name: "Summit" }),
      await c.updateBranding(t, { brandColor: "#0f766e" }),
      await c.removeLogo(t),
      await c.settings(t),
      await c.updateSettings(t, "company", { values: { timeZone: "America/Denver" } }),
      await c.checklist(t),
      await c.dismissChecklistItem(t, "team.invite"),
      await c.hideChecklist(t),
      await c.team(t),
      await c.changeRole(t, "u/sam", { roleKey: "admin" }),
      await c.removeMember(t, "u-sam"),
      await c.leave(t),
      await c.transfer(t, { toUserId: "u-sam", confirmName: "Summit Window Co." }),
      await c.invitations(t),
      await c.invite(t, { email: "sam@summitwindows.test", roleKey: "member" }),
      await c.resendInvitation(t, "inv-1"),
      await c.revokeInvitation(t, "inv-1"),
    ];
    for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/tenancy/v1/session",
      "GET /api/tenancy/v1/slug?name=Summit+Window+Co.",
      "GET /api/tenancy/v1/slug?slug=summit&tenantId=t%2F1",
      "POST /api/tenancy/v1/companies",
      "POST /api/tenancy/v1/active",
      "POST /api/tenancy/v1/invitations/accept",
      "POST /api/tenancy/v1/invitations/inv%201/join",
      "GET /api/tenancy/v1/companies/t%2F1",
      "POST /api/tenancy/v1/companies/t%2F1/profile",
      "POST /api/tenancy/v1/companies/t%2F1/branding",
      "POST /api/tenancy/v1/companies/t%2F1/logo/remove",
      "GET /api/tenancy/v1/companies/t%2F1/settings",
      "POST /api/tenancy/v1/companies/t%2F1/settings/company",
      "GET /api/tenancy/v1/companies/t%2F1/checklist",
      "POST /api/tenancy/v1/companies/t%2F1/checklist/team.invite/dismiss",
      "POST /api/tenancy/v1/companies/t%2F1/checklist/hide",
      "GET /api/tenancy/v1/companies/t%2F1/members",
      "POST /api/tenancy/v1/companies/t%2F1/members/u%2Fsam/role",
      "POST /api/tenancy/v1/companies/t%2F1/members/u-sam/remove",
      "POST /api/tenancy/v1/companies/t%2F1/leave",
      "POST /api/tenancy/v1/companies/t%2F1/transfer",
      "GET /api/tenancy/v1/companies/t%2F1/invitations",
      "POST /api/tenancy/v1/companies/t%2F1/invitations",
      "POST /api/tenancy/v1/companies/t%2F1/invitations/inv-1/resend",
      "POST /api/tenancy/v1/companies/t%2F1/invitations/inv-1/revoke",
    ]);
  });

  it("GETs carry no custom header (no preflight); POSTs send JSON bodies; nothing is cached", async () => {
    const inits: RequestInit[] = [];
    const { fetchImpl, seen } = fakeFetch((url, init) => {
      inits.push(init);
      return answerFor(url, init.method ?? "GET");
    });
    const c = createTenancyClient({ baseUrl: "/api/tenancy", fetch: fetchImpl });
    await c.session();
    await c.setActive("t-summit");
    await c.createCompany({ name: "Summit", requestKey: "k-123456789" });
    expect(seen[0]!.headers).toEqual({});
    expect(seen[1]!.headers).toEqual({ "content-type": "application/json" });
    expect(seen[1]!.body).toEqual({ tenantId: "t-summit" });
    expect(seen[2]!.body).toEqual({ name: "Summit", requestKey: "k-123456789" });
    for (const init of inits) expect(init.cache).toBe("no-store");
  });

  it("the logo goes as multipart, field 'file', with NO content-type set by hand (the FormData sets its boundary)", async () => {
    const { fetchImpl, seen } = fakeFetch((url, init) => answerFor(url, init.method ?? "GET"));
    const c = createTenancyClient({ baseUrl: "/api/tenancy", fetch: fetchImpl, headers: { "x-extra": "1" } });
    const file = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const res = await c.uploadLogo("t-summit", file);
    expect(res.ok).toBe(true);
    expect(seen[0]!.url).toBe("/api/tenancy/v1/companies/t-summit/logo");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers).toEqual({ "x-extra": "1" });
    expect(seen[0]!.body).toBeInstanceOf(FormData);
    expect((seen[0]!.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  it("a 401 is signed out, whatever the body", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("Sign in", { status: 401 }));
    const res = await createTenancyClient({ baseUrl: "/api/tenancy", fetch: fetchImpl }).team("t-summit");
    expect(res).toEqual({ ok: false, error: { code: "signed_out", message: SIGNED_OUT_MESSAGE, status: 401 } });
  });

  it("a sign-in wall that redirects to an HTML page is signed out too", async () => {
    const page = new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(page, "redirected", { value: true });
    const { fetchImpl } = fakeFetch(() => page);
    const res = await createTenancyClient({ baseUrl: "/api/tenancy", fetch: fetchImpl }).session();
    expect(!res.ok && res.error.code).toBe("signed_out");
  });

  it("an HTML error page or an unknown shape is bad_response, in plain words", async () => {
    const html = fakeFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const a = await createTenancyClient({ baseUrl: "/x", fetch: html.fetchImpl }).team("t");
    // polish 3: a proxy's 502 says what it means; the generic sentence is left for a 500.
    expect(a).toEqual({ ok: false, error: { code: "bad_response", message: "The site isn't answering right now. Please try again in a minute.", status: 502 } });
    const crash = fakeFetch(() => new Response("<html>500</html>", { status: 500, headers: { "content-type": "text/html" } }));
    const a2 = await createTenancyClient({ baseUrl: "/x", fetch: crash.fetchImpl }).team("t");
    expect(a2).toEqual({ ok: false, error: { code: "bad_response", message: BAD_RESPONSE_MESSAGE, status: 500 } });
    const odd = fakeFetch(() => json({ members: "nope" }));
    const b = await createTenancyClient({ baseUrl: "/x", fetch: odd.fetchImpl }).team("t");
    expect(!b.ok && b.error.code).toBe("bad_response");
    const unknownCode = fakeFetch(() => json({ error: { code: "teapot", message: "I'm a teapot" } }, 418));
    const c = await createTenancyClient({ baseUrl: "/x", fetch: unknownCode.fetchImpl }).team("t");
    expect(!c.ok && c.error.code).toBe("bad_response");
  });

  it("a thrown fetch is network, status 0, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const res = await createTenancyClient({ baseUrl: "/x", fetch: fetchImpl }).session();
    expect(res).toEqual({ ok: false, error: { code: "network", message: NETWORK_MESSAGE, status: 0 } });
    const broken = (async () => ({}) as Response) as typeof fetch;
    const r2 = await createTenancyClient({ baseUrl: "/x", fetch: broken }).session();
    expect(!r2.ok && r2.error.code).toBe("bad_response");
  });

  it("the error body's code, message, issues, suggestion and upgradeHref are carried through", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        {
          error: {
            code: "slug_taken",
            message: "That web address is already used by another company.",
            suggestion: "summit-window-co-2",
            issues: [{ path: ["slug"], message: "Taken." }],
          },
        },
        409,
      ),
    );
    const res = await createTenancyClient({ baseUrl: "/x", fetch: fetchImpl }).createCompany({ name: "Summit", requestKey: "k-123456789" });
    expect(res).toEqual({
      ok: false,
      error: {
        code: "slug_taken",
        message: "That web address is already used by another company.",
        status: 409,
        suggestion: "summit-window-co-2",
        issues: [{ path: ["slug"], message: "Taken." }],
      },
    });
    expect(toClientError(409, { error: { code: "seats_full", message: "Full.", upgradeHref: "/billing" } })).toEqual({
      code: "seats_full",
      message: "Full.",
      status: 409,
      upgradeHref: "/billing",
    });
  });

  it("a code with no message gets the server's own default sentence, never the code", () => {
    expect(toClientError(403, { error: { code: "not_a_member" } }).message).toBe("You're not part of this company.");
    expect(WIRE_ERROR_CODES.size).toBe(28);
  });

  it("reads narrowly: a ready session without a company, or an accepted join without one, is a bad answer", () => {
    expect(parseSession({ ...session(), company: null })).toBeNull();
    expect(parseSession({ ...session(), state: "needs-onboarding", company: null })?.companies).toEqual([]);
    const team0 = team();
    const parsed = parseTeam({ ...team0, members: [{ ...team0.members[1], actions: "everything" }] });
    // A malformed `actions` grants nothing.
    expect(parsed?.members[0]!.actions).toEqual({ roles: [], remove: false, transferTo: false });
  });
});

describe("createTenancyAdminClient", () => {
  it("every operator route at its exact URL and method", async () => {
    const { fetchImpl, seen } = fakeFetch((url) => {
      if (url.includes("/staff-roles")) return json({ roles: people().roles });
      if (url.includes("/staff-role")) return json({ person: person() });
      if (url.includes("/people")) return json(people());
      if (/companies\?|companies$/.test(url)) return json({ companies: [adminRow()], total: 1, page: 1, pageSize: 25 });
      return json(adminDetail());
    });
    const c = createTenancyAdminClient({ baseUrl: "/api/admin/tenancy", fetch: fetchImpl });
    const results = [
      await c.companies({ q: "summit", kind: "all", status: "suspended", page: 2, pageSize: 10 }),
      await c.companies({}),
      await c.company("t/1"),
      await c.suspend("t-summit", { reason: "Unpaid for three months" }),
      await c.reactivate("t-summit"),
      await c.people({ q: "ol", staffOnly: true, page: 1 }),
      await c.staffRoles(),
      await c.setStaffRole("u-olivia", { templateKey: "cs_agent" }),
    ];
    for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/admin/tenancy/v1/admin/companies?q=summit&kind=all&status=suspended&page=2&pageSize=10",
      "GET /api/admin/tenancy/v1/admin/companies",
      "GET /api/admin/tenancy/v1/admin/companies/t%2F1",
      "POST /api/admin/tenancy/v1/admin/companies/t-summit/suspend",
      "POST /api/admin/tenancy/v1/admin/companies/t-summit/reactivate",
      "GET /api/admin/tenancy/v1/admin/people?q=ol&staffOnly=true&page=1",
      "GET /api/admin/tenancy/v1/admin/staff-roles",
      "POST /api/admin/tenancy/v1/admin/people/u-olivia/staff-role",
    ]);
    expect(seen[3]!.body).toEqual({ reason: "Unpaid for three months" });
    expect(seen[7]!.body).toEqual({ templateKey: "cs_agent" });
  });

  it("activity null stays null (not connected); a 403 not_staff stays itself", async () => {
    const detail = fakeFetch(() => json({ ...adminDetail(), activity: null }));
    const res = await createTenancyAdminClient({ baseUrl: "/x", fetch: detail.fetchImpl }).company("t");
    expect(res.ok && res.data.activity).toBeNull();
    const refused = fakeFetch(() => json({ error: { code: "not_staff", message: "That needs a staff role." } }, 403));
    const r2 = await createTenancyAdminClient({ baseUrl: "/x", fetch: refused.fetchImpl }).people({});
    expect(!r2.ok && r2.error.code).toBe("not_staff");
  });
});

describe("review round 3: what the team page is told", () => {
  it("a held invitation keeps its note and link; an older server's answer still parses (no note)", () => {
    const held = parseIssued({ invitation: invitation(), delivery: "held", link: "https://app.test/invite/h", replaced: true, note: "We emailed rae 3 minutes ago…" });
    expect(held).toMatchObject({ delivery: "held", link: "https://app.test/invite/h", note: "We emailed rae 3 minutes ago…" });
    expect(parseIssued({ invitation: invitation(), delivery: "sent", link: null, replaced: false })).toMatchObject({ delivery: "sent", note: null });
  });

  it("an invitation's wrong-account note parses; anything malformed (or absent) is no note, never a made-up one", () => {
    const at = "2026-10-12T16:00:00.000Z";
    expect(parseInvitation({ ...invitation(), wrongAccount: { signedInAs: "j•••@gmail.com", at } })?.wrongAccount).toEqual({ signedInAs: "j•••@gmail.com", at });
    expect(parseInvitation({ ...invitation(), wrongAccount: { signedInAs: null, at } })?.wrongAccount).toEqual({ signedInAs: null, at });
    const { wrongAccount: _absent, ...older } = invitation();
    expect(parseInvitation(older)?.wrongAccount).toBeNull();
    expect(parseInvitation({ ...invitation(), wrongAccount: { signedInAs: "j•••@gmail.com" } })?.wrongAccount).toBeNull();
  });
});
