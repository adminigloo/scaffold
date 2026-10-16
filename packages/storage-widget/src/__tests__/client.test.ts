// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createFilesClient } from "../client.js";

/**
 * The transport (section 7): one call per route at the right address and
 * method, uploads as ONE multipart part named `file`, progress through
 * XMLHttpRequest when asked for, and never a throw: a 401 is "signed out",
 * an HTML page or a strange shape is `bad_response`, a dead network is
 * `network`.
 */

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(answer: (url: string, method: string) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    seen.push({ url: input, method: init.method ?? "GET", body: init.body });
    const a = answer(input, init.method ?? "GET");
    const payload = a.text ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    return new Response(payload, { status: a.status ?? 200, headers: a.headers ?? { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const FILE = {
  id: "f1",
  name: "porch.jpg",
  contentType: "image/jpeg",
  kind: "photo",
  sizeBytes: 10,
  width: 1,
  height: 1,
  purpose: "attachment",
  purposeLabel: "Photo or file",
  record: null,
  addedBy: null,
  at: "2026-10-15T12:00:00.000Z",
  url: "/x/content",
  canRemove: true,
  canLink: false,
};
const USAGE = { usedBytes: 10, fileCount: 1, allowanceBytes: null };
const RULES = { available: true, offReason: null, maxBytes: 4194304, accept: ["image/jpeg"], rule: "Photos" };

describe("createFilesClient", () => {
  it("calls every route at its address and method", async () => {
    const f = fakeFetch((url, method) => {
      if (method === "POST" && !url.includes("/link") && !url.includes("/remove")) return { body: { file: FILE, usage: USAGE } };
      if (url.includes("/usage")) return { body: USAGE };
      if (url.includes("/link")) return { body: { url: "https://app.test/api/files/v1/f/tok", expiresAt: "2026-10-15T13:00:00.000Z" } };
      if (url.includes("/remove")) return { body: { removed: true, usage: USAGE } };
      if (url.includes("/attachments")) {
        return { body: { record: { type: "scheduling.visit", label: "Visit", href: null }, files: [FILE], canAdd: true, uploads: RULES } };
      }
      if (url.endsWith("/v1/admin/files") || url.includes("/v1/admin/files?")) return { body: { files: [FILE], nextCursor: null, usage: USAGE, uploads: RULES, canUpload: true, purposes: [], recordTypes: [] } };
      return { body: { file: FILE, usage: USAGE } };
    });
    const client = createFilesClient({ baseUrl: "/api/app/c1/files/", fetch: f.fetch });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    expect((await client.usage()).ok).toBe(true);
    expect((await client.files({ record: "scheduling.visit", sort: "size", cursor: "abc" })).ok).toBe(true);
    expect((await client.files({ record: "none", purpose: "company.logo" })).ok).toBe(true);
    expect((await client.upload(blob, "porch.jpg")).ok).toBe(true);
    expect((await client.file("a/b")).ok).toBe(true);
    expect((await client.link("f1")).ok).toBe(true);
    expect((await client.remove("f1")).ok).toBe(true);
    expect((await client.attachments({ type: "scheduling.visit", id: "v 1" })).ok).toBe(true);
    expect((await client.attach({ type: "scheduling.visit", id: "v1" }, blob, "porch.jpg")).ok).toBe(true);
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/app/c1/files/v1/admin/usage",
      "GET /api/app/c1/files/v1/admin/files?record=scheduling.visit&sort=size&cursor=abc",
      "GET /api/app/c1/files/v1/admin/files?purpose=company.logo&record=none",
      "POST /api/app/c1/files/v1/admin/files",
      "GET /api/app/c1/files/v1/admin/files/a%2Fb",
      "POST /api/app/c1/files/v1/admin/files/f1/link",
      "POST /api/app/c1/files/v1/admin/files/f1/remove",
      "GET /api/app/c1/files/v1/admin/attachments?record=scheduling.visit&id=v+1",
      "POST /api/app/c1/files/v1/admin/attachments?record=scheduling.visit&id=v1",
    ]);
    expect(client.contentUrl("f 1")).toBe("/api/app/c1/files/v1/admin/files/f%201/content");
  });

  it("an upload is exactly one multipart part, a file named `file`", async () => {
    const f = fakeFetch(() => ({ body: { file: FILE, usage: null } }));
    const client = createFilesClient({ baseUrl: "/files", fetch: f.fetch });
    await client.upload(new Blob([new Uint8Array([1])], { type: "image/jpeg" }), "porch.jpg");
    const form = f.seen[0]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const entries: [string, FormDataEntryValue][] = [];
    form.forEach((value, name) => entries.push([name, value]));
    expect(entries.map(([name]) => name)).toEqual(["file"]);
    expect((entries[0]?.[1] as File).name).toBe("porch.jpg");
  });

  it("parses what it is given and drops what doesn't fit", async () => {
    const f = fakeFetch(() => ({ body: { files: [FILE, { nope: true }, { ...FILE, id: "f2", kind: "weird", canRemove: "yes" }], usage: USAGE, uploads: RULES } }));
    const res = await createFilesClient({ baseUrl: "/x", fetch: f.fetch }).files();
    expect(res.ok && res.data.files.map((x) => [x.id, x.kind, x.canRemove])).toEqual([
      ["f1", "photo", true],
      ["f2", "document", false],
    ]);
  });

  it("never throws: 401, a storage refusal, HTML, a dead network", async () => {
    const answers: Record<string, { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }> = {
      "/a/v1/admin/usage": { status: 401, text: "Sign in" },
      "/b/v1/admin/usage": { status: 409, body: { error: { code: "storage_full", message: "Your storage is full." } } },
      "/c/v1/admin/usage": { status: 200, text: "<html>login</html>", headers: { "content-type": "text/html" } },
      "/d/v1/admin/usage": { status: 413, text: "Request Entity Too Large" },
    };
    const f = fakeFetch((url) => answers[url] ?? { status: 500, text: "" });
    const at = (base: string) => createFilesClient({ baseUrl: base, fetch: f.fetch });
    expect(await at("/a").usage()).toEqual({ ok: false, error: { code: "forbidden", message: "You've been signed out. Sign in again to keep working.", status: 401 } });
    expect(await at("/b").usage()).toEqual({ ok: false, error: { code: "storage_full", message: "Your storage is full.", status: 409 } });
    expect((await at("/c").usage()).ok === false && (await at("/c").usage() as { error: { code: string } }).error.code).toBe("bad_response");
    expect(((await at("/d").usage()) as { error: { code: string } }).error.code).toBe("file_too_big");
    const dead = createFilesClient({
      baseUrl: "/x",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    expect(await dead.usage()).toEqual({ ok: false, error: { code: "network", message: "Couldn't connect. Check your connection and try again.", status: 0 } });
    expect((await dead.upload(new Blob([]), "x")).ok).toBe(false);
  });
});

describe("upload progress through XMLHttpRequest", () => {
  const original = globalThis.XMLHttpRequest;
  afterEach(() => {
    globalThis.XMLHttpRequest = original;
  });

  function fakeXhr(status: number, body: string) {
    const sent: { method: string; url: string; body: unknown }[] = [];
    class FakeXhr {
      status = 0;
      responseText = "";
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private method = "";
      private url = "";
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader() {}
      getResponseHeader() {
        return "application/json";
      }
      send(payload: unknown) {
        sent.push({ method: this.method, url: this.url, body: payload });
        setTimeout(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
          this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
          if (status === 0) {
            this.onerror?.();
            return;
          }
          this.status = status;
          this.responseText = body;
          this.onload?.();
        }, 0);
      }
    }
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    return sent;
  }

  it("reports progress and answers the same Result as fetch", async () => {
    const sent = fakeXhr(201, JSON.stringify({ file: FILE, usage: null }));
    const progress: number[] = [];
    const res = await createFilesClient({ baseUrl: "/files" }).attach({ type: "scheduling.visit", id: "v1" }, new Blob([new Uint8Array([1])]), "a.jpg", (p) => progress.push(p));
    expect(res.ok).toBe(true);
    expect(progress).toEqual([0.5, 1]);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.url).toBe("/files/v1/admin/attachments?record=scheduling.visit&id=v1");
    expect(sent[0]?.body).toBeInstanceOf(FormData);
  });

  it("a refusal and a dead network through XHR are values too", async () => {
    fakeXhr(413, JSON.stringify({ error: { code: "file_too_big", message: "That file is too big. Files can be up to 4 MB." } }));
    const refused = await createFilesClient({ baseUrl: "/files" }).attach({ type: "t.x", id: "1" }, new Blob([]), "a.jpg", () => undefined);
    expect(refused).toEqual({ ok: false, error: { code: "file_too_big", message: "That file is too big. Files can be up to 4 MB.", status: 413 } });
    fakeXhr(0, "");
    const dead = await createFilesClient({ baseUrl: "/files" }).attach({ type: "t.x", id: "1" }, new Blob([]), "a.jpg", () => undefined);
    expect(dead.ok === false && dead.error.code).toBe("network");
  });
});
