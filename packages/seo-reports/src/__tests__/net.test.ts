import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetcher, isBlockedAddress, nodeTransport } from "../net.js";
import { fakeNetwork } from "./fake-network.js";

/**
 * THE CRAWLER NEVER FETCHES WHAT IT MUSTN'T (SSRF, 0.2): private and metadata
 * addresses (v4 and v6) are refused on a fake resolver's answer, a redirect
 * to a host that isn't the company's is refused rather than followed, and a
 * body over the cap is cut — and with node's real transport, against a local
 * server, the byte cap and the address pinning are proven too.
 */

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
    "ff02::1",
    // Review L3: anything outside global unicast, the IPv4-carrying forms included.
    "::ffff:8.8.8.8",
    "::ffff:0:7f00:1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:808:808",
    "64:ff9b::808:808",
    "3fff::1",
    "100::1",
    "not-an-ip",
  ])("refuses %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("createSafeFetcher", () => {
  it("refuses a company address whose name resolves to a private IP, without connecting", async () => {
    const net = fakeNetwork({ "https://greenacres.com/": { body: "hi" } }, { "greenacres.com": ["10.0.0.5"] });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    const page = await fetcher.fetch("https://greenacres.com/");
    expect(page.refused).toBe("private_address");
    expect(net.requests).toEqual([]);
  });

  it("refuses a name with one public and one private answer", async () => {
    const net = fakeNetwork({}, { "greenacres.com": ["93.184.216.34", "::1"] });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    expect((await fetcher.fetch("https://greenacres.com/")).refused).toBe("private_address");
    expect(net.requests).toEqual([]);
  });

  it("refuses a redirect to a host that isn't the company's, and doesn't follow it", async () => {
    const net = fakeNetwork({
      "https://greenacres.com/old": { status: 301, headers: { location: "https://evil.example/steal" } },
      "https://evil.example/steal": { body: "never read" },
    });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    const page = await fetcher.fetch("https://greenacres.com/old");
    expect(page.refused).toBe("foreign_host");
    expect(page.refusedUrl).toBe("https://evil.example/steal");
    expect(net.requests.map((r) => r.url)).toEqual(["https://greenacres.com/old"]);
  });

  it("re-checks every hop's address: a redirect to the company's own name that points inside is refused", async () => {
    const net = fakeNetwork(
      { "https://greenacres.com/": { status: 302, headers: { location: "https://shop.greenacres.com/" } } },
      { "shop.greenacres.com": ["169.254.169.254"] },
    );
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com", "shop.greenacres.com"], resolve: net.resolve, transport: net.transport });
    expect((await fetcher.fetch("https://greenacres.com/")).refused).toBe("private_address");
    expect(net.requests).toHaveLength(1);
  });

  it("refuses a redirect to a private IP typed as the address", async () => {
    const net = fakeNetwork({ "https://greenacres.com/": { status: 302, headers: { location: "http://127.0.0.1/admin" } } });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    expect((await fetcher.fetch("https://greenacres.com/")).refused).toBe("private_address");
  });

  it("follows a redirect between the company's own addresses (www and bare)", async () => {
    const net = fakeNetwork({
      "https://greenacres.com/": { status: 301, headers: { location: "https://www.greenacres.com/" } },
      "https://www.greenacres.com/": { body: "<html>ok</html>" },
    });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    const page = await fetcher.fetch("https://greenacres.com/");
    expect(page.status).toBe(200);
    expect(page.finalUrl).toBe("https://www.greenacres.com/");
  });

  it("refuses other schemes, other ports, user:password@, private IP literals and inside-only names", async () => {
    const net = fakeNetwork({});
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com", "localhost", "metadata.google.internal"], resolve: net.resolve, transport: net.transport });
    expect((await fetcher.fetch("ftp://greenacres.com/")).refused).toBe("scheme");
    expect((await fetcher.fetch("file:///etc/passwd")).refused).toBe("scheme");
    expect((await fetcher.fetch("https://greenacres.com:8443/")).refused).toBe("port");
    expect((await fetcher.fetch("http://greenacres.com:22/")).refused).toBe("port");
    expect((await fetcher.fetch("https://me:pw@greenacres.com/")).refused).toBe("credentials");
    expect((await fetcher.fetch("http://169.254.169.254/latest/meta-data/")).refused).toBe("private_address");
    expect((await fetcher.fetch("http://[::1]/")).refused).toBe("private_address");
    expect((await fetcher.fetch("http://localhost/")).refused).toBe("private_address");
    expect((await fetcher.fetch("http://metadata.google.internal/")).refused).toBe("private_address");
    expect((await fetcher.fetch("https://other.example/")).refused).toBe("foreign_host");
    expect(net.requests).toEqual([]);
  });

  it("stops after five redirects", async () => {
    const pages: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 8; i += 1) pages[`https://greenacres.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const net = fakeNetwork(pages);
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport });
    expect((await fetcher.fetch("https://greenacres.com/0")).refused).toBe("too_many_redirects");
    expect(net.requests).toHaveLength(6);
  });

  it("cuts an oversized body at the cap and says so", async () => {
    const net = fakeNetwork({ "https://greenacres.com/big": { body: "x".repeat(5_000) } });
    const fetcher = createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport, maxBytes: 1_000 });
    const page = await fetcher.fetch("https://greenacres.com/big");
    expect(page.truncated).toBe(true);
    expect(page.bytes).toBe(1_000);
  });

  it("gives up on a page that doesn't answer in time", async () => {
    const fetcher = createSafeFetcher({
      allowedHosts: ["greenacres.com"],
      resolve: async () => ["93.184.216.34"],
      transport: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      timeoutMs: 30,
    });
    const page = await fetcher.fetch("https://greenacres.com/slow");
    expect(page.status).toBe(0);
    expect(page.error).toMatch(/timed out/);
  });

  it("on a host the company shares, reads only its own pages, and refuses a redirect out of them (review L1)", async () => {
    const net = fakeNetwork({
      "https://app.example/t/green-acres/old": { status: 302, headers: { location: "/admin" } },
      "https://app.example/admin": { body: "the operator console" },
      "https://app.example/t/green-acres": { body: "<html>ok</html>" },
    });
    const own = (url: URL) => url.pathname === "/t/green-acres" || url.pathname.startsWith("/t/green-acres/");
    const fetcher = createSafeFetcher({ allowedHosts: ["app.example"], allowUrl: own, resolve: net.resolve, transport: net.transport });
    const moved = await fetcher.fetch("https://app.example/t/green-acres/old");
    expect(moved.refused).toBe("outside_pages");
    expect(moved.refusedUrl).toBe("https://app.example/admin");
    expect((await fetcher.fetch("https://app.example/t/summit")).refused).toBe("outside_pages");
    expect((await fetcher.fetch("https://app.example/t/green-acres")).status).toBe(200);
    expect(net.requests.map((r) => r.url)).toEqual(["https://app.example/t/green-acres/old", "https://app.example/t/green-acres"]);
  });

  it("gives up on a name lookup that doesn't answer in time (review L2)", async () => {
    const fetcher = createSafeFetcher({
      allowedHosts: ["greenacres.com"],
      resolve: () => new Promise(() => undefined),
      transport: async () => ({ status: 200, headers: {}, body: new Uint8Array(0), truncated: false }),
      resolveTimeoutMs: 20,
    });
    expect((await fetcher.fetch("https://greenacres.com/")).refused).toBe("no_address");
  });

  it("sends its own User-Agent", async () => {
    const net = fakeNetwork({ "https://greenacres.com/": { body: "ok" } });
    await createSafeFetcher({ allowedHosts: ["greenacres.com"], resolve: net.resolve, transport: net.transport }).fetch("https://greenacres.com/");
    expect(net.requests[0]?.userAgent).toMatch(/^AdminIgloo-SearchCheck\//);
  });
});

describe("nodeTransport (the real one, against a local server)", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("y".repeat(300_000));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", "x-host-seen": req.headers.host ?? "" });
      res.end("hello");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("connects to the CHECKED address, never re-resolving the name (no rebinding)", async () => {
    // The name exists nowhere: only the pinned address reaches the server.
    const res = await nodeTransport({ url: new URL(`http://pinned.invalid:${port}/`), address: "127.0.0.1", headers: {}, signal: new AbortController().signal, maxBytes: 1000 });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("hello");
    expect(res.headers["x-host-seen"]).toBe(`pinned.invalid:${port}`);
  });

  it("stops reading a body at maxBytes", async () => {
    const res = await nodeTransport({ url: new URL(`http://pinned.invalid:${port}/big`), address: "127.0.0.1", headers: {}, signal: new AbortController().signal, maxBytes: 10_000 });
    expect(res.truncated).toBe(true);
    expect(res.body.byteLength).toBe(10_000);
  });
});
