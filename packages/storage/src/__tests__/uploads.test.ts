import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MULTIPART_OVERHEAD_BYTES, readBodyCapped } from "../body.js";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../instance.js";
import type { FileResponse, WireErrorBody } from "../wire.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { buildWorld, handlersFor, Members, OWNER_PERMISSIONS, readJson, request, upload, assertNoPrivateKeyLeaked } from "./world.js";

/**
 * Uploads (D11, review G10): the body is counted as it streams and the read
 * stops at the cap, with or without a Content-Length, so a self-hosted
 * server can't be made to hold a 10 MB (or 10 GB) body in memory; and an
 * upload is exactly one part, a file named `file`.
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

const CHUNK = 64 * 1024;
const CAP = DEFAULT_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

/** A chunked multipart body of `total` bytes, generated on demand, counting how much was ever pulled from it. */
function endlessUpload(total: number) {
  const boundary = "----aig-test-boundary";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.png"\r\nContent-Type: image/png\r\n\r\n`,
  );
  let sent = 0;
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const chunk = sent === 0 ? head : new Uint8Array(Math.min(CHUNK, total - sent));
      sent += chunk.byteLength;
      stats.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
    // No read-ahead: a chunk is made only when someone reads, so 'pulled' is exactly what was read.
  }, { highWaterMark: 0 });
  return { stream, stats, contentType: `multipart/form-data; boundary=${boundary}` };
}

function setup() {
  const w = buildWorld(t);
  const members = new Members();
  const a = tenant();
  members.set(a, "owner", OWNER_PERMISSIONS);
  return { w, h: handlersFor(w, members), a };
}

describe("the counting upload stream", () => {
  it("a chunked 10 MB body with no Content-Length → 413, and no more than the cap is read", async () => {
    const { w, h, a } = setup();
    const body = endlessUpload(10 * 1024 * 1024);
    const req = request(a, "owner", "v1/admin/files", { method: "POST", body: body.stream, headers: { "content-type": body.contentType }, duplex: true });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await h.handle(req);
    expect(res.status).toBe(413);
    expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "file_too_big", message: "That file is too big. Files can be up to 4 MB." });
    // The high-water mark: the read stopped at the cap (one chunk of
    // read-ahead aside), nowhere near the 10 MB on offer.
    expect(body.stats.pulled).toBeLessThanOrEqual(CAP + 2 * CHUNK);
    expect(body.stats.pulled).toBeGreaterThan(CAP);
    expect(body.stats.cancelled).toBe(true);
    expect((await w.storage.list({ tenantId: a })).files).toEqual([]);
    expect(w.priv.calls.put).toBe(0);
  });

  it("a declared Content-Length over the cap → 413 before a byte is read", async () => {
    const { h, a } = setup();
    const body = endlessUpload(10 * 1024 * 1024);
    const req = request(a, "owner", "v1/admin/files", {
      method: "POST",
      body: body.stream,
      headers: { "content-type": body.contentType, "content-length": String(10 * 1024 * 1024) },
      duplex: true,
    });
    const res = await h.handle(req);
    expect(res.status).toBe(413);
    expect(body.stats.pulled).toBe(0);
  });

  it("readBodyCapped answers what it read, under the cap", async () => {
    const req = new Request("https://app.test/x", { method: "POST", body: new Uint8Array(1000) });
    const read = await readBodyCapped(req, 2000, 2000);
    expect([read.read, read.bytes.length]).toEqual([1000, 1000]);
    await expect(readBodyCapped(new Request("https://app.test/x", { method: "POST", body: new Uint8Array(3000) }), 2000, 2000)).rejects.toThrow(/too big/);
  });
});

describe("exactly one part, a file named `file`", () => {
  it("one file part → 201", async () => {
    const { h, a } = setup();
    const res = await h.handle(upload(a, "owner", "v1/admin/files", PNG, { filename: "sign.png" }));
    expect(res.status).toBe(201);
    expect((await readJson<FileResponse>(res)).file.name).toBe("sign.png");
  });

  it("two file parts, a part not named file, or an extra field → 400 'Send one file at a time.'", async () => {
    const { w, h, a } = setup();
    const cases = [
      upload(a, "owner", "v1/admin/files", PNG, { extra: [["file", new Blob([PNG as BlobPart], { type: "image/png" })]] }),
      upload(a, "owner", "v1/admin/files", PNG, { field: "photo" }),
      upload(a, "owner", "v1/admin/files", PNG, { extra: [["note", "hello"]] }),
    ];
    for (const req of cases) {
      const res = await h.handle(req);
      expect(res.status).toBe(400);
      expect((await readJson<WireErrorBody>(res)).error).toEqual({ code: "invalid", message: "Send one file at a time." });
    }
    // A text field named `file` is not a file either.
    const form = new FormData();
    form.append("file", "not a file");
    expect((await h.handle(request(a, "owner", "v1/admin/files", { method: "POST", body: form }))).status).toBe(400);
    expect(w.priv.calls.put).toBe(0);
  });

  it("not a form upload at all → 400", async () => {
    const { h, a } = setup();
    const res = await h.handle(request(a, "owner", "v1/admin/files", { method: "POST", json: { file: "x" } }));
    expect(res.status).toBe(400);
  });

  it("the parsed file's own size and type are checked again by store", async () => {
    const { h, a } = setup();
    const svg = await h.handle(upload(a, "owner", "v1/admin/files", new TextEncoder().encode("<svg/>"), { filename: "logo.svg", type: "image/svg+xml" }));
    expect(svg.status).toBe(415);
    expect((await readJson<WireErrorBody>(svg)).error.code).toBe("file_type");
  });
});
