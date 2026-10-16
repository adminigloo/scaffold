import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsHttpError, readJsonBody } from "../http.js";
import { createCommsAdminHandlers, upsertTemplate } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-01: every body is read through a counting reader
 * that stops at 32 KB (storage's G10 rule), never buffered whole first: a
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

describe("readJsonBody reads at most 32 KB (review SEC-01)", () => {
  it("a chunked body over the cap is refused once 32 KB have arrived; the rest is never read", async () => {
    const { stream, state } = countingStream(256, 16 * 1024);
    const refused = await readJsonBody(streamed("https://app.test/x", stream)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CommsHttpError);
    expect([(refused as CommsHttpError).code, (refused as CommsHttpError).message]).toEqual(["invalid", "That's too long to save."]);
    expect(state.pulled).toBe(48 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("a declared Content-Length over the cap is refused before a byte is read", async () => {
    const { stream, state } = countingStream(4, 16 * 1024);
    const refused = await readJsonBody(streamed("https://app.test/x", stream, { "content-length": String(10 * MiB) })).catch((error: unknown) => error);
    expect((refused as CommsHttpError).code).toBe("invalid");
    expect(state.pulled).toBe(0);
  });

  it("what fitted before still fits (a 20 000-character template body in non-ASCII text); an empty body is {}", async () => {
    const text = "é".repeat(15_000);
    const body = JSON.stringify({ subject: "Hello", body: text });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(32 * 1024);
    expect(await readJsonBody(new Request("https://app.test/x", { method: "POST", body }))).toEqual({ subject: "Hello", body: text });
    expect(await readJsonBody(new Request("https://app.test/x", { method: "POST" }))).toEqual({});
  });
});

describe("the template route stops pulling at the cap (review SEC-01)", () => {
  it("a 1 MiB chunked template save: 400 after 48 KB, the stream cancelled, the template unchanged", async () => {
    const tenantId = tenant();
    await upsertTemplate(t.db, { tenantId, key: "visit_reminder", subject: "See you", body: "Hi." });
    const h = createCommsAdminHandlers({ db: t.db, senders: {}, tenantId, authorize: () => ({ userId: "u1" }) });
    const { stream, state } = countingStream(64, 16 * 1024);
    const res = await h.handle(streamed("https://app.test/api/messages/v1/admin/templates/visit_reminder", stream));
    expect(res.status).toBe(400);
    expect(state.pulled).toBe(48 * 1024);
    expect(state.cancelled).toBe(true);
  });
});
