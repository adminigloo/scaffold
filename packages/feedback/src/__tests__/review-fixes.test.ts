import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  BUSY_TODAY_MESSAGE,
  CLIENT_KEY_HEADER,
  createCategory,
  createFeedbackAdminHandlers,
  createFeedbackHandlers,
  createFeedbackRateLimit,
  createMemoryCounter,
  createTicket,
  ensureFeedbackBoard,
  FEEDBACK_INTAKE_LIMITS,
  feedbackFileRecords,
  feedbackScreenshotPurpose,
  getTicket,
  issueClientKey,
  listBoardData,
  listTicketMessages,
  sniffImage,
  submitPayloadSchema,
  sweepFeedbackUploads,
  UPLOAD_GRACE_MS,
  type FeedbackScreenshotStore,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * The fixes from the 2b-2a review, one block each (M1, M2, M3, M4, L1, L2).
 * Each test fails on the code before its fix.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function upload(url: string, bytes: Uint8Array, headers: Record<string, string> = {}, declared = "image/png"): Request {
  const form = new FormData();
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: declared }), "shot.png");
  form.append("kind", "screenshot");
  return new Request(url, { method: "POST", headers, body: form });
}

/** A store that keeps files in memory and remembers what was attached and removed. */
function memoryStore(privateFiles = false) {
  const kept = new Map<string, Uint8Array>();
  const attached: Array<{ fileId: string; ticketId: string }> = [];
  const removed: string[] = [];
  let n = 0;
  const store: FeedbackScreenshotStore = {
    put: async (input) => {
      n += 1;
      const fileId = `file-${n}`;
      kept.set(fileId, input.bytes);
      return privateFiles
        ? { url: `/api/app/${input.tenantId}/files/v1/admin/files/${fileId}/content`, fileId }
        : { url: `https://own.public.blob.vercel-storage.com/feedback/${input.filename}`, fileId: null };
    },
    attach: async (input) => void attached.push({ fileId: input.fileId, ticketId: input.ticketId }),
    remove: async (input) => void removed.push(input.url),
  };
  return { store, kept, attached, removed };
}

describe("M2: screenshots", () => {
  it("are refused on a company's keyless feedback page", async () => {
    const a = tenant();
    const { store, kept } = memoryStore();
    const { handle } = createFeedbackHandlers({ db: t.db, resolveTenant: () => a, screenshots: store });
    const res = await handle(upload("http://x/api/t/a/feedback/v1/upload", PNG));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("This feedback form doesn't take screenshots. Send the report without one.");
    expect(kept.size).toBe(0);
  });

  it("must really be an image, whatever the browser says, and are kept under the type they are", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const types: string[] = [];
    const { store } = memoryStore();
    const { handle } = createFeedbackHandlers({
      db: t.db,
      screenshots: { ...store, put: async (input) => (types.push(input.contentType), store.put(input)) },
    });
    const html = await handle(upload("http://x/api/igloo/v1/upload", HTML, { [CLIENT_KEY_HEADER]: key.key }));
    expect(html.status).toBe(415);
    const png = await handle(upload("http://x/api/igloo/v1/upload", PNG, { [CLIENT_KEY_HEADER]: key.key }, "image/jpeg"));
    expect(png.status).toBe(200);
    expect(types).toEqual(["image/png"]);
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(HTML)).toBeNull();
  });

  it("nobody sent a report with are swept after a day, the stored file with them; used ones stay", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const { store, removed } = memoryStore();
    const { handle } = createFeedbackHandlers({ db: t.db, screenshots: store });
    const headers = { [CLIENT_KEY_HEADER]: key.key };
    const used = ((await (await handle(upload("http://x/api/igloo/v1/upload", PNG, headers))).json()) as { url: string }).url;
    const orphan = ((await (await handle(upload("http://x/api/igloo/v1/upload", PNG, headers))).json()) as { url: string }).url;
    expect((await handle(post("http://x/api/igloo/v1/submit", report(undefined, { screenshotUrl: used }), headers))).status).toBe(201);
    // Not yet a day: nothing goes.
    expect(await sweepFeedbackUploads(t.db, { store })).toEqual({ removed: 0, failed: 0 });
    const later = new Date(Date.now() + UPLOAD_GRACE_MS + 60_000);
    // (The sweep is for the whole site: other tests' leftovers go too.)
    expect((await sweepFeedbackUploads(t.db, { store, now: later })).failed).toBe(0);
    expect(removed).toContain(orphan);
    expect(removed).not.toContain(used);
    const left = (await t.db.execute(sql`select url from feedback_uploads where tenant_id = ${a}`)) as unknown as { rows: Array<{ url: string }> };
    expect(left.rows.map((r) => r.url)).toEqual([used]);
  });
});

