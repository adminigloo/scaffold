import { describe, expect, it, vi } from "vitest";
import { indexNowKeyFile, INDEXNOW_ENDPOINT, isIndexNowKey, SeoError, submitUrls } from "../index.js";
import { site, staging } from "./fixtures.js";

const KEY = "4f1c2b7e9d8a4c3b8e6f5a4d3c2b1a09";

type Call = { url: string; init: RequestInit; body: { host: string; key: string; keyLocation?: string; urlList: string[] } };

function fakeFetch(statuses: Array<number | Error> = []) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const next = statuses[calls.length - 1] ?? 200;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("the key file", () => {
  it("is /{key}.txt holding the key", () => {
    expect(indexNowKeyFile(KEY)).toEqual({ path: `/${KEY}.txt`, body: KEY, contentType: "text/plain; charset=utf-8" });
  });

  it("refuses a key the protocol does not accept", () => {
    expect(isIndexNowKey("short")).toBe(false);
    expect(isIndexNowKey("has spaces in it")).toBe(false);
    expect(isIndexNowKey("a".repeat(129))).toBe(false);
    expect(() => indexNowKeyFile("../etc")).toThrow(SeoError);
  });
});

describe("submitUrls", () => {
  it("POSTs JSON to the shared endpoint: host, key and absolute URLs", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await submitUrls(site, ["/templates/bridal", "https://riddlergo.com/pricing?utm_source=x"], { key: KEY, fetch });
    expect(result).toEqual({ ok: true, submitted: 2, batches: [{ count: 2, status: 200, ok: true }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(INDEXNOW_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(calls[0]!.body).toEqual({ host: "riddlergo.com", key: KEY, urlList: ["https://riddlergo.com/templates/bridal", "https://riddlergo.com/pricing"] });
  });

  it("batches at 10,000 URLs (the protocol's limit), de-duplicated", async () => {
    const { fetch, calls } = fakeFetch();
    const urls = Array.from({ length: 25_001 }, (_, i) => `/templates/${i}`);
    const result = await submitUrls(site, [...urls, "/templates/0", "/templates/1/"], { key: KEY, fetch });
    expect(calls.map((c) => c.body.urlList.length)).toEqual([10_000, 10_000, 5_001]);
    expect(result.submitted).toBe(25_001);
    expect(calls[2]!.body.urlList.at(-1)).toBe("https://riddlergo.com/templates/25000");
  });

  it("honours a smaller batch size and a key location", async () => {
    const { fetch, calls } = fakeFetch();
    await submitUrls(site, ["/templates/a", "/templates/b", "/templates/c"], { key: KEY, fetch, batchSize: 2, keyLocation: "/templates/indexnow.txt", endpoint: "https://www.bing.com/indexnow" });
    expect(calls.map((c) => [c.url, c.body.urlList.length, c.body.keyLocation])).toEqual([
      ["https://www.bing.com/indexnow", 2, "https://riddlergo.com/templates/indexnow.txt"],
      ["https://www.bing.com/indexnow", 1, "https://riddlergo.com/templates/indexnow.txt"],
    ]);
  });

  it("sends nothing off production", async () => {
    const { fetch, calls } = fakeFetch();
    expect(await submitUrls(staging, ["/a"], { key: KEY, fetch })).toEqual({ ok: true, submitted: 0, skipped: "not-indexable", batches: [] });
    expect(calls).toHaveLength(0);
  });

  it("sends nothing for an empty list", async () => {
    const { fetch, calls } = fakeFetch();
    expect((await submitUrls(site, [], { key: KEY, fetch })).skipped).toBe("no-urls");
    expect(calls).toHaveLength(0);
  });

  it("reports each batch's answer without throwing: 202 accepted, 403/422/429 refused, network errors", async () => {
    const { fetch } = fakeFetch([202, 403, 422, 429, new Error("ECONNRESET")]);
    const result = await submitUrls(site, ["/a", "/b", "/c", "/d", "/e1"], { key: KEY, fetch, batchSize: 1 });
    expect(result.ok).toBe(false);
    expect(result.submitted).toBe(1);
    expect(result.batches.map((b) => [b.status, b.ok, b.error?.split(":")[0]])).toEqual([
      [202, true, undefined],
      [403, false, "forbidden"],
      [422, false, "unprocessable"],
      [429, false, "too many requests"],
      [null, false, "request failed"],
    ]);
  });

  it("aborts a request that takes too long", async () => {
    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    ) as unknown as typeof fetch;
    const result = await submitUrls(site, ["/a"], { key: KEY, fetch: slow, timeoutMs: 20 });
    expect(result.batches).toEqual([{ count: 1, status: null, ok: false, error: "timed out" }]);
  });

  it("throws for a bad key, a bad batch size, or a URL on another host", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(submitUrls(site, ["/a"], { key: "nope", fetch })).rejects.toThrow(/key must be/);
    await expect(submitUrls(site, ["/a"], { key: KEY, fetch, batchSize: 10_001 })).rejects.toThrow(/batchSize/);
    await expect(submitUrls(site, ["https://evil.example.com/x"], { key: KEY, fetch })).rejects.toThrow(/not a page on https:\/\/riddlergo.com/);
    expect(calls).toHaveLength(0);
  });
});

describe("the path list decides what may be announced", () => {
  it("throws for a URL under a private path, before anything is sent", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(submitUrls(site, ["/templates/a", "/admin/secret"], { key: KEY, fetch })).rejects.toThrow(
      /https:\/\/riddlergo.com\/admin\/secret is under a private path/,
    );
    await expect(submitUrls(site, ["/invite/abc123"], { key: KEY, fetch })).rejects.toThrow(/private path/);
    expect(calls).toHaveLength(0);
  });

  it("leaves a noindex URL out and says so", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await submitUrls(site, ["/templates/a", "/sign-in", "/sign-up/verify"], { key: KEY, fetch });
    expect(calls[0]!.body.urlList).toEqual(["https://riddlergo.com/templates/a"]);
    expect(result).toEqual({
      ok: true,
      submitted: 1,
      excluded: ["https://riddlergo.com/sign-in", "https://riddlergo.com/sign-up/verify"],
      batches: [{ count: 1, status: 200, ok: true }],
    });
    expect(await submitUrls(site, ["/sign-in"], { key: KEY, fetch })).toEqual({
      ok: true,
      submitted: 0,
      skipped: "no-urls",
      excluded: ["https://riddlergo.com/sign-in"],
      batches: [],
    });
  });
});

describe("keyLocation", () => {
  it("must be on the site's own origin", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(submitUrls(site, ["/templates/a"], { key: KEY, fetch, keyLocation: "https://cdn.example.com/key.txt" })).rejects.toThrow(
      /keyLocation https:\/\/cdn.example.com\/key.txt is not on https:\/\/riddlergo.com/,
    );
    expect(calls).toHaveLength(0);
  });

  it("bounds the URLs to its own folder, as the protocol does (no 422 from the engine)", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(submitUrls(site, ["/templates/a", "/pricing"], { key: KEY, fetch, keyLocation: "/templates/key.txt" })).rejects.toThrow(
      /https:\/\/riddlergo.com\/pricing is outside https:\/\/riddlergo.com\/templates\//,
    );
    expect(calls).toHaveLength(0);
    await submitUrls(site, ["/pricing"], { key: KEY, fetch, keyLocation: `/${KEY}.txt` });
    expect(calls).toHaveLength(1);
  });
});
