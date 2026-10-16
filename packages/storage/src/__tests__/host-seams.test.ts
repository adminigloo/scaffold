import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateStorageHandlersOptions } from "../handlers.js";
import { checkHostSeams, type CheckStorageHostSeamsInput } from "../host-seams.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, MEMBER_PERMISSIONS, request, resolveFromPath, SECRET, type World, assertNoPrivateKeyLeaked } from "./world.js";

/**
 * `checkHostSeams` (6.14, review G19): passes over the package's own
 * handlers, and fails, on the right line, against a host whose company can
 * be steered by the query string and against a host whose file lookup
 * ignores the company.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // D10, suite-wide: no answer above carried a private object's key.
  assertNoPrivateKeyLeaked();
  await t.close();
});

function input(w: World, handlers: CheckStorageHostSeamsInput["handlers"], a: string, b: string): CheckStorageHostSeamsInput {
  const as = (userId: string): CheckStorageHostSeamsInput["request"] => (tenantId, path, init) =>
    request(tenantId, userId, path, {
      method: init?.method ?? "GET",
      ...(init?.query ? { query: { ...init.query } } : {}),
      ...(init?.body !== undefined ? { json: init.body } : {}),
    });
  return {
    handlers,
    storage: w.storage,
    request: as("member"),
    companyA: a,
    companyB: b,
    member: { userId: "member" },
    withoutFiles: { userId: "tech", request: as("tech") },
  };
}

function setup() {
  const members = new Members();
  // A host's stillValid as the README writes it: still a member, and (review
  // SEC-03) still allowed to open the file, with what they hold now.
  const w = buildWorld(t, {
    signing: {
      secret: SECRET,
      stillValid: async (check) => {
        const as = new Request("https://app.test/", { headers: { "x-user": check.userId } });
        if (members.authorize(as, "-", check.tenantId) instanceof Response) return false;
        return check.mayView((permission) => {
          const verdict = members.authorize(as, permission, check.tenantId);
          return verdict !== false && !(verdict instanceof Response);
        });
      },
    },
  });
  const a = tenant("a");
  const b = tenant("b");
  members.set(a, "member", MEMBER_PERMISSIONS);
  members.set(a, "tech", ["schedule.route"]);
  return { w, members, a, b };
}

const line = (result: Awaited<ReturnType<typeof checkHostSeams>>, name: string) => result.checks.find((c) => c.name === name);

describe("checkHostSeams", () => {
  it("passes over the package's own handlers, in plain words, and leaves nothing behind", async () => {
    const { w, members, a, b } = setup();
    const result = await checkHostSeams(input(w, handlersFor(w, members), a, b));
    expect(result.checks.map((c) => `${c.name}: ${c.detail}`)).toEqual([
      "A member of Company A can see Company A's files: passed",
      "A member of Company A can't see Company B's files: passed",
      "The company can't be changed from the address's query string: passed",
      "Company A can't be reached under another spelling of its id: passed",
      "Company B's file can't be opened from Company A: passed",
      "Someone in Company A without files permissions can't see its files: passed",
      "A link opens for the member who made it, and for nobody who isn't a member: passed",
      "A link made by someone who can't open the file doesn't open it: passed",
      "No answer carries a file's storage key: passed",
    ]);
    expect(result.ok).toBe(true);
    expect((await w.storage.usage(a)).fileCount).toBe(0);
    expect((await w.storage.usage(b)).fileCount).toBe(0);
    expect(w.priv.objects.size).toBe(0);
  });

  it("fails the query-string line against a resolveTenant that reads ?tenantId=", async () => {
    const { w, members, a, b } = setup();
    const steerable = handlersFor(w, members, { resolveTenant: (req) => new URL(req.url).searchParams.get("tenantId") ?? resolveFromPath(req) });
    const result = await checkHostSeams(input(w, steerable, a, b));
    expect(result.ok).toBe(false);
    expect(line(result, "The company can't be changed from the address's query string")?.ok).toBe(false);
    expect(line(result, "A member of Company A can see Company A's files")?.ok).toBe(true);
  });

  it("fails the lookup line against a host whose file lookup ignores the company", async () => {
    const { w, members, a, b } = setup();
    const real = handlersFor(w, members);
    // A host that serves a file by id alone: it finds B's file wherever it is.
    const careless = {
      async handle(req: Request): Promise<Response> {
        const match = /\/v1\/admin\/files\/([^/]+)\/content$/.exec(new URL(req.url).pathname);
        if (!match) return real.handle(req);
        for (const tenantId of [a, b]) {
          const opened = await w.storage.open({ tenantId, fileId: decodeURIComponent(match[1] as string) });
          if (opened) return new Response(opened.object.body as BodyInit, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    };
    const result = await checkHostSeams(input(w, careless, a, b));
    expect(result.ok).toBe(false);
    const lookup = line(result, "Company B's file can't be opened from Company A");
    expect(lookup?.ok).toBe(false);
    expect(lookup?.detail).toContain("must be 404");
  });

  it("never throws: a handler that throws is a failed line", async () => {
    const { w, a, b } = setup();
    const result = await checkHostSeams(
      input(
        w,
        {
          handle: async () => {
            throw new Error("boom");
          },
        },
        a,
        b,
      ),
    );
    expect(result.ok).toBe(false);
    expect(line(result, "A member of Company A can see Company A's files")?.detail).toContain("threw");
  });
});

describe("checkHostSeams catches the seams that break permissions, links, suspension and id spelling (reviews FH-4, FH-5, FH-10)", () => {
  /**
   * A host the way the README builds one: its own members (in `Members`),
   * its own suspension flag, and a stillValid that checks the company, the
   * membership and (review SEC-03) the maker's access to the file now.
   */
  function host(options: { stillValid?: "real" | "always-true" | "ignores-suspension"; authorize?: "real" | "membership-only" } = {}) {
    const members = new Members();
    const suspended = new Set<string>();
    const holds = (tenantId: string, userId: string, permission: string) => {
      const verdict = members.authorize(new Request("https://app.test/", { headers: { "x-user": userId } }), permission, tenantId);
      return verdict !== false && !(verdict instanceof Response);
    };
    const member = (tenantId: string, userId: string) => !(members.authorize(new Request("https://app.test/", { headers: { "x-user": userId } }), "-", tenantId) instanceof Response);
    const w = buildWorld(t, {
      signing: {
        secret: "test-signing-secret-of-thirty-two-plus-characters",
        stillValid: async (check) => {
          if (options.stillValid === "always-true") return true;
          if (options.stillValid !== "ignores-suspension" && suspended.has(check.tenantId)) return false;
          if (!member(check.tenantId, check.userId)) return false;
          return check.mayView((permission) => holds(check.tenantId, check.userId, permission));
        },
      },
    });
    const a = tenant("a");
    const b = tenant("b");
    const s = tenant("s");
    members.set(a, "member", MEMBER_PERMISSIONS);
    members.set(a, "tech", ["schedule.route"]);
    members.set(s, "member", MEMBER_PERMISSIONS);
    suspended.add(s);
    const authorize: CreateStorageHandlersOptions["authorize"] = (req, permission, tenantId) => {
      if (suspended.has(tenantId)) return new Response("This company is suspended", { status: 403 });
      const verdict = members.authorize(req, permission, tenantId);
      if (options.authorize === "membership-only" && verdict === false) return { userId: req.headers.get("x-user") };
      return verdict;
    };
    const handlers = handlersFor(w, members, { authorize });
    return { w, members, a, b, s, handlers, suspended };
  }

  function fullInput(h: ReturnType<typeof host>, extra: Partial<CheckStorageHostSeamsInput> = {}): CheckStorageHostSeamsInput {
    const as = (userId: string) => (tenantId: string, path: string, init?: Parameters<CheckStorageHostSeamsInput["request"]>[2]) =>
      request(tenantId, userId, path, { method: init?.method ?? "GET", ...(init?.query ? { query: { ...init.query } } : {}), ...(init?.body !== undefined ? { json: init.body } : {}) });
    return {
      handlers: h.handlers,
      storage: h.w.storage,
      // Review FH-10: a builder may be async (it signs a session cookie first).
      request: async (tenantId, path, init) => as("member")(tenantId, path, init),
      companyA: h.a,
      companyB: h.b,
      member: { userId: "member" },
      withoutFiles: { userId: "tech", request: as("tech") },
      suspendedCompany: h.s,
      ...extra,
    };
  }

  it("passes over a host whose seams are right, every new line included", async () => {
    const h = host();
    const result = await checkHostSeams(fullInput(h));
    expect(result.checks.map((c) => `${c.name}: ${c.detail}`)).toEqual([
      "A member of Company A can see Company A's files: passed",
      "A member of Company A can't see Company B's files: passed",
      "The company can't be changed from the address's query string: passed",
      "Company A can't be reached under another spelling of its id: passed",
      "Company B's file can't be opened from Company A: passed",
      "Someone in Company A without files permissions can't see its files: passed",
      "A link opens for the member who made it, and for nobody who isn't a member: passed",
      "A link made by someone who can't open the file doesn't open it: passed",
      "A suspended company's files can't be reached: passed",
      "No answer carries a file's storage key: passed",
    ]);
    expect(result.ok).toBe(true);
    for (const company of [h.a, h.b, h.s]) expect((await h.w.storage.usage(company)).fileCount).toBe(0);
  });

  it("an authorize that only checks membership fails the permission line (a tech with no files permission saw the files)", async () => {
    const result = await checkHostSeams(fullInput(host({ authorize: "membership-only" })));
    expect(result.ok).toBe(false);
    expect(line(result, "Someone in Company A without files permissions can't see its files")?.ok).toBe(false);
  });

  it("without someone who holds no files permission, that line says it wasn't checked, and the list isn't a pass", async () => {
    const { withoutFiles: _skip, ...rest } = fullInput(host());
    const result = await checkHostSeams(rest);
    const check = line(result, "Someone in Company A without files permissions can't see its files");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/^Not checked: pass withoutFiles/);
    expect(result.ok).toBe(false);
  });

  it("a stillValid that always says yes fails the link lines", async () => {
    const result = await checkHostSeams(fullInput(host({ stillValid: "always-true" })));
    expect(result.ok).toBe(false);
    expect(line(result, "A link opens for the member who made it, and for nobody who isn't a member")?.ok).toBe(false);
    expect(line(result, "A link made by someone who can't open the file doesn't open it")?.ok).toBe(false);
  });

  it("a stillValid that forgets suspension fails the suspended line", async () => {
    const result = await checkHostSeams(fullInput(host({ stillValid: "ignores-suspension" })));
    expect(line(result, "A suspended company's files can't be reached")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("a host that reads integer ids with Number() fails the spelling line: '017' was company 17 (review FH-5)", async () => {
    const h = host();
    const real = h.handlers;
    // The README's resolveTenant passes the path text through, and authorize looks the company up by Number(): "0{A}" is A.
    const aliasing = {
      handle: (req: Request) => {
        const url = new URL(req.url);
        const zeroA = `/api/app/${encodeURIComponent(`0${h.a}`)}/`;
        if (url.pathname.startsWith(zeroA)) {
          url.pathname = url.pathname.replace(zeroA, `/api/app/${encodeURIComponent(h.a)}/`);
          return real.handle(new Request(url, req));
        }
        return real.handle(req);
      },
    };
    const result = await checkHostSeams(fullInput(h, { handlers: aliasing }));
    expect(line(result, "Company A can't be reached under another spelling of its id")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
