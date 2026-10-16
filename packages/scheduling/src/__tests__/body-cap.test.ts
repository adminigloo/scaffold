import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError, MAX_BODY_CHARS, readJsonBody } from "../http.js";
import { createResource, createSchedulingAdminHandlers, createSchedulingHandlers } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-01: every body is read through a counting reader
 * that stops at the cap (storage's G10 rule), never buffered whole first.
 * The public request, move and cancel routes need no sign-in, and a
 * self-hosted server has no platform cap to stop a chunked request that
 * never says how long it is.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const MiB = 1024 * 1024;
const NOW = new Date("2026-03-02T09:00:00Z");

/** A chunked body (no Content-Length) that counts what was pulled from it. highWaterMark 0: nothing is pulled until the reader asks. */
function countingStream(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        state.pulled += chunkBytes;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function streamed(url: string, stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("readJsonBody reads at most its cap (review SEC-01)", () => {
  it("a chunked body over the cap is refused at the cap; the rest is never read", async () => {
    const { stream, state } = countingStream(64, 64 * 1024);
    const refused = await readJsonBody(streamed("https://acme.test/api/schedule/v1/request", stream)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect([(refused as HttpError).code, (refused as HttpError).message]).toEqual(["invalid", "Request body is too large."]);
    // 20 000 characters are at most 60 000 bytes: the first 64 KiB chunk passes it.
    expect(state.pulled).toBe(64 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("a declared Content-Length over the cap is refused before a byte is read", async () => {
    const { stream, state } = countingStream(4, 64 * 1024);
    const req = streamed("https://acme.test/api/schedule/v1/request", stream, { "content-length": String(10 * MiB) });
    expect(((await readJsonBody(req).catch((error: unknown) => error)) as HttpError).code).toBe("invalid");
    expect(state.pulled).toBe(0);
  });

  it("what fitted before still fits: 20 000 characters of non-ASCII notes; an empty body is {}", async () => {
    const notes = "ü".repeat(MAX_BODY_CHARS - 20);
    const body = JSON.stringify({ notes });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_BODY_CHARS);
    expect(await readJsonBody(new Request("https://acme.test/x", { method: "POST", body }))).toEqual({ notes });
    expect(await readJsonBody(new Request("https://acme.test/x", { method: "POST" }))).toEqual({});
  });
});

describe("the routes stop pulling at the cap (review SEC-01)", () => {
  it("public request, move and cancel, and a staff POST: 400 after one chunk, the stream cancelled", async () => {
    const tenantId = tenant();
    await createResource(t.db, { tenantId, name: "Crew" });
    const { handle } = createSchedulingHandlers({ db: t.db, tenantId, manageUrl: (token) => `https://acme.test/visit/${token}`, now: () => NOW });
    const token = "A".repeat(43);
    for (const path of ["/api/schedule/v1/request", `/api/schedule/v1/visit/${token}/reschedule`, `/api/schedule/v1/visit/${token}/cancel`]) {
      const { stream, state } = countingStream(64, MiB);
      const res = await handle(streamed(`https://acme.test${path}`, stream));
      expect([path, res.status]).toEqual([path, 400]);
      expect(state.pulled, path).toBe(MiB);
      expect(state.cancelled, path).toBe(true);
    }
    const admin = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => true, now: () => NOW });
    const { stream, state } = countingStream(64, MiB);
    const res = await admin.handle(streamed("https://acme.test/api/schedule/v1/admin/visits", stream));
    expect(res.status).toBe(400);
    expect(state.pulled).toBe(MiB);
    expect(state.cancelled).toBe(true);
  });
});