describe("L1: a report keeps only screenshots this board stored", () => {
  it("drops another store's address, another company's upload, and one already on a report", async () => {
    const a = tenant();
    const b = tenant();
    const aKey = await issueClientKey(t.db, { tenantId: a, label: "A" });
    const bKey = await issueClientKey(t.db, { tenantId: b, label: "B" });
    const { store } = memoryStore();
    const { handle } = createFeedbackHandlers({ db: t.db, screenshots: store });
    const bUrl = ((await (await handle(upload("http://x/api/igloo/v1/upload", PNG, { [CLIENT_KEY_HEADER]: bKey.key }))).json()) as { url: string }).url;
    const aUrl = ((await (await handle(upload("http://x/api/igloo/v1/upload", PNG, { [CLIENT_KEY_HEADER]: aKey.key }))).json()) as { url: string }).url;
    const send = (extra: Record<string, unknown>) =>
      handle(post("http://x/api/igloo/v1/submit", report(undefined, extra), { [CLIENT_KEY_HEADER]: aKey.key }));
    expect((await send({ screenshotUrl: "https://attacker-store.public.blob.vercel-storage.com/phish.png", annotatedScreenshotUrl: bUrl })).status).toBe(201);
    expect((await send({ screenshotUrl: aUrl })).status).toBe(201);
    expect((await send({ screenshotUrl: aUrl })).status).toBe(201);
    const shots = (await listBoardData(t.db, a)).tickets.map((x) => [x.screenshotUrl, x.annotatedScreenshotUrl]).reverse();
    expect(shots).toEqual([
      [null, null],
      [aUrl, null],
      [null, null],
    ]);
  });
});

describe("M3: a private screenshot goes on its ticket", () => {
  it("is attached to the ticket the report made, so the ticket's permissions decide", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const { store, attached } = memoryStore(true);
    const { handle } = createFeedbackHandlers({ db: t.db, screenshots: store });
    const headers = { [CLIENT_KEY_HEADER]: key.key };
    const url = ((await (await handle(upload("http://x/api/igloo/v1/upload", PNG, headers))).json()) as { url: string }).url;
    expect(url).toMatch(/^\/api\/app\/.+\/files\/v1\/admin\/files\/file-\d+\/content$/);
    await handle(post("http://x/api/igloo/v1/submit", report(undefined, { screenshotUrl: url }), headers));
    const [ticket] = (await listBoardData(t.db, a)).tickets;
    expect(ticket?.screenshotUrl).toBe(url);
    expect(attached).toEqual([{ fileId: url.split("/").at(-2), ticketId: ticket?.id }]);
  });

  it("picks the store per board: a company's private one, and none at all for a board without one", async () => {
    const a = tenant();
    const site = tenant("site");
    const aKey = await issueClientKey(t.db, { tenantId: a, label: "A" });
    const siteKey = await issueClientKey(t.db, { tenantId: site, label: "Site" });
    const { store } = memoryStore(true);
    const { handle } = createFeedbackHandlers({ db: t.db, screenshots: (tenantId) => (tenantId === a ? store : undefined) });
    const ok = await handle(upload("http://x/api/igloo/v1/upload", PNG, { [CLIENT_KEY_HEADER]: aKey.key }));
    expect(((await ok.json()) as { url: string }).url).toMatch(new RegExp("^/api/app/"));
    const none = await handle(upload("http://x/api/igloo/v1/upload", PNG, { [CLIENT_KEY_HEADER]: siteKey.key }));
    expect(none.status).toBe(503);
  });

  it("the purpose is private, images only, hidden until attached; the record type opens on feedback.view", async () => {
    expect(feedbackScreenshotPurpose).toMatchObject({ access: "private", hiddenUntilAttached: true, view: ["feedback.view"] });
    expect([...feedbackScreenshotPurpose.types]).toEqual(["jpeg", "png", "webp"]);
    const a = tenant();
    const b = tenant();
    const mine = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report()) });
    const [records] = feedbackFileRecords(t.db, { ticketHref: "/app/feedback?ticket={id}" });
    expect(records?.view).toEqual(["feedback.view"]);
    expect(records?.manage).toEqual(["feedback.manage"]);
    const found = await records!.find({ tenantId: a, ids: [mine.id] });
    expect(found.get(mine.id)?.href).toBe(`/app/feedback?ticket=${mine.id}`);
    expect((await records!.find({ tenantId: b, ids: [mine.id] })).size).toBe(0);
  });
});

