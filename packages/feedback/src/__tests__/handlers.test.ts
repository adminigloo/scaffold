import { describe, expect, it } from "vitest";
import {
  CLIENT_KEY_HEADER,
  createFeedbackHandlers,
  DEFAULT_CATEGORIES,
  hashReporterToken,
  REPORTER_TOKEN_PREFIX,
  submitPayloadSchema,
} from "../index.js";

const KEY = "aik_" + "ab".repeat(20);
const BASE = "http://localhost/api/igloo";

/**
 * The narrowest object that satisfies the drizzle call chains the handlers
 * actually use. Anything else throws, which is the point: a new query in the
 * handlers must show up here as a test change.
 *
 * Routed by PROJECTION rather than by table, because the fake never sees the
 * table object — but each of the handlers' queries selects a distinctive
 * column, and that is a fact about the queries this file exists to pin.
 */
function fakeDb(state: {
  keyRows?: Array<{ id: string; tenantId: string }>;
  lastTicket?: string;
  ticketRows?: Array<Record<string, unknown>>;
  statusRows?: Array<{ label: string }>;
  messageRows?: Array<Record<string, unknown>>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: (projection: Record<string, unknown> = {}) => {
      const rows = (): unknown[] => {
        if ("reporterTokenHash" in projection) return state.ticketRows ?? [];
        if ("label" in projection) return state.statusRows ?? [];
        if ("senderType" in projection) return state.messageRows ?? [];
        return state.keyRows ?? [];
      };
      const lastTicketRows = () =>
        state.lastTicket ? [{ ticketNumber: state.lastTicket }] : [];
      return {
        from: () => ({
          where: () => ({
            limit: async () => rows(),
            // listTicketMessages awaits where().orderBy() directly.
            orderBy: () => ({
              then: (resolve: (value: unknown) => void) => resolve(rows()),
            }),
          }),
          // nextTicketNumber: no where, orderBy().limit().
          orderBy: () => ({ limit: async () => lastTicketRows() }),
        }),
      };
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          returning: async () => [
            { ...row, id: `row-${inserted.length}`, createdAt: new Date() },
          ],
          then: (resolve: (value: unknown) => void) => resolve(undefined),
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return { db: db as never, inserted };
}

function validPayload() {
  return {
    description: "The export button crashes when the table is empty.",
    priority: "high",
    category: "bug",
    clientMetadata: {
      browser: "Chrome",
      os: "Windows",
      viewport: { width: 1920, height: 1080 },
      url: "https://app.example.com/reports",
      pathname: "/reports",
      clickTrail: [{ type: "click", timestamp: 1, target: "button#export" }],
      sessionId: "sess_abc",
      capturedAt: 2,
    },
  };
}

describe("submitPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    expect(submitPayloadSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("rejects a description under 10 characters", () => {
    const payload = { ...validPayload(), description: "too short" };
    expect(submitPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("pins screenshot URLs to the app's blob store", () => {
    const foreign = {
      ...validPayload(),
      screenshotUrl: "https://evil.example.com/fake-invoice.png",
    };
    expect(submitPayloadSchema.safeParse(foreign).success).toBe(false);

    const ours = {
      ...validPayload(),
      screenshotUrl: "https://abc123.public.blob.vercel-storage.com/feedback/t1/1-screenshot.jpg",
    };
    expect(submitPayloadSchema.safeParse(ours).success).toBe(true);
  });
});

describe("createFeedbackHandlers", () => {
  it("answers OPTIONS preflight with CORS headers and no body", async () => {
    const { db } = fakeDb({});
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(new Request(`${BASE}/v1/submit`, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain(CLIENT_KEY_HEADER);
  });

  it("401s without a key, and on a key the database does not recognise", async () => {
    const { db } = fakeDb({ keyRows: [] });
    const { handle } = createFeedbackHandlers({ db });

    const noKey = await handle(new Request(`${BASE}/v1/config`, { method: "GET" }));
    expect(noKey.status).toBe(401);

    const badKey = await handle(
      new Request(`${BASE}/v1/config`, { method: "GET", headers: { [CLIENT_KEY_HEADER]: KEY } }),
    );
    expect(badKey.status).toBe(401);
  });

  it("serves the default categories to a valid key", async () => {
    const { db } = fakeDb({ keyRows: [{ id: "k1", tenantId: "t1" }] });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(
      new Request(`${BASE}/v1/config`, { method: "GET", headers: { [CLIENT_KEY_HEADER]: KEY } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { categories: unknown };
    expect(body.categories).toEqual(DEFAULT_CATEGORIES);
  });

  it("answers 503 skipped when no storeFile is configured, instead of throwing", async () => {
    const { db } = fakeDb({ keyRows: [{ id: "k1", tenantId: "t1" }] });
    const { handle } = createFeedbackHandlers({ db });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(10)], { type: "image/jpeg" }));
    form.append("kind", "screenshot");
    const res = await handle(
      new Request(`${BASE}/v1/upload`, {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: KEY },
        body: form,
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ skipped: true });
  });

  it("stores uploads under the tenant's prefix", async () => {
    const { db } = fakeDb({ keyRows: [{ id: "k1", tenantId: "tenant-42" }] });
    const paths: string[] = [];
    const { handle } = createFeedbackHandlers({
      db,
      storeFile: async (path) => {
        paths.push(path);
        return { url: `https://x.public.blob.vercel-storage.com/${path}` };
      },
    });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(10)], { type: "image/jpeg" }));
    form.append("kind", "annotated");
    const res = await handle(
      new Request(`${BASE}/v1/upload`, {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: KEY },
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    expect(paths[0]).toMatch(/^feedback\/tenant-42\/\d+-annotated\.jpg$/);
  });

  it("creates a ticket scoped to the key's tenant and numbers it after the last one", async () => {
    const { db, inserted } = fakeDb({
      keyRows: [{ id: "k1", tenantId: "tenant-42" }],
      lastTicket: "FB-00041",
    });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(
      new Request(`${BASE}/v1/submit`, {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: KEY, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
    );
    expect(res.status).toBe(201);
    // toMatchObject: the response also carries the reporter token, whose
    // shape and storage the 0.4.0 suite below pins.
    expect(await res.json()).toMatchObject({ ticketNumber: "FB-00042" });
    expect(inserted[0]).toMatchObject({
      tenantId: "tenant-42",
      ticketNumber: "FB-00042",
      title: "The export button crashes when the table is empty.",
      pagePathname: "/reports",
      status: "open",
    });
  });

  it("400s on a payload the schema rejects", async () => {
    const { db } = fakeDb({ keyRows: [{ id: "k1", tenantId: "t1" }] });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(
      new Request(`${BASE}/v1/submit`, {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: KEY, "content-type": "application/json" },
        body: JSON.stringify({ description: "short" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("the reporter thread (0.4.0)", () => {
  const TOKEN = REPORTER_TOKEN_PREFIX + "cd".repeat(20);

  async function ticketRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ticket-1",
      tenantId: "t1",
      ticketNumber: "FB-00007",
      title: "The export button crashes",
      status: "in_progress",
      reporterName: "Pat",
      reporterEmail: null,
      reporterTokenHash: await hashReporterToken(TOKEN),
      createdAt: new Date("2026-09-14T12:00:00Z"),
      ...overrides,
    };
  }

  function post(path: string, body: unknown): Request {
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { [CLIENT_KEY_HEADER]: KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("mints a token at submit and stores only its hash", async () => {
    const { db, inserted } = fakeDb({ keyRows: [{ id: "k1", tenantId: "t1" }] });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(
      new Request(`${BASE}/v1/submit`, {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: KEY, "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketToken?: string };
    expect(body.ticketToken).toMatch(new RegExp(`^${REPORTER_TOKEN_PREFIX}[0-9a-f]{40}$`));
    // The row keeps the hash of exactly the token the response handed out —
    // the same one-way promise the client keys make, asserted end to end.
    expect(inserted[0]?.["reporterTokenHash"]).toBe(
      await hashReporterToken(body.ticketToken ?? ""),
    );
  });

  it("serves the thread to the right token, and withholds the kitchen", async () => {
    const { db } = fakeDb({
      keyRows: [{ id: "k1", tenantId: "t1" }],
      ticketRows: [await ticketRow()],
      statusRows: [{ label: "In progress" }],
      messageRows: [
        { id: "m1", ticketId: "ticket-1", senderType: "staff", senderName: "dallin@x.com", body: "On it.", createdAt: new Date() },
        { id: "m2", ticketId: "ticket-1", senderType: "system", senderName: "dallin@x.com", body: "Assigned to Ben", createdAt: new Date() },
        { id: "m3", ticketId: "ticket-1", senderType: "reporter", senderName: "Pat", body: "Thanks!", createdAt: new Date() },
      ],
    });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(post("/v1/thread", { ticketNumber: "FB-00007", ticketToken: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: { statusLabel: string };
      messages: Array<{ id: string; senderType: string }>;
    };
    // The board's configured label, not the raw key a client may have customised.
    expect(body.ticket.statusLabel).toBe("In progress");
    // "Assigned to Ben" is staff narration — it names colleagues and workload
    // to someone outside the firm, so it must never cross this boundary.
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("answers 404 identically for a wrong token, another tenant's ticket, and a pre-0.4 ticket", async () => {
    // One indistinguishable answer, or a client key becomes an enumeration
    // oracle for which ticket numbers exist and whose they are.
    const cases = [
      { ticketRows: [await ticketRow()], token: REPORTER_TOKEN_PREFIX + "ef".repeat(20) },
      { ticketRows: [await ticketRow({ tenantId: "someone-else" })], token: TOKEN },
      { ticketRows: [await ticketRow({ reporterTokenHash: null })], token: TOKEN },
      { ticketRows: [], token: TOKEN },
    ];
    const bodies: string[] = [];
    for (const testCase of cases) {
      const { db } = fakeDb({
        keyRows: [{ id: "k1", tenantId: "t1" }],
        ticketRows: testCase.ticketRows,
      });
      const { handle } = createFeedbackHandlers({ db });
      const res = await handle(
        post("/v1/thread", { ticketNumber: "FB-00007", ticketToken: testCase.token }),
      );
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("attributes a reply to the ticket's own reporter, never to the request", async () => {
    const { db, inserted } = fakeDb({
      keyRows: [{ id: "k1", tenantId: "t1" }],
      ticketRows: [await ticketRow()],
    });
    const { handle } = createFeedbackHandlers({ db });
    const res = await handle(
      post("/v1/reply", { ticketNumber: "FB-00007", ticketToken: TOKEN, body: "Still happening." }),
    );
    expect(res.status).toBe(201);
    // The token proves "the person who filed this", so the message says
    // exactly that: the sender identity comes from the ticket row, and the
    // request body has no field that could claim to be somebody else.
    expect(inserted[0]).toMatchObject({
      ticketId: "ticket-1",
      senderType: "reporter",
      senderName: "Pat",
      body: "Still happening.",
    });
  });

  it("rejects an empty or oversize reply before touching the ticket", async () => {
    const { db, inserted } = fakeDb({
      keyRows: [{ id: "k1", tenantId: "t1" }],
      ticketRows: [await ticketRow()],
    });
    const { handle } = createFeedbackHandlers({ db });
    for (const body of ["", "x".repeat(5001)]) {
      const res = await handle(
        post("/v1/reply", { ticketNumber: "FB-00007", ticketToken: TOKEN, body }),
      );
      expect(res.status).toBe(400);
    }
    expect(inserted).toEqual([]);
  });
});
