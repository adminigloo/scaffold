import { describe, expect, it } from "vitest";
import { isPublicAddress, parseIpv6, privateHostReason } from "../address.js";
import { BusySourceError, createIcsBusySource, normalizeIcsUrl, type CreateIcsBusySourceOptions } from "../busy-source.js";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:x",
  "DTSTART:20261005T160000Z",
  "DTEND:20261005T170000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const HOST = { id: "h1", timezone: "America/Denver", busyIcsUrl: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" };
const RANGE = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-06T00:00:00Z") };

/** Every name resolves to a public address unless a test says otherwise — no real DNS in tests. */
const publicDns = async () => ["142.250.80.46"];

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits.push(init);
    return respond(url, init);
  }) as typeof fetch;
  return { impl, calls, inits };
}

function source(options: CreateIcsBusySourceOptions = {}) {
  return createIcsBusySource({ resolveHost: publicDns, ...options });
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe("normalizeIcsUrl", () => {
  it("turns webcal into https and refuses everything else that is not https", () => {
    expect(normalizeIcsUrl("webcal://p01-calendars.icloud.com/x.ics").protocol).toBe("https:");
    expect(() => normalizeIcsUrl("http://calendar.example.com/x.ics")).toThrow(BusySourceError);
    expect(() => normalizeIcsUrl("file:///etc/passwd")).toThrow(BusySourceError);
    expect(() => normalizeIcsUrl("not a url")).toThrow(BusySourceError);
    expect(() => normalizeIcsUrl("https://user:secret@calendar.example.com/x.ics")).toThrow(/username or password/);
  });

  it("refuses private and loopback hosts in every spelling", () => {
    for (const url of [
      "https://localhost/x.ics",
      "https://LOCALHOST/x.ics",
      "https://localhost./x.ics", // trailing dot: the same name
      "https://cal.localhost/x.ics",
      "https://127.0.0.1/x.ics",
      "https://127.0.0.1./x.ics",
      "https://2130706433/x.ics", // 127.0.0.1 as one number
      "https://0x7f.1/x.ics", // …in hex, short form
      "https://127.1/x.ics",
      "https://0.0.0.0/x.ics",
      "https://10.0.0.5/x.ics",
      "https://192.168.1.10/x.ics",
      "https://169.254.169.254/latest/meta-data",
      "https://172.20.0.1/x.ics",
      "https://100.64.0.1/x.ics", // CGNAT
      "https://100.100.100.200/latest/meta-data", // Alibaba Cloud metadata
      "https://[::1]/x.ics",
      "https://[0:0:0:0:0:0:0:1]/x.ics",
      "https://[::]/x.ics", // unspecified
      "https://[::ffff:127.0.0.1]/x.ics", // IPv4-mapped
      "https://[::ffff:a9fe:a9fe]/x.ics", // IPv4-mapped 169.254.169.254
      "https://[::127.0.0.1]/x.ics", // IPv4-compatible
      "https://[64:ff9b::7f00:1]/x.ics", // NAT64 of 127.0.0.1
      "https://[2002:7f00:1::]/x.ics", // 6to4 of 127.0.0.1
      "https://[fd12:3456::1]/x.ics", // ULA
      "https://[fe80::1]/x.ics", // link-local
      "https://[2001:db8::1]/x.ics", // documentation
      "https://printer.local/x.ics",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://metadata/x.ics", // single label: completed by DNS search domains
      "https://router.home.arpa/x.ics",
    ]) {
      expect(() => normalizeIcsUrl(url), url).toThrow(BusySourceError);
    }
  });

  it("negative control: public hosts and the edges of each private range pass", () => {
    for (const url of [
      "https://calendar.google.com/calendar/ical/x/private-y/basic.ics",
      "https://calendar.google.com./x.ics",
      "https://172.32.0.1/x.ics",
      "https://100.63.255.255/x.ics",
      "https://100.128.0.1/x.ics",
      "https://8.8.8.8/x.ics",
      "https://[2606:4700:4700::1111]/x.ics",
      "https://[64:ff9b::808:808]/x.ics", // NAT64 of 8.8.8.8
    ]) {
      expect(() => normalizeIcsUrl(url), url).not.toThrow();
    }
  });
});

describe("address classification", () => {
  it("parses every IPv6 spelling into the same groups", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("[0:0:0:0:0:0:0:1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual(parseIpv6("::ffff:7f00:1"));
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("12345::")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
  });

  it("judges resolved addresses: only the public internet is public", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "100.100.100.200", "169.254.169.254", "::1", "::", "::ffff:10.0.0.1", "fd00::5", "fe80::1", "garbage", ""]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["8.8.8.8", "142.250.80.46", "2607:f8b0:4004:800::200e", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("privateHostReason strips the trailing dot before judging a name", () => {
    expect(privateHostReason("localhost.")).toMatch(/private/);
    expect(privateHostReason("example.com.")).toBeNull();
    expect(privateHostReason("")).toMatch(/no host/);
  });
});

describe("createIcsBusySource", () => {
  it("returns no busy time for a host without a calendar address — without fetching", async () => {
    const { impl, calls } = fakeFetch(() => new Response(FEED));
    expect(await source({ fetchImpl: impl }).busy({ host: { ...HOST, busyIcsUrl: null }, ...RANGE })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("fetches, parses and expands the feed — with redirects never left to fetch", async () => {
    const { impl, inits } = fakeFetch(() => new Response(FEED, { headers: { "content-type": "text/calendar" } }));
    const busy = await source({ fetchImpl: impl }).busy({ host: HOST, ...RANGE });
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ["2026-10-05T16:00:00.000Z", "2026-10-05T17:00:00.000Z"],
    ]);
    expect(inits[0]?.redirect).toBe("manual");
  });

  it("caches per URL for the TTL, and shares one in-flight fetch", async () => {
    let clock = 0;
    const { impl, calls } = fakeFetch(() => new Response(FEED));
    const cached = source({ fetchImpl: impl, ttlMs: 1000, now: () => clock });
    await Promise.all([cached.busy({ host: HOST, ...RANGE }), cached.busy({ host: HOST, ...RANGE })]);
    expect(calls).toHaveLength(1);
    clock = 999;
    await cached.busy({ host: HOST, ...RANGE });
    expect(calls).toHaveLength(1);
    clock = 1001;
    await cached.busy({ host: HOST, ...RANGE });
    expect(calls).toHaveLength(2);
    await cached.busy({ host: { ...HOST, busyIcsUrl: "https://other.example.com/cal.ics" }, ...RANGE });
    expect(calls).toHaveLength(3);
  });

  it("THROWS on a failing fetch, a non-calendar body, an oversize body and a timeout", async () => {
    const notOk = source({ fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })).impl });
    await expect(notOk.busy({ host: HOST, ...RANGE })).rejects.toThrow(/HTTP 404/);

    const html = source({ fetchImpl: fakeFetch(() => new Response("<html>Sign in</html>")).impl });
    await expect(html.busy({ host: HOST, ...RANGE })).rejects.toThrow(/could not be read/);

    const huge = source({ fetchImpl: fakeFetch(() => new Response(FEED)).impl, maxBytes: 10 });
    await expect(huge.busy({ host: HOST, ...RANGE })).rejects.toThrow(/larger than/);

    const network = source({
      fetchImpl: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND");
      }) as typeof fetch,
    });
    await expect(network.busy({ host: HOST, ...RANGE })).rejects.toThrow(/ENOTFOUND/);

    const slow = source({
      timeoutMs: 20,
      fetchImpl: ((_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as typeof fetch,
    });
    await expect(slow.busy({ host: HOST, ...RANGE })).rejects.toThrow(/timed out/);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const { impl, calls } = fakeFetch(() => (fail ? new Response("down", { status: 503 }) : new Response(FEED)));
    const flaky = source({ fetchImpl: impl });
    await expect(flaky.busy({ host: HOST, ...RANGE })).rejects.toThrow();
    fail = false;
    expect(await flaky.busy({ host: HOST, ...RANGE })).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("the busy reader's SSRF fence", () => {
  it("refuses a name that resolves inside — before any fetch — and passes it when it resolves outside (control)", async () => {
    const { impl, calls } = fakeFetch(() => new Response(FEED));
    const inside = createIcsBusySource({ fetchImpl: impl, resolveHost: async () => ["127.0.0.1"] }); // localtest.me does this
    await expect(inside.busy({ host: HOST, ...RANGE })).rejects.toThrow(/private network/);
    expect(calls).toHaveLength(0);

    // One private answer among public ones is enough to refuse.
    const mixed = createIcsBusySource({ fetchImpl: impl, resolveHost: async () => ["142.250.80.46", "::ffff:10.0.0.1"] });
    await expect(mixed.busy({ host: HOST, ...RANGE })).rejects.toThrow(/private network/);
    expect(calls).toHaveLength(0);

    const outside = createIcsBusySource({ fetchImpl: impl, resolveHost: async () => ["142.250.80.46", "2607:f8b0:4004:800::200e"] });
    expect(await outside.busy({ host: HOST, ...RANGE })).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("asks the resolver for the name without its trailing dot, and fails closed when it cannot answer", async () => {
    const asked: string[] = [];
    const { impl, calls } = fakeFetch(() => new Response(FEED));
    const unknown = createIcsBusySource({
      fetchImpl: impl,
      resolveHost: async (name) => {
        asked.push(name);
        throw new Error("ENOTFOUND");
      },
    });
    await expect(unknown.busy({ host: { ...HOST, busyIcsUrl: "https://calendar.google.com./x.ics" }, ...RANGE })).rejects.toThrow(
      /could not be found/,
    );
    expect(asked).toEqual(["calendar.google.com"]);
    const empty = createIcsBusySource({ fetchImpl: impl, resolveHost: async () => [] });
    await expect(empty.busy({ host: HOST, ...RANGE })).rejects.toThrow(/could not be found/);
    expect(calls).toHaveLength(0);
  });

  it("resolveHost: null turns the DNS check off deliberately", async () => {
    const { impl, calls } = fakeFetch(() => new Response(FEED));
    expect(await createIcsBusySource({ fetchImpl: impl, resolveHost: null }).busy({ host: HOST, ...RANGE })).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("re-validates every redirect: a Location pointing inside is refused and never fetched", async () => {
    const { impl, calls } = fakeFetch((url) => (url.includes("google") ? redirect("https://127.0.0.1/admin") : new Response(FEED)));
    await expect(source({ fetchImpl: impl }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/private network/);
    expect(calls).toEqual([HOST.busyIcsUrl]);

    const toMapped = fakeFetch((url) => (url.includes("google") ? redirect("https://[::ffff:a9fe:a9fe]/latest/meta-data", 307) : new Response(FEED)));
    await expect(source({ fetchImpl: toMapped.impl }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/private network/);
    expect(toMapped.calls).toHaveLength(1);

    const toHttp = fakeFetch((url) => (url.includes("google") ? redirect("http://calendar.example.com/x.ics", 301) : new Response(FEED)));
    await expect(source({ fetchImpl: toHttp.impl }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/must be https/);
    expect(toHttp.calls).toHaveLength(1);
  });

  it("re-resolves every redirect target: a public-looking name that resolves inside is refused", async () => {
    const { impl, calls } = fakeFetch((url) => (url.includes("google") ? redirect("https://rebind.example.net/cal.ics") : new Response(FEED)));
    const resolveHost = async (name: string) => (name === "rebind.example.net" ? ["10.0.0.7"] : ["142.250.80.46"]);
    await expect(createIcsBusySource({ fetchImpl: impl, resolveHost }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/private network/);
    expect(calls).toHaveLength(1);
  });

  it("follows up to three good redirects (relative ones too), and no more", async () => {
    let hops = 0;
    const three = fakeFetch(() => {
      hops += 1;
      if (hops === 1) return redirect("https://p01-calendars.icloud.com/a.ics");
      if (hops === 2) return redirect("/b.ics", 308); // relative to the current URL
      if (hops === 3) return redirect("https://calendar.example.org/c.ics", 303);
      return new Response(FEED);
    });
    expect(await source({ fetchImpl: three.impl }).busy({ host: HOST, ...RANGE })).toHaveLength(1);
    expect(three.calls).toEqual([
      HOST.busyIcsUrl,
      "https://p01-calendars.icloud.com/a.ics",
      "https://p01-calendars.icloud.com/b.ics",
      "https://calendar.example.org/c.ics",
    ]);

    const loop = fakeFetch((url) => redirect(`${url}x`));
    await expect(source({ fetchImpl: loop.impl }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/redirected more than 3 times/);
    expect(loop.calls).toHaveLength(4);

    const noLocation = fakeFetch(() => new Response(null, { status: 302 }));
    await expect(source({ fetchImpl: noLocation.impl }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/without a Location/);
  });

  it("streams the body with a running cap: an endless body stops at the cap, not at the end", async () => {
    let pulls = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1024).fill(65));
          },
        }),
      );
    await expect(source({ fetchImpl: fakeFetch(endless).impl, maxBytes: 4096 }).busy({ host: HOST, ...RANGE })).rejects.toThrow(
      /larger than 4096/,
    );
    expect(pulls).toBeLessThanOrEqual(8);

    // A content-length that lies low does not get the rest in.
    const liar = fakeFetch(() => new Response(FEED + "X".repeat(5000), { headers: { "content-length": "10" } }));
    await expect(source({ fetchImpl: liar.impl, maxBytes: 1000 }).busy({ host: HOST, ...RANGE })).rejects.toThrow(/larger than/);
  });

  it("the timeout covers a resolver that never answers", async () => {
    const hung = createIcsBusySource({
      fetchImpl: fakeFetch(() => new Response(FEED)).impl,
      resolveHost: () => new Promise<string[]>(() => undefined),
      timeoutMs: 20,
    });
    await expect(hung.busy({ host: HOST, ...RANGE })).rejects.toThrow(/timed out/);
  });
});
