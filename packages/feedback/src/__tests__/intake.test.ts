import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_KEY_HEADER,
  createFeedbackHandlers,
  createTicket,
  DEFAULT_CATEGORIES,
  FEEDBACK_PUBLIC_ROUTES,
  createCategory,
  issueClientKey,
  listBoardData,
  moveTicket,
  revokeClientKey,
  submitPayloadSchema,
  type FeedbackAdmission,
  type FeedbackEvent,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * The intake (what a reporter's widget calls), both ways a request names its
 * company: by a WEBSITE KEY (0.9's way, and a company's own website), and by
 * the company's public feedback page (`resolveTenant`, no key). And
 * `admit`: a closed company takes no new ticket, while a reporter can still
 * read and reply on the one they have.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const BASE = "http://localhost/api/igloo";

/** A 1x1 PNG: real image bytes. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

function post(path: string, body: unknown, headers: Record<string, string> = {}, base = BASE): Request {
  return new Request(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function get(path: string, headers: Record<string, string> = {}, base = BASE): Request {
  return new Request(`${base}/${path}`, { headers });
}
async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** /t/{slug}/… → the company that address names (a map, as a host's lookup would be). */
function bySlug(slugs: Record<string, string>) {
  return (req: Request) => {
    const match = /\/api\/t\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname);
    return match ? (slugs[match[1] ?? ""] ?? null) : null;
  };
}

describe("by website key", () => {
  it("puts the report on the key's company's board, numbered there, and answers its token once", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const events: FeedbackEvent[] = [];
    const { handle } = createFeedbackHandlers({ db: t.db, onEvent: (event) => void events.push(event) });
    const res = await handle(post("v1/submit", report(), { [CLIENT_KEY_HEADER]: key.key }));
    expect(res.status).toBe(201);
    const json = await body(res);
    expect(json.ticketNumber).toBe("FB-00001");
    expect(String(json.ticketToken)).toMatch(/^aft_/);
    const board = await listBoardData(t.db, a);
    expect(board.tickets).toHaveLength(1);
    expect(events).toMatchObject([{ type: "ticket.created", tenantId: a, ticketNumber: "FB-00001" }]);
  });

  it("refuses a missing, unknown or switched-off key with a plain sentence", async () => {
    const { handle } = createFeedbackHandlers({ db: t.db });
    const missing = await handle(get("v1/config"));
    expect(missing.status).toBe(401);
    expect((await body(missing)).error).toBe("This feedback form is missing its website key.");
    const unknown = await handle(get("v1/config", { [CLIENT_KEY_HEADER]: "aik_" + "0".repeat(40) }));
    expect(unknown.status).toBe(401);
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    await revokeClientKey(t.db, a, key.id);
    expect((await handle(get("v1/config", { [CLIENT_KEY_HEADER]: key.key }))).status).toBe(401);
  });

  it("offers the company's own categories, and the built-in list when it has none", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const { handle } = createFeedbackHandlers({ db: t.db });
    const first = await body(await handle(get("v1/config", { [CLIENT_KEY_HEADER]: key.key })));
    // The first use seeds the company's categories from the defaults.
    expect((first.categories as Array<{ key: string }>).map((c) => c.key)).toEqual(DEFAULT_CATEGORIES.map((c) => c.key));
    await createCategory(t.db, a, { key: "billing", label: "Billing question" });
    const next = await body(await handle(get("v1/config", { [CLIENT_KEY_HEADER]: key.key })));
    expect((next.categories as Array<{ key: string }>).map((c) => c.key)).toContain("billing");
    expect(next.closed).toBeNull();
  });
});

describe("by the company's own feedback page (no key)", () => {
  it("files the report on the company the address names, and its thread is only there", async () => {
    const a = tenant();
    const b = tenant();
    const { handle } = createFeedbackHandlers({ db: t.db, resolveTenant: bySlug({ alpha: a, bravo: b }) });
    const atA = "http://localhost/api/t/alpha/feedback";
    const atB = "http://localhost/api/t/bravo/feedback";
    const sent = await body(await handle(post("v1/submit", report(), {}, atA)));
    await handle(post("v1/submit", report("Bravo's own report about its own thing."), {}, atB));
    const pair = { ticketNumber: sent.ticketNumber, ticketToken: sent.ticketToken };
    // Both companies have an FB-00001: the address decides which one is read.
    const thread = await handle(post("v1/thread", pair, {}, atA));
    expect(thread.status).toBe(200);
    const atBravo = await handle(post("v1/thread", pair, {}, atB));
    expect(atBravo.status).toBe(404);
    expect(JSON.stringify(await body(atBravo))).not.toContain(String(sent.ticketToken));
    expect((await handle(post("v1/reply", { ...pair, body: "Hello?" }, {}, atB))).status).toBe(404);
    expect((await handle(get("v1/config", {}, "http://localhost/api/t/nobody/feedback"))).status).toBe(404);
  });

  it("refuses a website key of ANOTHER company under this company's address", async () => {
    const a = tenant();
    const b = tenant();
    const bKey = await issueClientKey(t.db, { tenantId: b, label: "B site" });
    const aKey = await issueClientKey(t.db, { tenantId: a, label: "A site" });
    const { handle } = createFeedbackHandlers({ db: t.db, resolveTenant: bySlug({ alpha: a }) });
    const at = "http://localhost/api/t/alpha/feedback";
    expect((await handle(post("v1/submit", report(), { [CLIENT_KEY_HEADER]: bKey.key }, at))).status).toBe(404);
    expect((await handle(post("v1/submit", report(), { [CLIENT_KEY_HEADER]: aKey.key }, at))).status).toBe(201);
    expect((await listBoardData(t.db, b)).tickets).toEqual([]);
  });
});

