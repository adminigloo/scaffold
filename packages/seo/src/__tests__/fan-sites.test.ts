import { describe, expect, it } from "vitest";
import {
  creativeWork,
  creativeWorkId,
  defineSite,
  graph,
  llmsFullTxt,
  llmsTxt,
  organization,
  ref,
  SeoError,
  siteMetadata,
  unresolvedRefs,
  webPage,
  webSite,
  type LlmsRegistry,
} from "../index.js";

/**
 * 0.4, from Hinderstap (a fan site about The Wheel of Time and Dungeon Crawler
 * Carl): the disclaimer a site about somebody else's work has to carry, the
 * engines' ownership tokens, the summary kept above a page's body in
 * llms-full.txt, and creativeWork() for the books a page is about.
 */

const fan = defineSite({
  url: "https://hinderstap.com",
  name: "Hinderstap",
  description: "Fantasy taverns where AI keepers gossip about the books.",
  indexable: true,
  disclaimer: "An unofficial fan site; not affiliated with the authors or publishers.",
});

const registry: LlmsRegistry = {
  summary: "Taverns in the worlds of The Wheel of Time and Dungeon Crawler Carl.",
  sections: [
    {
      title: "Guides",
      items: [
        { title: "What is Hinderstap?", path: "/hinderstap", summary: "The village in The Gathering Storm.", body: "Mat Cauthon dices at the Tipsy Gelding." },
        { title: "Books in order", path: "/books", summary: "Every book in order.", body: "Every book in order. The Eye of the World comes first." },
      ],
    },
  ],
};

describe("the disclaimer (defineSite, 0.4)", () => {
  it("is one line under the summary in both llms files", () => {
    for (const doc of [llmsTxt(fan, registry), llmsFullTxt(fan, registry)]) {
      expect(doc.text).toContain(
        "> Taverns in the worlds of The Wheel of Time and Dungeon Crawler Carl.\n\nAn unofficial fan site; not affiliated with the authors or publishers.\n\n",
      );
    }
  });

  it("is absent from a site without one, and folded to one line", () => {
    const plain = defineSite({ url: "https://example.com", name: "Example", indexable: true });
    expect(plain.disclaimer).toBeUndefined();
    expect(llmsTxt(plain, registry).text).not.toContain("not affiliated");
    const folded = defineSite({ url: "https://example.com", name: "Example", indexable: true, disclaimer: "Unofficial.\n  Not affiliated." });
    expect(folded.disclaimer).toBe("Unofficial. Not affiliated.");
  });
});

describe("site verification (defineSite, 0.4)", () => {
  it("writes each engine's token as Next's verification metadata, Bing's as msvalidate.01", () => {
    const site = defineSite({
      url: "https://hinderstap.com",
      name: "Hinderstap",
      indexable: true,
      verification: { google: "abcDEF123_-xyz789", bing: "0123456789ABCDEF0123456789ABCDEF", yandex: "1234abcd5678efgh" },
    });
    expect(siteMetadata(site).verification).toEqual({
      google: "abcDEF123_-xyz789",
      yandex: "1234abcd5678efgh",
      other: { "msvalidate.01": "0123456789ABCDEF0123456789ABCDEF" },
    });
  });

  it("takes a pasted DNS value, and skips empty or missing tokens", () => {
    const site = defineSite({
      url: "https://hinderstap.com",
      name: "Hinderstap",
      indexable: true,
      verification: { google: " google-site-verification=abcDEF123_-xyz789 ", bing: "", yandex: null },
    });
    expect(site.verification).toEqual({ google: "abcDEF123_-xyz789" });
    expect(siteMetadata(site).verification).toEqual({ google: "abcDEF123_-xyz789" });
    const none = defineSite({ url: "https://hinderstap.com", name: "Hinderstap", indexable: true, verification: { google: undefined } });
    expect(none.verification).toBeUndefined();
    expect(siteMetadata(none)).not.toHaveProperty("verification");
  });

  it("refuses a whole meta tag where the token belongs", () => {
    expect(() =>
      defineSite({ url: "https://hinderstap.com", name: "Hinderstap", indexable: true, verification: { google: '<meta name="google-site-verification" content="abc" />' } }),
    ).toThrow(SeoError);
  });
});

