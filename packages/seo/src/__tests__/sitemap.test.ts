import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSitemaps,
  pathEntries,
  SeoError,
  SITEMAP_MAX_URLS,
  sitemapEntries,
  sitemapIndexXml,
  sitemapXml,
  splitSitemap,
  toNextSitemap,
  type SitemapEntry,
} from "../index.js";
import { site, staging } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("lastModified: real dates from data, never now", () => {
  it("writes the date the data carries, and no <lastmod> at all when it is unknown, whatever time it is", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:34:56Z"));
    const entries = sitemapEntries(site, pathEntries(site));
    const xml = sitemapXml(entries);
    expect(entries.find((e) => e.url === "https://riddlergo.com/")?.lastModified).toBe("2026-10-01");
    expect(entries.find((e) => e.url === "https://riddlergo.com/pricing")?.lastModified).toBe("2026-09-20T12:00:00.000Z");
    expect(entries.find((e) => e.url === "https://riddlergo.com/how-it-works")).not.toHaveProperty("lastModified");
    expect(xml).not.toContain("2026-10-09");
    expect(xml.match(/<lastmod>/g)).toHaveLength(2);
  });

  it("requires the key, so a caller cannot forget it (null says unknown)", () => {
    expect(() => sitemapEntries(site, [{ url: "/x" } as never])).toThrow(/lastModified is required/);
    expect(sitemapEntries(site, [{ url: "/x", lastModified: null }])).toEqual([{ url: "https://riddlergo.com/x" }]);
  });

  it("refuses a date that is not one, or one in the future", () => {
    const now = new Date("2026-10-09T00:00:00Z");
    expect(() => sitemapEntries(site, [{ url: "/x", lastModified: "yesterday" }], { now })).toThrow(/not a date/);
    expect(() => sitemapEntries(site, [{ url: "/x", lastModified: "2027-01-01" }], { now })).toThrow(/in the future/);
    expect(sitemapEntries(site, [{ url: "/x", lastModified: "2026-10-09T20:00:00Z" }], { now })[0]?.lastModified).toBe("2026-10-09T20:00:00Z");
  });

  it("accepts Date, epoch milliseconds and ISO strings", () => {
    const out = sitemapEntries(site, [
      { url: "/a", lastModified: new Date("2026-01-02T03:04:05Z") },
      { url: "/b", lastModified: Date.UTC(2026, 0, 2) },
      { url: "/c", lastModified: "2026-01-02T03:04:05+02:00" },
    ]);
    expect(out.map((e) => e.lastModified)).toEqual(["2026-01-02T03:04:05.000Z", "2026-01-02T00:00:00.000Z", "2026-01-02T03:04:05+02:00"]);
  });
});

describe("entries: absolute, own origin, de-duplicated", () => {
  it("resolves paths, drops campaign parameters, keeps the newest date for a URL listed twice", () => {
    const out = sitemapEntries(site, [
      { url: "/templates/bridal?utm_source=x", lastModified: "2026-01-01" },
      { url: "https://riddlergo.com/templates/bridal", lastModified: "2026-03-01" },
      { url: "/templates/bridal/", lastModified: "2026-02-01" },
    ]);
    expect(out).toEqual([{ url: "https://riddlergo.com/templates/bridal", lastModified: "2026-03-01" }]);
  });

  it("refuses a URL on another host (www, staging) unless told to skip and report", () => {
    expect(() => sitemapEntries(site, [{ url: "https://www.riddlergo.com/x", lastModified: null }])).toThrow(SeoError);
    const report = vi.fn();
    const out = sitemapEntries(
      site,
      [
        { url: "https://staging.riddlergo.com/x", lastModified: null },
        { url: "/ok", lastModified: null },
      ],
      { onInvalid: report },
    );
    expect(out).toEqual([{ url: "https://riddlergo.com/ok" }]);
    expect(report).toHaveBeenCalledWith({ url: "https://staging.riddlergo.com/x", issues: [expect.stringContaining("is not on https://riddlergo.com")] });
  });

  it("is empty off production", () => {
    expect(sitemapEntries(staging, pathEntries(staging))).toEqual([]);
  });
});

