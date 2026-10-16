import { describe, expect, it } from "vitest";
import { createStorage } from "../instance.js";
import { createS3CompatibleStore } from "../s3.js";

/**
 * checkPrivate on Cloudflare R2 (reviews FH-8 and SEC-05). R2's S3 endpoint
 * (`<account>.r2.cloudflarestorage.com`) answers EVERY unsigned request
 * `400 InvalidArgument (Authorization)`, public bucket or not: a bucket is
 * readable by anyone only at its r2.dev address or a custom domain. So the
 * endpoint's refusal proves nothing about public access, and a 400 isn't an
 * "I couldn't check" alarm either.
 */

const R2_ANONYMOUS = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>`;

function fakeR2(publicAddress: { status: number } | "unreachable" | null) {
  const objects = new Map<string, Uint8Array>();
  const unsigned: string[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const signed = new Headers(init.headers).has("authorization");
    if (u.host === "acct.r2.cloudflarestorage.com") {
      if (!signed) {
        unsigned.push(url);
        return new Response(R2_ANONYMOUS, { status: 400, headers: { "content-type": "application/xml" } });
      }
      if (init.method === "PUT") {
        objects.set(u.pathname, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
        return new Response("", { status: 200 });
      }
      if (init.method === "DELETE") {
        objects.delete(u.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 404 });
    }
    unsigned.push(url);
    if (publicAddress === "unreachable" || publicAddress === null) throw new TypeError("fetch failed");
    return new Response(publicAddress.status === 200 ? "adminigloo private check" : "", { status: publicAddress.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, objects, unsigned };
}

const base = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "photos-private", accessKeyId: "AKIA", secretAccessKey: "secret", access: "private" as const };

describe("checkPrivate on R2 (reviews FH-8, SEC-05)", () => {
  it("the S3 endpoint's 400 InvalidArgument is a refusal, not 'couldn't check'; without the public address, it says plainly what wasn't checked", async () => {
    const r2 = fakeR2(null);
    const store = createS3CompatibleStore({ ...base, fetch: r2.fetch });
    const check = await store.checkPrivate?.();
    expect(check?.ok).toBe(true);
    expect(check?.reason).toBeNull();
    expect(check?.note).toMatch(/r2\.dev address, or at a custom domain/);
    expect(check?.note).toMatch(/can't be checked from here/);
    expect(r2.objects.size).toBe(0);
  });

  it("with the bucket's public address given: public access switched ON is caught", async () => {
    const r2 = fakeR2({ status: 200 });
    const store = createS3CompatibleStore({ ...base, fetch: r2.fetch, publicUrlToCheck: "https://pub-0123abcd.r2.dev" });
    const check = await store.checkPrivate?.();
    expect(check?.ok).toBe(false);
    expect(check?.reason).toBe("Anyone can read the private bucket's files at https://pub-0123abcd.r2.dev. In Cloudflare, switch off the bucket's r2.dev address and remove any custom domain from it.");
    expect(r2.unsigned.some((url) => url.startsWith("https://pub-0123abcd.r2.dev/t/0000000000000000/"))).toBe(true);
    expect(r2.objects.size).toBe(0);
  });

  it("with the public address given and switched off (401, 404, or not reachable): ok, with nothing left unchecked", async () => {
    for (const answer of [{ status: 401 }, { status: 404 }, { status: 403 }, "unreachable" as const]) {
      const r2 = fakeR2(answer);
      const check = await createS3CompatibleStore({ ...base, fetch: r2.fetch, publicUrlToCheck: "https://files.greenacres.test/" }).checkPrivate?.();
      expect(check, JSON.stringify(answer)).toEqual({ ok: true, reason: null });
    }
  });

  it("a 401 from an endpoint is a refusal too; an answer that is neither is still 'couldn't check'", async () => {
    const answers = [401, 400, 500];
    const results: unknown[] = [];
    for (const status of answers) {
      const fetch = (async (url: string, init: RequestInit = {}) => {
        if (!new Headers(init.headers).has("authorization")) return new Response(status === 400 ? "<Error><Code>BadRequest</Code></Error>" : "", { status });
        return new Response("", { status: init.method === "DELETE" ? 204 : 200 });
      }) as unknown as typeof globalThis.fetch;
      results.push(await createS3CompatibleStore({ ...base, endpoint: "https://s3.example.test", fetch }).checkPrivate?.());
    }
    expect(results).toEqual([
      { ok: true, reason: null },
      { ok: false, reason: "Couldn't check the private bucket (it answered 400)." },
      { ok: false, reason: "Couldn't check the private bucket (it answered 500)." },
    ]);
  });

  it("checkPrivateStore passes the note on, for /setup to show", async () => {
    const r2 = fakeR2(null);
    const storage = createStorage({
      db: {} as never,
      tables: { files: {} } as never,
      stores: { private: createS3CompatibleStore({ ...base, fetch: r2.fetch }) },
      urls: { content: () => "/c", publicBase: "https://app.test/api/files" },
    });
    const check = await storage.checkPrivateStore();
    expect(check.ok).toBe(true);
    expect(check.note).toMatch(/r2\.dev/);
  });
});
