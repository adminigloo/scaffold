import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotificationHandlers } from "../handlers.js";
import { checkHostSeams, type CheckHostSeamsInput } from "../testing.js";
import { Directory, greenAcres, world, type World } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * `checkHostSeams` (Tenancy 2b-1, 4.12; review G19): it passes against the
 * package's own handlers over two real companies, and fails, on the right
 * line, against the three host mistakes that would leak one company's alerts
 * to another.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** A host that routes the company in the path and the person in a session header. */
function host(w: World, options: { resolveTenant?: (req: Request) => string | null; authorize?: (req: Request, permission: string, tenantId: string) => unknown } = {}) {
  const pathCompany = (req: Request) => /\/api\/app\/([^/]+)\/alerts\//.exec(new URL(req.url).pathname)?.[1] ?? null;
  return createNotificationHandlers({
    notifications: w.alerts,
    resolveTenant: options.resolveTenant ?? pathCompany,
    authorize: (options.authorize as never) ?? hostAuthorize(w),
  });
}

/** The host's own authorize, done right: a member of THIS company, which isn't suspended, holding the permission. */
function hostAuthorize(w: World) {
  return (req: Request, permission: string, tenantId: string) => {
    const user = req.headers.get("x-user");
    if (!user || !w.directory.member(tenantId, user)) return new Response("Not a member", { status: 403 });
    if (w.directory.suspended.has(tenantId)) return new Response("This company is suspended", { status: 403 });
    return w.directory.permissionsOf(tenantId, user).includes(permission) ? { userId: user } : false;
  };
}

function input(w: World, handlers: CheckHostSeamsInput["handlers"], a: string, b: string, member: string, people?: CheckHostSeamsInput["people"]): CheckHostSeamsInput {
  return {
    handlers,
    companyA: a,
    companyB: b,
    member: { userId: member },
    ...(people ? { people } : { people: w.directory.people }),
    request: (tenantId, path, init = {}) => {
      const query = init.query ? `?${new URLSearchParams(init.query as Record<string, string>)}` : "";
      const method = init.method ?? "GET";
      return new Request(`https://ridgeline.test/api/app/${tenantId}/alerts/${path}${query}`, {
        method,
        headers: { "sec-fetch-site": "same-origin", "x-user": member, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {}),
      });
    },
  };
}

function setup() {
  const directory = new Directory();
  const w = world(t, {}, directory);
  const a = tenant("a");
  const b = tenant("b");
  const p = greenAcres(directory, a);
  greenAcres(directory, b);
  // A third company the member also belongs to, which the host has suspended.
  const c = tenant("c");
  directory.add(c, { userId: p.member.userId, name: "Mo Member", email: "mo@summit.test", role: "member" });
  directory.suspended.add(c);
  return { w, a, b, c, member: p.member.userId };
}

/** The two seams a host passes so its likeliest mistakes are checked too (review FH-4): its authorize, and a suspended company. */
function seams(w: World, c: string, authorize: NonNullable<CheckHostSeamsInput["authorize"]> = hostAuthorize(w)) {
  return { authorize, suspendedCompany: c };
}

const EVERY_LINE = [
  "A member of Company A can see their alerts in Company A",
  "A member of Company A can't read Company B's alerts",
  "Naming Company A in the address doesn't open Company B's alerts",
  "Company A can't be opened at a look-alike address",
  "A request from another website is refused",
  "Your people() lists the member in Company A and not in Company B",
  "Your authorize refuses a permission the member doesn't hold",
  "A suspended company gets no alerts",
];

