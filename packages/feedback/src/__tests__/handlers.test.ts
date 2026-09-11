import { describe, expect, it } from "vitest";
import {
  CLIENT_KEY_HEADER,
  createFeedbackHandlers,
  DEFAULT_CATEGORIES,
  submitPayloadSchema,
} from "../index.js";

const KEY = "aik_" + "ab".repeat(20);
const BASE = "http://localhost/api/igloo";

/**
 * The narrowest object that satisfies the drizzle call chains the handlers
 * actually use. Anything else throws, which is the point: a new query in the
 * handlers must show up here as a test change.
 */
function fakeDb(state: { keyRows?: Array<{ id: string; tenantId: string }>; lastTicket?: string }) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => state.keyRows ?? [] }),
        orderBy: () => ({
          limit: async () => (state.lastTicket ? [{ ticketNumber: state.lastTicket }] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          returning: async () => [{ id: "key-1" }],
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
    expect(await res.json()).toEqual({ ticketNumber: "FB-00042" });
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
