import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "../catalog.js";
import { createEstimatorHandlers } from "../handlers.js";
import { HttpError, MAX_BODY_CHARS, MAX_PHOTO_BODY_BYTES, MAX_PHOTO_BODY_CHARS, readJsonBody } from "../http.js";
import { updateEstimatorSettings } from "../settings.js";
import { memoryPhotoStore } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-01: a body is read through a counting reader that
 * stops at the cap (storage's G10 rule), never buffered whole first. The
 * public photo route takes a customer's photo with no sign-in, and a
 * self-hosted server (`next start`, a foreign host) has no platform cap to
 * stop a chunked request that never says how long it is.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const MiB = 1024 * 1024;

/** A chunked body (no Content-Length) of `chunks` × `chunkBytes` "a"s that counts what was pulled from it. */
function countingStream(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  let sent = 0;
  // highWaterMark 0: nothing is pulled until the reader asks, so `pulled` is what the code read.
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
  it("a chunked body over the cap is refused once the cap is passed, and the rest is never read", async () => {
    const { stream, state } = countingStream(64, 64 * 1024);
    const req = streamed("https://summit.test/v1/submit", stream);
    expect(req.headers.get("content-length")).toBeNull();
    const refused = await readJsonBody(req).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).code).toBe("invalid");
    expect((refused as HttpError).message).toBe("Request body is too large.");
    // 20 000 characters are at most 60 000 bytes: one 64 KiB chunk passes it.
    expect(state.pulled).toBe(64 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("a declared Content-Length over the cap is refused before a byte is read", async () => {
    const { stream, state } = countingStream(4, 64 * 1024);
    const req = streamed("https://summit.test/v1/submit", stream, { "content-length": String(10 * MiB) });
    const refused = await readJsonBody(req).catch((error: unknown) => error);
    expect((refused as HttpError).code).toBe("invalid");
    expect(state.pulled).toBe(0);
  });

  it("what fitted before still fits: 20 000 characters of non-ASCII text, an empty body, a photo-sized body", async () => {
    const note = "é".repeat(MAX_BODY_CHARS - 20);
    const body = JSON.stringify({ n: note });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_BODY_CHARS);
    expect(await readJsonBody(new Request("https://summit.test/v1/submit", { method: "POST", body }))).toEqual({ n: note });
    expect(await readJsonBody(new Request("https://summit.test/v1/submit", { method: "POST" }))).toEqual({});
    const photo = JSON.stringify({ imageBase64: "A".repeat(MAX_PHOTO_BODY_CHARS - 100), mediaType: "image/jpeg" });
    expect(await readJsonBody(new Request("https://summit.test/v1/photo", { method: "POST", body: photo }), MAX_PHOTO_BODY_CHARS, MAX_PHOTO_BODY_BYTES)).toMatchObject({
      mediaType: "image/jpeg",
    });
    // Over the characters, under the bytes: still the character rule.
    const long = JSON.stringify({ n: "a".repeat(MAX_BODY_CHARS + 1) });
    expect(((await readJsonBody(new Request("https://summit.test/v1/submit", { method: "POST", body: long })).catch((e: unknown) => e)) as HttpError).code).toBe("invalid");
  });
});

describe("the public photo route (no sign-in) stops pulling at its cap (review SEC-01)", () => {
  it("a 64 MiB chunked body is refused after about a megabyte, and the stream is cancelled", async () => {
    const tenantId = tenant("sec01");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
    await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", basePrice: 1_000 });
    const { handle } = createEstimatorHandlers({ db: t.db, tenantId, photoStore: memoryPhotoStore() });
    for (const path of ["/api/estimator/v1/photo", "/api/estimator/v1/takeoff", "/api/estimator/v1/submit"]) {
      const { stream, state } = countingStream(64, MiB);
      const res = await handle(streamed(`https://summit.test${path}`, stream));
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe("invalid");
      expect(state.pulled, path).toBeLessThanOrEqual(2 * MiB);
      expect(state.cancelled, path).toBe(true);
    }
  });
});