describe("checkHostSeams", () => {
  it("passes against the package's own handlers over two companies, with authorize and a suspended company: one plain line per check, writing nothing (review FH-4)", async () => {
    const { w, a, b, c, member } = setup();
    t.queries.length = 0;
    const result = await checkHostSeams({ ...input(w, host(w), a, b, member), ...seams(w, c), permission: "estimates.view" });
    expect(result.checks.map((check) => `${check.name}: ${check.ok ? "passed" : `FAILED (${check.detail})`}`)).toEqual(
      EVERY_LINE.map((line) => `${line}: passed`),
    );
    expect(result.ok).toBe(true);
    expect(t.queries.filter((q) => /^(insert|update|delete)/i.test(q.sql))).toEqual([]);
  });

  it("without authorize or a suspended company, those two lines FAIL as 'Not checked', saying what to pass: never a quiet pass", async () => {
    const { w, a, b, member } = setup();
    const result = await checkHostSeams(input(w, host(w), a, b, member));
    expect(result.checks.map((check) => check.name)).toEqual(EVERY_LINE);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "Your authorize refuses a permission the member doesn't hold",
      "A suspended company gets no alerts",
    ]);
    const detail = (name: string) => result.checks.find((check) => check.name === name)?.detail;
    expect(detail("Your authorize refuses a permission the member doesn't hold")).toMatch(/^Not checked: pass authorize \(/);
    expect(detail("A suspended company gets no alerts")).toMatch(/^Not checked: pass suspendedCompany \(/);
    expect(result.ok).toBe(false);
    // Either one alone still leaves the other line failed.
    const onlyAuthorize = await checkHostSeams({ ...input(w, host(w), a, b, member), authorize: hostAuthorize(w) });
    expect(onlyAuthorize.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["A suspended company gets no alerts"]);
  });

  it("fails against an authorize that only checks membership, not the permission (review FH-4)", async () => {
    const { w, a, b, c, member } = setup();
    const membersOnly = (req: Request, _permission: string, tenantId: string) => {
      const user = req.headers.get("x-user");
      if (w.directory.suspended.has(tenantId)) return new Response("This company is suspended", { status: 403 });
      return user && w.directory.member(tenantId, user) ? { userId: user } : new Response("Not a member", { status: 403 });
    };
    const result = await checkHostSeams({ ...input(w, host(w, { authorize: membersOnly }), a, b, member), ...seams(w, c, membersOnly) });
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["Your authorize refuses a permission the member doesn't hold"]);
    expect(result.checks.find((check) => !check.ok)?.detail).toMatch(/must check that the person holds the permission it is asked about/);
    expect(result.ok).toBe(false);
  });

  it("fails against a people() and an authorize that forget a suspended company (review FH-4)", async () => {
    const { w, a, b, c, member } = setup();
    const forgetful = async (tenantId: string, permission: string) => {
      const was = w.directory.suspended.has(tenantId);
      w.directory.suspended.delete(tenantId);
      try {
        return await w.directory.people(tenantId, permission);
      } finally {
        if (was) w.directory.suspended.add(tenantId);
      }
    };
    const careless = (req: Request, permission: string, tenantId: string) => {
      const user = req.headers.get("x-user");
      if (!user || !w.directory.member(tenantId, user)) return new Response("Not a member", { status: 403 });
      return w.directory.permissionsOf(tenantId, user).includes(permission) ? { userId: user } : false;
    };
    const result = await checkHostSeams({ ...input(w, host(w, { authorize: careless }), a, b, member, forgetful), ...seams(w, c, careless) });
    const failed = result.checks.filter((check) => !check.ok);
    expect(failed.map((check) => check.name)).toEqual(["A suspended company gets no alerts"]);
    expect(failed[0]?.detail).toMatch(/people\(\) lists people in the suspended company/);
    expect(failed[0]?.detail).toMatch(/answered 200/);
  });

  it("fails against company ids looked up as numbers: 017 is a second Company 17 (review FH-5)", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const n = 1000 + Math.floor(Math.random() * 1_000_000);
    const [a, b, c] = [String(n), String(n + 1), String(n + 2)];
    const p = greenAcres(directory, a);
    greenAcres(directory, b);
    directory.add(c, { userId: p.member.userId, name: "Mo Member", email: "mo@summit.test", role: "member" });
    directory.suspended.add(c);
    // The README's integer-id host before the fix: Number("017") is 17.
    const byNumber = (id: string) => String(Number(id));
    const byNumberAuthorize = (req: Request, permission: string, tenantId: string) => hostAuthorize(w)(req, permission, byNumber(tenantId));
    const numeric = host(w, { authorize: byNumberAuthorize });
    const result = await checkHostSeams({ ...input(w, numeric, a, b, p.member.userId), ...seams(w, c, byNumberAuthorize) });
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["Company A can't be opened at a look-alike address"]);
    expect(result.checks.find((check) => !check.ok)?.detail).toMatch(/answered 200/);
    // The README's fix: resolveTenant takes only the id as stored.
    const canonical = host(w, {
      resolveTenant: (req) => {
        const id = /\/api\/app\/([^/]+)\/alerts\//.exec(new URL(req.url).pathname)?.[1] ?? "";
        return /^[1-9]\d*$/.test(id) ? id : null;
      },
      authorize: byNumberAuthorize,
    });
    expect((await checkHostSeams({ ...input(w, canonical, a, b, p.member.userId), ...seams(w, c, byNumberAuthorize) })).ok).toBe(true);
  });

  it("takes a request builder that awaits (a session cookie minted on the way) (review FH-10)", async () => {
    const { w, a, b, c, member } = setup();
    const sync = input(w, host(w), a, b, member);
    const result = await checkHostSeams({
      ...sync,
      ...seams(w, c),
      request: async (tenantId, path, init) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return sync.request(tenantId, path, init) as Request;
      },
    });
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails line 3 against a resolveTenant that reads ?tenantId=", async () => {
    const { w, a, b, c, member } = setup();
    const steerable = host(w, {
      resolveTenant: (req) => new URL(req.url).searchParams.get("tenantId") ?? /\/api\/app\/([^/]+)\/alerts\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    });
    const result = await checkHostSeams({ ...input(w, steerable, a, b, member), ...seams(w, c) });
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["Naming Company A in the address doesn't open Company B's alerts"]);
    expect(result.checks[2]?.detail).toMatch(/never from \?tenantId=/);
  });

  it("fails line 2 against an authorize that ignores the company", async () => {
    const { w, a, b, member } = setup();
    const careless = host(w, { authorize: (req) => ({ userId: req.headers.get("x-user") }) });
    const result = await checkHostSeams(input(w, careless, a, b, member));
    expect(result.checks.find((c) => c.name === "A member of Company A can't read Company B's alerts")).toMatchObject({ ok: false });
    expect(result.checks[1]?.detail).toMatch(/answered 200/);
    expect(result.ok).toBe(false);
  });

  it("fails line 5 against a people() that ignores the company", async () => {
    const { w, a, b, c, member } = setup();
    const everyone = async (_tenantId: string, permission: string) => w.directory.people(a, permission);
    const result = await checkHostSeams({ ...input(w, host(w), a, b, member, everyone), ...seams(w, c) });
    // Ignoring which company it is asked about, it ignores a suspended one too.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "Your people() lists the member in Company A and not in Company B",
      "A suspended company gets no alerts",
    ]);
  });

  it("fails line 4 when something in front of the handlers rewrites the request into a same-site one", async () => {
    const { w, a, b, c, member } = setup();
    const inner = host(w);
    const rewriting = {
      handle: (req: Request) => {
        const headers = new Headers(req.headers);
        headers.set("sec-fetch-site", "same-origin");
        return inner.handle(new Request(req.url, { method: req.method, headers, ...(req.method === "POST" ? { body: "{}" } : {}) }));
      },
    };
    const result = await checkHostSeams({ ...input(w, rewriting, a, b, member), ...seams(w, c) });
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["A request from another website is refused"]);
  });

  it("never throws: a throwing handler is a failed line", async () => {
    const { w, a, b, member } = setup();
    const broken = {
      handle: async () => {
        throw new Error("boom");
      },
    };
    const result = await checkHostSeams(input(w, broken, a, b, member));
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ ok: false, detail: "the check couldn't run: boom" });
  });
});