describe("a closed company (admit)", () => {
  it("takes no new ticket or screenshot, says so in config, and still lets a reporter read and reply", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const ticket = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report()) });
    let admission: FeedbackAdmission = { open: false, message: "Alpha isn't taking requests online right now." };
    const { handle } = createFeedbackHandlers({
      db: t.db,
      admit: () => admission,
      storeFile: async () => ({ url: "https://x.public.blob.vercel-storage.com/a.png" }),
    });
    const headers = { [CLIENT_KEY_HEADER]: key.key };
    const refused = await handle(post("v1/submit", report(), headers));
    expect(refused.status).toBe(409);
    expect(await body(refused)).toMatchObject({ code: "feedback_closed", error: "Alpha isn't taking requests online right now." });
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
    form.append("kind", "screenshot");
    expect((await handle(new Request(`${BASE}/v1/upload`, { method: "POST", headers, body: form }))).status).toBe(409);
    expect((await body(await handle(get("v1/config", headers)))).closed).toBe("Alpha isn't taking requests online right now.");
    const pair = { ticketNumber: ticket.ticketNumber, ticketToken: ticket.ticketToken };
    expect((await handle(post("v1/thread", pair, headers))).status).toBe(200);
    expect((await handle(post("v1/reply", { ...pair, body: "Any news?" }, headers))).status).toBe(201);
    admission = { open: true };
    expect((await handle(post("v1/submit", report(), headers))).status).toBe(201);
  });

  it("treats an admission that throws as closed, and tells the host", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const errors: string[] = [];
    const { handle } = createFeedbackHandlers({
      db: t.db,
      admit: () => {
        throw new Error("lookup down");
      },
      onError: (_e, context) => void errors.push(context.route),
    });
    expect((await handle(post("v1/submit", report(), { [CLIENT_KEY_HEADER]: key.key }))).status).toBe(409);
    expect(errors).toContain("admit");
  });
});

describe("replies", () => {
  it("refuse a finished ticket, announce a reply with its message id, and hide the board's own notes", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const ticket = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report(undefined, { reporter: { name: "Pat" } })) });
    const events: FeedbackEvent[] = [];
    const { handle } = createFeedbackHandlers({ db: t.db, onEvent: (event) => void events.push(event) });
    const headers = { [CLIENT_KEY_HEADER]: key.key };
    const pair = { ticketNumber: ticket.ticketNumber, ticketToken: ticket.ticketToken };
    const replied = await handle(post("v1/reply", { ...pair, body: "It happens on Fridays." }, headers));
    expect(replied.status).toBe(201);
    expect(events[0]).toMatchObject({ type: "reporter.replied", tenantId: a, reporterName: "Pat" });
    expect((events[0] as { messageId?: string }).messageId).toBeTruthy();
    await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "closed" });
    const closed = await handle(post("v1/reply", { ...pair, body: "Hello?" }, headers));
    expect(closed.status).toBe(409);
    const thread = await body(await handle(post("v1/thread", pair, headers)));
    expect((thread.ticket as { statusLabel: string }).statusLabel).toBe("Closed");
    expect((thread.messages as Array<{ senderType: string }>).every((m) => m.senderType !== "system")).toBe(true);
  });

  it("refuse a wrong token with the same answer as an unknown number", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const ticket = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report()) });
    const { handle } = createFeedbackHandlers({ db: t.db });
    const headers = { [CLIENT_KEY_HEADER]: key.key };
    const wrong = await handle(post("v1/thread", { ticketNumber: ticket.ticketNumber, ticketToken: "aft_nope" }, headers));
    const unknown = await handle(post("v1/thread", { ticketNumber: "FB-99999", ticketToken: ticket.ticketToken }, headers));
    expect([wrong.status, await wrong.text()]).toEqual([unknown.status, await unknown.text()]);
  });
});

describe("the public route table", () => {
  it("matches the router: every row reaches its route, never a 404 for the route itself or a 500", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    const ticket = await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report()) });
    const rows: Record<string, string> = { "ticket-number": ticket.ticketNumber, "ticket-token": ticket.ticketToken };
    const { handle } = createFeedbackHandlers({ db: t.db, storeFile: async () => ({ url: "https://x.public.blob.vercel-storage.com/a.png" }) });
    for (const route of FEEDBACK_PUBLIC_ROUTES) {
      const url = `${BASE}/${route.path}`;
      const headers = { [CLIENT_KEY_HEADER]: key.key };
      let res: Response;
      if (route.method === "GET") res = await handle(new Request(url, { headers }));
      else if ((route.body as { multipart?: string }).multipart === "file") {
        const form = new FormData();
        form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
        form.append("kind", "screenshot");
        res = await handle(new Request(url, { method: "POST", headers, body: form }));
      } else {
        const filled = JSON.parse(JSON.stringify(route.body).replace(/\{([a-z-]+)\}/g, (_w, name: string) => rows[name] ?? ""));
        res = await handle(new Request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(filled) }));
      }
      expect(res.status, route.kind).toBeLessThan(300);
    }
  });
});
