import { afterEach, describe, expect, it } from "vitest";
import { JSON_BODY_MAX_BYTES, LOGO_BODY_MAX_BYTES } from "../server/http.js";
import { call, handlersFor, harness, jsonOf, type Harness } from "./harness.js";

/**
 * Tenancy 2b-1 review SEC-01: a body is read through a counting reader that
 * stops at the cap (storage's G10 rule), never buffered whole first. The
 * logo upload checked only the Content-Length header and then ran
 * `req.formData()`: a chunked upload says no length, and a self-hosted
 * server has no platform cap, so the whole body was held before anything
 * could say no.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const MiB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

function streamed(path: string, userId: string, stream: ReadableStream<Uint8Array>, contentType: string): Request {
  return new Request(`https://app.test/api/tenancy/${path}`, {
    method: "POST",
    headers: { "content-type": contentType, "sec-fetch-site": "same-origin", "x-test-user": userId },
    body: stream,
    duplex: "half",
  } as RequestInit);
}

async function owner() {
  h = await harness();
  const a = await h.user("a@a.test", { name: "Alice Owner" });
  const A = await h.company(a, "Alpha Roofing");
  return { a, A, ...handlersFor(h) };
}

describe("the logo upload reads at most its cap (review SEC-01)", () => {
  it("a 64 MiB chunked upload is refused once the cap is passed, the stream cancelled, nothing stored", async () => {
    const { a, A, company } = await owner();
    const { stream, state } = countingStream(64, MiB);
    const res = await company.handle(streamed(`v1/companies/${A}/logo`, a, stream, "multipart/form-data; boundary=----x"));
    expect(res.status).toBe(422);
    expect((await jsonOf<{ error: { code: string; message: string } }>(res)).error).toMatchObject({
      code: "logo_invalid",
      message: "Use a PNG, JPG or WebP image under 1 MB.",
    });
    // The cap is 1.2 MiB: the second 1 MiB chunk passes it.
    expect(LOGO_BODY_MAX_BYTES).toBeLessThan(2 * MiB);
    expect(state.pulled).toBe(2 * MiB);
    expect(state.cancelled).toBe(true);
    expect(h.logos.puts).toEqual([]);
  });

  it("a declared length over the cap is refused before a byte is read; a real logo still uploads", async () => {
    const { a, A, company } = await owner();
    const { stream, state } = countingStream(4, MiB);
    const req = new Request(`https://app.test/api/tenancy/v1/companies/${A}/logo`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----x", "content-length": String(4 * MiB), "sec-fetch-site": "same-origin", "x-test-user": a },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await company.handle(req)).status).toBe(422);
    expect(state.pulled).toBe(0);
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "logo.png");
    const ok = await company.handle(
      new Request(`https://app.test/api/tenancy/v1/companies/${A}/logo`, { method: "POST", body: form, headers: { "x-test-user": a, "sec-fetch-site": "same-origin" } }),
    );
    expect(ok.status).toBe(200);
    expect(h.logos.puts).toHaveLength(1);
    // Not a form at all: the same sentence as before.
    const junk = await call(company, a, "POST", `v1/companies/${A}/logo`, { not: "a form" });
    expect(junk.status).toBe(400);
    expect((await jsonOf<{ error: { message: string } }>(junk)).error.message).toBe("Send the logo as a file upload.");
  });
});

describe("a JSON route reads at most 16 KB (review SEC-01)", () => {
  it("a chunked profile update over the cap: refused after the first chunk, the stream cancelled", async () => {
    const { a, A, company } = await owner();
    const { stream, state } = countingStream(64, 64 * 1024);
    const res = await company.handle(streamed(`v1/companies/${A}/profile`, a, stream, "application/json"));
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: { code: string; message: string } }>(res)).error).toMatchObject({ code: "invalid", message: "That request is too large." });
    expect(JSON_BODY_MAX_BYTES).toBeLessThan(64 * 1024);
    expect(state.pulled).toBe(64 * 1024);
    expect(state.cancelled).toBe(true);
  });
});
