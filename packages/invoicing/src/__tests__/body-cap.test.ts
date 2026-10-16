import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvoicingHttpError, readJsonBody } from "../http.js";
import { createInvoicingAdminHandlers, createInvoicingHandlers } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-01: every body is read through a counting reader
 * that stops at 32 KB (storage's G10 rule), never buffered whole first: the
 * customer's "viewed" POST needs no sign-in, and a self-hosted server has no
 * platform cap to stop a chunked request that never says how long it is.
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
    expect(refused).toBeInstanceOf(InvoicingHttpError);
    expect([(refused as InvoicingHttpError).code, (refused as InvoicingHttpError).message]).toEqual(["invalid", "That's too much to save at once."]);
    expect(state.pulled).toBe(48 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("a declared Content-Length over the cap is refused before a byte is read", async () => {
    const { stream, state } = countingStream(4, 16 * 1024);
    const refused = await readJsonBody(streamed("https://app.test/x", stream, { "content-length": String(10 * MiB) })).catch((error: unknown) => error);
    expect((refused as InvoicingHttpError).code).toBe("invalid");
    expect(state.pulled).toBe(0);
  });

  it("what fitted before still fits (32 KB exactly); an empty body is {}", async () => {
    const body = JSON.stringify({ description: "x".repeat(32 * 1024 - 18) });
    expect(new TextEncoder().encode(body).length).toBe(32 * 1024);
    expect(await readJsonBody(new Request("https://app.test/x", { method: "POST", body }))).toMatchObject({ description: expect.any(String) });
    expect(await readJsonBody(new Request("https://app.test/x", { method: "POST" }))).toEqual({});
  });
});

describe("the routes stop pulling at the cap (review SEC-01)", () => {
  it("the customer's viewed POST and a staff POST: refused after 48 KB, the stream cancelled", async () => {
    const tenantId = tenant("sec01");
    const customer = createInvoicingHandlers({ db: t.db, tenantId, business: () => null });
    let { stream, state } = countingStream(64, 16 * 1024);
    let res = await customer.handle(streamed(`https://app.test/api/t/x/invoices/v1/invoice/${"A".repeat(43)}/viewed`, stream));
    expect(res.status).toBe(400);
    expect(state.pulled).toBe(48 * 1024);
    expect(state.cancelled).toBe(true);
    const staff = createInvoicingAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "user-1" }), business: () => null, invoiceUrl: (token) => `https://app.test/invoice/${token}` });
    ({ stream, state } = countingStream(64, 16 * 1024));
    res = await staff.handle(streamed("https://app.test/api/invoices/v1/admin/invoices", stream));
    expect(res.status).toBe(400);
    expect(state.pulled).toBe(48 * 1024);
    expect(state.cancelled).toBe(true);
  });
});
