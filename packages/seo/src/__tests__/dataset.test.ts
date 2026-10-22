import type { Metadata } from "next";
import { describe, expect, it } from "vitest";
import { dataset, graph, organizationId, pageMetadata, SeoError, unresolvedRefs, webPage } from "../index.js";
import { site } from "./fixtures.js";

const DESCRIPTION =
  "The official daily high temperature at Central Park (KNYC) from the National Weather Service's final climate report, one row per day.";

function issuesOf(build: () => unknown): string[] {
  try {
    build();
  } catch (error) {
    if (error instanceof SeoError) return [...error.issues];
    throw error;
  }
  return [];
}

describe("dataset (0.3): a table a page publishes", () => {
  it("writes a Dataset with its CSV as a DataDownload, the variables, the coverage, and who made it inline", () => {
    const node = dataset(site, {
      path: "/weather/rules/nyc",
      name: "NYC official daily highs",
      description: DESCRIPTION,
      keywords: ["Kalshi", "NYC high temperature"],
      variables: ["Official high (°F)", { name: "Time of high", description: "Local standard time" }],
      temporalCoverage: "2026-08-14/..",
      spatialCoverage: { name: "Central Park, New York", geo: { latitude: 40.78, longitude: -73.97 } },
      csv: "/weather/rules/nyc/highs.csv",
      license: "/terms",
      isAccessibleForFree: true,
      isBasedOn: ["https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC"],
      dateModified: "2026-10-20T13:05:00Z",
    });
    expect(node).toEqual({
      "@type": "Dataset",
      "@id": "https://riddlergo.com/weather/rules/nyc#dataset",
      name: "NYC official daily highs",
      description: DESCRIPTION,
      url: "https://riddlergo.com/weather/rules/nyc",
      keywords: "Kalshi, NYC high temperature",
      variableMeasured: ["Official high (°F)", { "@type": "PropertyValue", name: "Time of high", description: "Local standard time" }],
      temporalCoverage: "2026-08-14/..",
      spatialCoverage: { "@type": "Place", name: "Central Park, New York", geo: { "@type": "GeoCoordinates", latitude: 40.78, longitude: -73.97 } },
      distribution: [{ "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: "https://riddlergo.com/weather/rules/nyc/highs.csv" }],
      creator: { "@type": "Organization", "@id": organizationId(site), name: "Riddler Go", url: "https://riddlergo.com/" },
      publisher: { "@type": "Organization", "@id": organizationId(site), name: "Riddler Go", url: "https://riddlergo.com/" },
      license: "https://riddlergo.com/terms",
      isAccessibleForFree: true,
      isBasedOn: ["https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC"],
      dateModified: "2026-10-20T13:05:00Z",
      inLanguage: "en-US",
    });
  });

  it("defaults nothing that is a fact about the business, and reads alone on its page", () => {
    const node = dataset(site, { path: "/d", name: "D", description: DESCRIPTION });
    expect(node).not.toHaveProperty("isAccessibleForFree");
    expect(node).not.toHaveProperty("license");
    expect(unresolvedRefs(graph(webPage(site, { path: "/d", name: "D" }), node))).toEqual(["https://riddlergo.com/#website"]);
  });

  it("checks what Google's Dataset result needs, and richResult: false describes it anyway", () => {
    expect(issuesOf(() => dataset(site, { path: "/d", name: "", description: "short" }))).toEqual([
      expect.stringContaining("description must be 50 to 5,000 characters"),
      "name is required",
    ]);
    expect(issuesOf(() => dataset(site, { path: "/d", name: "D", description: "short", richResult: false }))).toEqual([]);
    expect(issuesOf(() => dataset(site, { path: "/d", name: "D", description: DESCRIPTION, distribution: [{ contentUrl: "/x.csv", encodingFormat: "csv" }] }))).toEqual([
      expect.stringContaining("must be a MIME type"),
    ]);
    expect(issuesOf(() => dataset(site, { path: "/d", name: "D", description: DESCRIPTION, temporalCoverage: "last month" }))).toEqual([
      expect.stringContaining("must be ISO 8601"),
    ]);
    expect(issuesOf(() => dataset(site, { path: "/d", name: "D", description: DESCRIPTION, datePublished: "2026-10-02", dateModified: "2026-10-01" }))).toEqual([
      "dateModified is before datePublished",
    ]);
  });
});

describe("pageMetadata({ ownImage: true }) (0.3)", () => {
  it("writes no image list, so the route's own opengraph-image is the one Next names", () => {
    const meta = pageMetadata(site, { path: "/weather/nyc", title: "NYC", description: "d", ownImage: true });
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
    expect(meta.twitter.card).toBe("summary_large_image");
    expect(meta.alternates.canonical).toBe("https://riddlergo.com/weather/nyc");
    const asNext: Metadata = meta;
    expect(asNext.title).toEqual({ absolute: "NYC | Riddler Go" });
  });

  it("refuses an image beside it", () => {
    expect(() => pageMetadata(site, { path: "/x", title: "X", ownImage: true, image: "/x.png" })).toThrow(/ownImage and image/);
  });

  it("changes nothing without it", () => {
    expect(pageMetadata(site, { path: "/x", title: "X" }).openGraph.images.length).toBeGreaterThanOrEqual(0);
  });
});