describe("M1: the open door, held to a size", () => {
  it("refuses a filled honeypot", async () => {
    const a = tenant();
    const { handle } = createFeedbackHandlers({ db: t.db, resolveTenant: () => a });
    const res = await handle(post("http://x/api/t/a/feedback/v1/submit", report(undefined, { website: "https://spam.example" })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("spam_suspected");
    expect((await listBoardData(t.db, a)).tickets).toEqual([]);
  });

  it("counts a caller across every company, counts no-address callers together, and caps a page's day", async () => {
    let clock = 0;
    const limit = createFeedbackRateLimit(createMemoryCounter(() => clock));
    const one = (tenantId: string, ip: string | null, keyId: string | null = null) => limit({ action: "submit", tenantId, keyId, ip });
    // One visitor across many companies: the per-caller cap holds.
    const many = [];
    for (let i = 0; i < FEEDBACK_INTAKE_LIMITS.perCaller.submit.limit + 1; i++) many.push(await one(`co-${i}`, "203.0.113.9"));
    expect(many.filter((d) => d.ok)).toHaveLength(FEEDBACK_INTAKE_LIMITS.perCaller.submit.limit);
    // No address: one shared caller, counted, never let through uncounted.
    const unknown = [];
    for (let i = 0; i < FEEDBACK_INTAKE_LIMITS.perBoard.submit.limit + 1; i++) unknown.push(await one("co-x", null));
    expect(unknown.at(-1)?.ok).toBe(false);
    // A page's day: many visitors together.
    clock = 10 * 60 * 60 * 1000;
    let refused: { ok: boolean; message?: string } | undefined;
    for (let i = 0; i < FEEDBACK_INTAKE_LIMITS.keylessPerBoardDaily.submit.limit + 1; i++) {
      const decision = await one("co-busy", `198.51.100.${i % 250}-${i}`);
      if (!decision.ok) refused = decision;
    }
    expect(refused?.message).toBe(BUSY_TODAY_MESSAGE);
    // A website key isn't held to the page's day.
    expect((await one("co-busy", "192.0.2.1", "key-1")).ok).toBe(true);
  });

  it("answers a refusal in the limit's own words", async () => {
    const a = tenant();
    const { handle } = createFeedbackHandlers({
      db: t.db,
      resolveTenant: () => a,
      rateLimit: () => ({ ok: false, retryAfterSeconds: 60, message: BUSY_TODAY_MESSAGE }),
    });
    const res = await handle(post("http://x/api/t/a/feedback/v1/submit", report()));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY_TODAY_MESSAGE);
  });
});

describe("L2: only categories the board offers", () => {
  it("drops a category kept for the team's own sorting, and an unknown one", async () => {
    const a = tenant();
    await ensureFeedbackBoard(t.db, a);
    await createCategory(t.db, a, { key: "escalated", label: "Escalated", showToCustomer: false });
    const { handle } = createFeedbackHandlers({ db: t.db, resolveTenant: () => a });
    await handle(post("http://x/v1/submit", report(undefined, { category: "escalated" })));
    await handle(post("http://x/v1/submit", report(undefined, { category: "made_up" })));
    await handle(post("http://x/v1/submit", report(undefined, { category: "bug" })));
    expect((await listBoardData(t.db, a)).tickets.map((x) => x.category).reverse()).toEqual([null, null, "bug"]);
  });
});

describe("M4: a reply never carries a sign-in address as its sender", () => {
  it("uses the business's name when the person's name is an email address, or missing", async () => {
    const a = tenant();
    const ticket = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report()) });
    for (const name of ["dana@greenacres.test", null]) {
      const { handle } = createFeedbackAdminHandlers({
        db: t.db,
        tenantId: a,
        authorize: () => ({ userId: "u-1" }),
        staffName: () => name,
        teamName: () => "Green Acres",
      });
      const res = await handle(post(`http://x/v1/admin/tickets/${ticket.id}/messages`, { body: "Fixed now." }, { "sec-fetch-site": "same-origin" }));
      expect(res.status).toBe(201);
    }
    const staff = (await listTicketMessages(t.db, a, ticket.id)).filter((m) => m.senderType === "staff");
    expect(staff.map((m) => m.senderName)).toEqual(["Green Acres", "Green Acres"]);
    expect(JSON.stringify(await getTicket(t.db, a, ticket.id))).not.toContain("dana@");
  });
});