describe("the path list decides, for rows from a database too", () => {
  it("never lists a URL under a private or noindex path: it throws, or skips and reports with onInvalid", () => {
    for (const url of ["/admin/x", "/e/CODE", "/invite/abc?x=1", "https://riddlergo.com/event-builder", "/sign-in", "/sign-up/verify"]) {
      expect(() => sitemapEntries(site, [{ url, lastModified: null }])).toThrow(/path in the site's path list, so it cannot be in the sitemap/);
    }
    const report = vi.fn();
    const out = sitemapEntries(
      site,
      [
        { url: "/elm-street-church/spring-hunt", lastModified: "2026-09-01" },
        { url: "/e/CODE", lastModified: null },
        { url: "/sign-in", lastModified: null },
      ],
      { onInvalid: report },
    );
    expect(out).toEqual([{ url: "https://riddlergo.com/elm-street-church/spring-hunt", lastModified: "2026-09-01" }]);
    expect(report.mock.calls.map(([call]) => [call.url, call.issues[0]])).toEqual([
      ["/e/CODE", "is under a private path in the site's path list, so it cannot be in the sitemap"],
      ["/sign-in", "is under a noindex path in the site's path list, so it cannot be in the sitemap"],
    ]);
  });
});

describe("dates mean the same moment on every server", () => {
  it("refuses a date-time with no time zone (new Date() would read it in the server's zone)", () => {
    expect(() => sitemapEntries(site, [{ url: "/x", lastModified: "2026-10-01T19:00" }], { now: new Date("2026-10-09T00:00:00Z") })).toThrow(
      /lastModified has no time zone \(2026-10-01T19:00\)/,
    );
  });

  it("refuses a calendar date that does not exist, which Date.parse would roll into March", () => {
    expect(() => sitemapEntries(site, [{ url: "/x", lastModified: "2026-02-30" }])).toThrow(/not a real calendar date \(2026-02-30\)/);
    expect(() => sitemapEntries(site, [{ url: "/x", lastModified: "2026-02-29T10:00:00Z" }])).toThrow(/not a real calendar date/);
    expect(sitemapEntries(site, [{ url: "/x", lastModified: "2024-02-29" }])[0]?.lastModified).toBe("2024-02-29");
  });

  it("keeps an offset as written, and reads Postgres' timestamptz text", () => {
    const now = new Date("2026-10-09T00:00:00Z");
    expect(sitemapEntries(site, [{ url: "/a", lastModified: "2026-10-01 19:00:00+00" }], { now })[0]?.lastModified).toBe("2026-10-01T19:00:00+00:00");
    expect(sitemapEntries(site, [{ url: "/b", lastModified: "2026-10-01T19:00:00.123-0600" }], { now })[0]?.lastModified).toBe("2026-10-01T19:00:00.123-06:00");
  });
});

describe("XML", () => {
  it("writes priority as a plain decimal, never in exponent notation", () => {
    const xml = sitemapXml(
      sitemapEntries(site, [
        { url: "/a", lastModified: null, priority: 1e-7 },
        { url: "/b", lastModified: null, priority: 0.85 },
        { url: "/c", lastModified: null, priority: 1 },
      ]),
    );
    expect(xml.match(/<priority>[^<]*<\/priority>/g)).toEqual(["<priority>0.0</priority>", "<priority>0.85</priority>", "<priority>1.0</priority>"]);
    expect(toNextSitemap(sitemapEntries(site, [{ url: "/a", lastModified: null, priority: 1e-7 }]))[0]?.priority).toBe(0);
  });

  it("writes images, language alternates and escapes &", () => {
    const [entry] = sitemapEntries(site, [
      {
        url: "/templates?type=a&b=c",
        lastModified: "2026-10-01",
        changeFrequency: "weekly",
        priority: 0.7,
        images: ["/img/hero.png", "https://cdn.example.com/a.jpg?x=1&y=2"],
        alternates: { languages: { en: "/templates?type=a&b=c", es: "/es/templates" } },
      },
    ]);
    expect(sitemapXml([entry!])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        "<url>\n<loc>https://riddlergo.com/templates?type=a&amp;b=c</loc>\n" +
        '<xhtml:link rel="alternate" hreflang="en" href="https://riddlergo.com/templates?type=a&amp;b=c"/>\n' +
        '<xhtml:link rel="alternate" hreflang="es" href="https://riddlergo.com/es/templates"/>\n' +
        "<lastmod>2026-10-01</lastmod>\n<changefreq>weekly</changefreq>\n<priority>0.7</priority>\n" +
        "<image:image>\n<image:loc>https://riddlergo.com/img/hero.png</image:loc>\n</image:image>\n" +
        "<image:image>\n<image:loc>https://cdn.example.com/a.jpg?x=1&amp;y=2</image:loc>\n</image:image>\n" +
        "</url>\n</urlset>\n",
    );
  });

  it("allows a language alternate on another domain (a country site), as page metadata does", () => {
    const [entry] = sitemapEntries(site, [{ url: "/", lastModified: null, alternates: { languages: { "en-US": "/", "es-MX": "https://riddlergo.mx/" } } }]);
    expect(entry!.alternates).toEqual({ languages: { "en-US": "https://riddlergo.com/", "es-MX": "https://riddlergo.mx/" } });
  });

  it("gives Next's app/sitemap.ts the array shape", () => {
    const next = toNextSitemap(sitemapEntries(site, [{ url: "/a", lastModified: "2026-10-01", images: ["/i.png"] }]));
    expect(next).toEqual([{ url: "https://riddlergo.com/a", lastModified: "2026-10-01", images: ["https://riddlergo.com/i.png"] }]);
  });

  it("writes a sitemap index", () => {
    expect(sitemapIndexXml([{ url: "https://riddlergo.com/sitemaps/0.xml", lastModified: "2026-10-01" }, { url: "https://riddlergo.com/sitemaps/1.xml" }])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "<sitemap>\n<loc>https://riddlergo.com/sitemaps/0.xml</loc>\n<lastmod>2026-10-01</lastmod>\n</sitemap>\n" +
        "<sitemap>\n<loc>https://riddlergo.com/sitemaps/1.xml</loc>\n</sitemap>\n</sitemapindex>\n",
    );
  });
});

function many(n: number, start = 0): SitemapEntry[] {
  return Array.from({ length: n }, (_, i) => ({ url: `https://riddlergo.com/templates/${start + i}`, lastModified: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` }));
}

describe("splitting past the protocol's limits", () => {
  it("keeps 50,000 URLs in one file and splits the 50,001st into a second, under an index", () => {
    expect(splitSitemap(many(SITEMAP_MAX_URLS))).toHaveLength(1);
    const set = buildSitemaps(site, many(SITEMAP_MAX_URLS + 1));
    expect(set.files.map((f) => [f.path, (f.xml.match(/<url>/g) ?? []).length])).toEqual([
      ["/sitemap-0.xml", 50_000],
      ["/sitemap-1.xml", 1],
    ]);
    expect(set.index).toContain("<loc>https://riddlergo.com/sitemap-0.xml</loc>");
    expect(set.index).toContain("<loc>https://riddlergo.com/sitemap-1.xml</loc>");
    expect(set.root).toBe(set.index);
  });

  it("splits by bytes too, never over the limit, keeping order", () => {
    const entries = many(40);
    const maxBytes = 2_000;
    const chunks = splitSitemap(entries, { maxBytes });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(entries);
    for (const chunk of chunks) expect(new TextEncoder().encode(sitemapXml(chunk)).length).toBeLessThanOrEqual(maxBytes);
  });

  it("dates each file in the index by its newest entry", () => {
    const entries: SitemapEntry[] = [
      { url: "https://riddlergo.com/a", lastModified: "2026-01-05" },
      { url: "https://riddlergo.com/b", lastModified: "2026-03-01T00:00:00.000Z" },
      { url: "https://riddlergo.com/c" },
      { url: "https://riddlergo.com/d" },
    ];
    const set = buildSitemaps(site, entries, { maxUrls: 2, filePath: (id) => `/sitemap-${id}.xml` });
    expect(set.files.map((f) => [f.url, f.lastModified])).toEqual([
      ["https://riddlergo.com/sitemap-0.xml", "2026-03-01T00:00:00.000Z"],
      ["https://riddlergo.com/sitemap-1.xml", undefined],
    ]);
  });

  it("is one file and no index when everything fits, and an empty urlset when there is nothing", () => {
    const set = buildSitemaps(site, many(3));
    expect(set.index).toBeNull();
    expect(set.root).toBe(set.files[0]!.xml);
    expect(buildSitemaps(site, []).root).toContain("<urlset");
  });
});