describe("llms-full.txt keeps the summary above a body (0.4)", () => {
  it("writes the summary as a standfirst, unless the body already opens with it", () => {
    const text = llmsFullTxt(fan, registry).text;
    expect(text).toContain("The village in The Gathering Storm.\n\nMat Cauthon dices at the Tipsy Gelding.");
    expect(text).toContain("Every book in order. The Eye of the World comes first.");
    expect(text).not.toContain("Every book in order.\n\nEvery book in order.");
  });

  it("still gives way to the summary alone when the budget is tight", () => {
    const doc = llmsFullTxt(fan, registry, { maxBytes: 450 });
    expect(doc.text).not.toContain("Mat Cauthon dices");
    expect(Buffer.byteLength(doc.text)).toBeLessThanOrEqual(450);
  });
});

describe("creativeWork (0.4)", () => {
  const series = creativeWork(fan, {
    type: "BookSeries",
    key: "the-wheel-of-time",
    name: "The Wheel of Time",
    authors: ["Robert Jordan", "Brandon Sanderson"],
    sameAs: ["https://en.wikipedia.org/wiki/The_Wheel_of_Time"],
  });

  it("makes a series and its books, linked by isPartOf and position", () => {
    expect(series["@id"]).toBe("https://hinderstap.com/#work-the-wheel-of-time");
    expect(series["@id"]).toBe(creativeWorkId(fan, "the-wheel-of-time"));
    const book = creativeWork(fan, {
      type: "Book",
      name: "The Eye of the World",
      authors: ["Robert Jordan"],
      datePublished: "1990-01-15",
      isPartOf: series,
      position: 1,
    });
    expect(book).toMatchObject({
      "@type": "Book",
      "@id": "https://hinderstap.com/#work-the-eye-of-the-world",
      author: [{ "@type": "Person", name: "Robert Jordan" }],
      datePublished: "1990-01-15",
      isPartOf: { "@id": "https://hinderstap.com/#work-the-wheel-of-time" },
      position: 1,
    });
  });

  it("takes a year or a month when the sources give no day, and refuses a month that isn't one", () => {
    expect(creativeWork(fan, { type: "Book", name: "The Eye of the Bedlam Bride", datePublished: "2023" }).datePublished).toBe("2023");
    expect(creativeWork(fan, { type: "Book", name: "This Inevitable Ruin", datePublished: "2024-11" }).datePublished).toBe("2024-11");
    expect(() => creativeWork(fan, { type: "Book", name: "Bad", datePublished: "2024-13" })).toThrow(/not a real month/);
  });

  it("checks what only makes sense together", () => {
    expect(() => creativeWork(fan, { type: "Book", name: "Lonely", position: 2 })).toThrow(/position needs isPartOf/);
    expect(() => creativeWork(fan, { type: "Movie", name: "Film", isbn: "9780312850098" })).toThrow(/isbn is for a Book/);
    expect(() => creativeWork(fan, { type: "Book", name: "Short", isbn: "12345" })).toThrow(/10 or 13 digits/);
    expect(creativeWork(fan, { type: "Book", name: "Real", isbn: "978-0-312-85009-8" }).isbn).toBe("9780312850098");
    expect(() => creativeWork(fan, { type: "Comic" as never, name: "Nope" })).toThrow(SeoError);
    expect(() => creativeWork(fan, { type: "Book", name: "Here", sameAs: ["https://hinderstap.com/books"] })).toThrow(/sameAs/);
  });

  it("writes creator for the screen, author for everything else, and a publisher as an Organization", () => {
    const show = creativeWork(fan, { type: "TVSeries", name: "The Wheel of Time", key: "wot-show", authors: ["Rafe Judkins"] });
    expect(show.creator).toEqual([{ "@type": "Person", name: "Rafe Judkins" }]);
    expect(show).not.toHaveProperty("author");
    const book = creativeWork(fan, { type: "Book", name: "Dungeon Crawler Carl", publisher: "Ace" });
    expect(book.publisher).toEqual({ "@type": "Organization", name: "Ace" });
  });

  it("hangs off its own page when it has one, and a page can say it is about the work", () => {
    const onPage = creativeWork(fan, { type: "BookSeries", name: "Dungeon Crawler Carl", path: "/dungeon-crawler-carl/books" });
    expect(onPage["@id"]).toBe("https://hinderstap.com/dungeon-crawler-carl/books#work");
    expect(onPage.url).toBe("https://hinderstap.com/dungeon-crawler-carl/books");
    const page = webPage(fan, { path: "/wheel-of-time/books", name: "The Wheel of Time books in order", about: ref(series) });
    expect(unresolvedRefs(graph(organization(fan), webSite(fan), page, series))).toEqual([]);
  });
});
