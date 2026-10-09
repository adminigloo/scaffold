import { describe, expect, it } from "vitest";
import {
  aggregateRatingFrom,
  APPLICATION_CATEGORIES,
  ARTICLE_TYPES,
  article,
  AVAILABILITIES,
  blogPosting,
  breadcrumbId,
  breadcrumbList,
  collectionPage,
  event,
  faqPage,
  graph,
  howTo,
  itemList,
  LOCAL_BUSINESS_TYPES,
  localBusiness,
  ORGANIZATION_TYPES,
  organization,
  organizationId,
  person,
  personId,
  place,
  PLACE_TYPES,
  product,
  ref,
  SeoError,
  SOFTWARE_TYPES,
  softwareApplication,
  speakable,
  touristAttraction,
  WEB_PAGE_TYPES,
  webPage,
  webPageId,
  webSite,
  webSiteId,
  unresolvedRefs,
  type JsonLdNode,
} from "../index.js";
import { site } from "./fixtures.js";

function issuesOf(build: () => unknown): string[] {
  try {
    build();
  } catch (error) {
    if (error instanceof SeoError) return [...error.issues];
    throw error;
  }
  return [];
}

/** Every value of every "@type" key, anywhere in a node. */
function typesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => typesIn(v, out));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "@type") out.push(...(Array.isArray(v) ? v : [v]));
      else typesIn(v, out);
    }
  }
  return out;
}

/** Every `{ "@id": … }` reference (an object with nothing but an @id), anywhere below the top level. */
function refsIn(value: unknown, out: string[] = [], top = true): string[] {
  if (Array.isArray(value)) value.forEach((v) => refsIn(v, out, false));
  else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!top && keys.length === 1 && keys[0] === "@id") out.push((value as { "@id": string })["@id"]);
    for (const v of Object.values(value)) refsIn(v, out, false);
  }
  return out;
}

const KNOWN_SCHEMA_TYPES = new Set<string>([
  ...ORGANIZATION_TYPES,
  ...WEB_PAGE_TYPES,
  ...SOFTWARE_TYPES,
  ...ARTICLE_TYPES,
  ...PLACE_TYPES,
  ...LOCAL_BUSINESS_TYPES,
  "WebSite",
  "SearchAction",
  "EntryPoint",
  "BreadcrumbList",
  "ListItem",
  "ItemList",
  "Product",
  "Brand",
  "Offer",
  "UnitPriceSpecification",
  "QuantitativeValue",
  "OfferShippingDetails",
  "MonetaryAmount",
  "DefinedRegion",
  "ShippingDeliveryTime",
  "MerchantReturnPolicy",
  "AggregateRating",
  "Review",
  "Rating",
  "Person",
  "ImageObject",
  "PostalAddress",
  "ContactPoint",
  "GeoCoordinates",
  "Event",
  "VirtualLocation",
  "HowTo",
  "HowToStep",
  "HowToSupply",
  "HowToTool",
  "FAQPage",
  "Question",
  "Answer",
  "SpeakableSpecification",
  "OpeningHoursSpecification",
]);

// One instance of every builder, used for the snapshot, @type and linking tests.
const nodes: Record<string, JsonLdNode> = {
  organization: organization(site, {
    logo: "/marketing/logos/riddler-go-mark.png",
    description: "Interactive puzzle event platform.",
    sameAs: ["https://www.instagram.com/riddlergo", null, "", "https://www.instagram.com/riddlergo"],
    contactPoints: [{ contactType: "customer support", email: "hello@riddlergo.com" }],
  }),
  webSite: webSite(site, { searchUrlTemplate: "/templates?q={search_term_string}" }),
  webPage: webPage(site, {
    path: "/how-it-works",
    name: "How it works",
    breadcrumb: true,
    dateModified: "2026-09-30",
    speakable: speakable({ cssSelector: ["h1", "[data-speakable]"] }),
  }),
  breadcrumbList: breadcrumbList(site, { path: "/how-it-works", items: [{ name: "Home", path: "/" }, { name: "How it works" }] }),
  collectionPage: collectionPage(site, { path: "/templates", name: "Templates" }),
  itemList: itemList(site, {
    path: "/templates",
    name: "Event templates",
    items: [
      { path: "/templates/bridal-shower", name: "Bridal shower" },
      { path: "/templates/team-building", name: "Team building" },
    ],
  }),
  product: product(site, {
    path: "/pricing",
    id: "plan-pro",
    name: "Riddler Go Pro",
    description: "Unlimited events.",
    brand: ref(organizationId(site)),
    image: "/opengraph-image",
    offers: { price: 29, currency: "USD", billing: "month", availability: "InStock" },
    aggregateRating: { value: 4.8, count: 37 },
    reviews: [{ author: "Rachel", rating: 5, body: "Our guests loved it.", datePublished: "2026-09-01" }],
  }),
  softwareApplication: softwareApplication(site, {
    name: "Riddler Go",
    applicationCategory: "GameApplication",
    operatingSystem: "Web",
    offers: { price: 0, currency: "USD" },
    aggregateRating: { value: 4.6, count: 21 },
  }),
  event: event(site, {
    path: "/riddler/hunt",
    name: "Puzzle Hunt",
    startDate: new Date("2026-08-08T15:00:00Z"),
    endDate: new Date("2026-08-08T17:00:00Z"),
    attendance: "online",
    location: { type: "virtual" },
    organizer: { name: "Riddler", url: "/riddler", type: "Organization" },
  }),
  howTo: howTo(site, {
    path: "/how-it-works",
    name: "How to host a puzzle event",
    totalTime: "PT15M",
    steps: [
      { name: "Build", text: "Add puzzles." },
      { name: "Share", text: "Send the code." },
      { name: "Watch", text: "Follow the leaderboard." },
    ],
  }),
  faqPage: faqPage(site, { path: "/", items: [{ question: "Do guests need an account?", answer: "No. They join with a code." }] }),
  article: article(site, {
    path: "/blog/launch",
    headline: "Riddler Go launches",
    datePublished: "2026-10-01",
    authors: [ref(personId(site, "dallin"))],
    image: "/blog/launch.png",
  }),
  blogPosting: blogPosting(site, { path: "/blog/tips", headline: "Five puzzle tips", datePublished: "2026-10-02", authors: [{ name: "Rachel" }] }),
  person: person(site, { name: "Dallin Humphrey", key: "dallin", jobTitle: "Founder", sameAs: ["https://github.com/dallin-humphrey"] }),
  place: place(site, { name: "Delicate Arch", type: "Landform", geo: { latitude: 38.7436, longitude: -109.4993 } }),
  touristAttraction: touristAttraction(site, {
    path: "/trails/delicate-arch",
    name: "Delicate Arch Trail",
    additionalType: "Landform",
    geo: { latitude: 38.7436, longitude: -109.4993, elevation: { value: 4829, unit: "ft" } },
    address: { addressRegion: "UT", addressCountry: "us" },
    aggregateRating: { value: 4.7, count: 12 },
    tourBookingPage: "/decks/utah",
  }),
  localBusiness: localBusiness(site, {
    type: "HomeAndConstructionBusiness",
    name: "GS Glass",
    address: { streetAddress: "1 Main St", addressLocality: "Provo", addressRegion: "UT", postalCode: "84601", addressCountry: "US" },
    telephone: "+1-801-555-0100",
    openingHours: [{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" }],
    priceRange: "$$",
  }),
};

describe("every builder: snapshot", () => {
  for (const [name, node] of Object.entries(nodes)) {
    it(name, () => {
      expect(node).toMatchSnapshot();
    });
  }
});

describe("every node: real types, stable @id, nothing empty", () => {
  it("uses only real schema.org types, never LandformFeature", () => {
    for (const node of Object.values(nodes)) {
      for (const type of typesIn(node)) expect([type, KNOWN_SCHEMA_TYPES.has(type)]).toEqual([type, true]);
    }
    expect(JSON.stringify(nodes)).not.toContain("LandformFeature");
  });

  it("gives every node an @id on the site's origin, and the same @id for the same input", () => {
    for (const node of Object.values(nodes)) expect(node["@id"]).toMatch(/^https:\/\/riddlergo\.com\/.*#[a-z0-9-]+$/);
    expect(organization(site)["@id"]).toBe(organization(site)["@id"]);
    expect(webPage(site, { path: "/pricing?utm_source=x", name: "P" })["@id"]).toBe(webPageId(site, "/pricing"));
  });

  it("never emits empty values (no `sameAs: []`, no empty strings)", () => {
    const bare = organization(site, { sameAs: [null, "", false] });
    expect(bare).not.toHaveProperty("sameAs");
    for (const node of Object.values(nodes)) {
      const json = JSON.stringify(node);
      expect(json).not.toContain("[]");
      expect(json).not.toContain('""');
      expect(json).not.toContain("{}");
    }
  });

  it("never defaults a business fact: no isAccessibleForFree, availability or country unless given", () => {
    const json = JSON.stringify([
      touristAttraction(site, { path: "/trails/x", name: "X" }),
      product(site, { path: "/p", name: "P", image: "/p.png", offers: { price: 1, currency: "USD" } }),
      localBusiness(site, { address: { addressLocality: "Provo" } }),
    ]);
    expect(json).not.toContain("isAccessibleForFree");
    expect(json).not.toContain("availability");
    expect(json).not.toContain("addressCountry");
  });
});

describe("@id / @graph linking", () => {
  it("links one page's graph: page → site → organization, page → breadcrumb, product → organization", () => {
    const pageGraph = graph(
      nodes.organization,
      nodes.webSite,
      webPage(site, { path: "/pricing", name: "Pricing", breadcrumb: true, mainEntity: ref(nodes.product!) }),
      breadcrumbList(site, { path: "/pricing", items: [{ name: "Home", path: "/" }, { name: "Pricing" }] }),
      nodes.product,
    );
    const ids = new Set(pageGraph["@graph"].map((node) => node["@id"]));
    const refs = refsIn(pageGraph["@graph"]);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    for (const id of refs) expect([id, ids.has(id)]).toEqual([id, true]);
    const page = pageGraph["@graph"][2]!;
    expect(page.isPartOf).toEqual({ "@id": webSiteId(site) });
    expect(page.breadcrumb).toEqual({ "@id": breadcrumbId(site, "/pricing") });
    expect(nodes.webSite!.publisher).toEqual({ "@id": organizationId(site) });
  });

  it("links an article to its page, its author and its publisher", () => {
    const a = nodes.article!;
    expect(a.mainEntityOfPage).toEqual({ "@id": "https://riddlergo.com/blog/launch#webpage" });
    expect(a.author).toEqual([{ "@id": "https://riddlergo.com/#person-dallin" }]);
    expect(a.publisher).toEqual({ "@id": organizationId(site) });
    expect(nodes.person!["@id"]).toBe(personId(site, "dallin"));
  });

  it("gives two Products on one page their own @id, so a pricing page keeps every plan", () => {
    const plans = ["free", "pro", "team"].map((id, i) => product(site, { path: "/pricing", id: `plan-${id}`, name: id, image: "/og.png", offers: { price: i * 10, currency: "USD" } }));
    expect(graph(plans)["@graph"]).toHaveLength(3);
    const twins = [0, 1].map((i) => product(site, { path: "/pricing", name: `p${i}`, image: "/og.png", offers: { price: i, currency: "USD" } }));
    expect(() => graph(twins)).toThrow(/share the @id/);
  });

  it("collectionPage's mainEntity is its ItemList", () => {
    expect(collectionPage(site, { path: "/templates", name: "Templates", list: nodes.itemList! }).mainEntity).toEqual({ "@id": nodes.itemList!["@id"] });
  });
});

describe("required properties are checked, and every problem is listed", () => {
  it("organization", () => {
    expect(issuesOf(() => organization(site, { type: "Thing" as never, email: "nope", sameAs: ["not a url"] }))).toEqual([
      expect.stringContaining('type "Thing"'),
      "email is not an email address",
      expect.stringContaining("sameAs"),
    ]);
  });

  it("webSite search template", () => {
    expect(issuesOf(() => webSite(site, { searchUrlTemplate: "/search?q=" }))).toEqual(["searchUrlTemplate must contain {search_term_string}"]);
  });

  it("webPage and speakable", () => {
    expect(issuesOf(() => webPage(site, { path: "", name: "" }))).toEqual(["path is required", "name is required"]);
    expect(issuesOf(() => speakable({}))).toEqual(["give exactly one of cssSelector or xpath, non-empty"]);
    expect(issuesOf(() => speakable({ cssSelector: ["h1"], xpath: ["/html"] }))).toHaveLength(1);
  });

  it("breadcrumbList", () => {
    expect(issuesOf(() => breadcrumbList(site, { path: "/x", items: [] }))).toEqual(["items must have at least one entry"]);
    expect(issuesOf(() => breadcrumbList(site, { path: "/x", items: [{ name: "Home" }, { name: "X" }] }))).toEqual([
      "items[0].path is required (only the last item may leave it out)",
    ]);
    expect(breadcrumbList(site, { path: "/x", items: [{ name: "Home", path: "/" }, { name: "X" }] }).itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://riddlergo.com/" },
      { "@type": "ListItem", position: 2, name: "X", item: "https://riddlergo.com/x" },
    ]);
  });

  it("product: needs an offer, a rating or reviews; prices in major units; ratings in range", () => {
    expect(issuesOf(() => product(site, { path: "/p", name: "P" }))).toEqual([
      "a Product needs at least one of offers, aggregateRating or rated reviews (or richResult: false, for a plan with no public price)",
    ]);
    expect(
      issuesOf(() =>
        product(site, {
          path: "/p",
          name: "P",
          image: "/p.png",
          offers: { price: -1, currency: "usd dollars" },
          aggregateRating: { value: 7, count: 0 },
          reviews: [{ author: "", rating: 9 }],
        }),
      ),
    ).toEqual([
      'offers.currency must be an ISO 4217 code like "USD"',
      "offers.price must be a number of at least 0, in major units (39.99, not cents)",
      "aggregateRating.value must be between 1 and 5",
      "aggregateRating.count must be a whole number of at least 1",
      "reviews[0].rating must be between 1 and 5",
      "reviews[0].author is required",
    ]);
  });

  it("product: formats the price for the currency and writes shipping and returns", () => {
    const p = product(site, {
      path: "/decks/utah",
      name: "Utah deck",
      image: "/decks/utah.png",
      offers: {
        price: 39.9,
        currency: "usd",
        availability: "InStock",
        shipping: { rate: 5, country: "us", handlingDays: [0, 1], transitDays: [2, 5] },
        returnPolicy: { country: "US", category: "finite", days: 30, method: "mail", fees: "free" },
      },
    });
    expect(p.offers).toMatchObject({
      price: "39.90",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: "https://riddlergo.com/decks/utah",
      shippingDetails: { shippingDestination: { addressCountry: "US" } },
      hasMerchantReturnPolicy: { merchantReturnDays: 30, returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow" },
    });
    expect((product(site, { path: "/y", name: "Yen", image: "/y.png", offers: { price: 1200, currency: "JPY" } }).offers as { price: string }).price).toBe("1200");
    expect(issuesOf(() => product(site, { path: "/p", name: "P", image: "/p.png", offers: { price: "$5", currency: "USD" } }))).toEqual([
      'offers.price must be a plain decimal like "39.99"',
    ]);
    expect(issuesOf(() => product(site, { path: "/p", name: "P", image: "/p.png", offers: { price: 1, currency: "USD", returnPolicy: { country: "US", category: "finite" } } }))).toEqual([
      "offers.returnPolicy.days is required for a finite return window",
    ]);
  });

  it("softwareApplication: a category from Google's list and a price", () => {
    expect(issuesOf(() => softwareApplication(site, { name: "X", applicationCategory: "Game" as never, offers: [] }))).toEqual([
      expect.stringContaining('applicationCategory "Game"'),
      "offers is required (a price, 0 for free), or richResult: false",
      expect.stringContaining("aggregateRating or reviews is required"),
    ]);
    expect(APPLICATION_CATEGORIES).toContain("BusinessApplication");
    expect(nodes.softwareApplication!.offers).toMatchObject({ price: "0.00", priceCurrency: "USD", url: "https://riddlergo.com/" });
  });

  it("event: a start date, end after start, a location matching the attendance mode", () => {
    expect(
      issuesOf(() =>
        event(site, {
          path: "/e1",
          name: "E",
          startDate: "2026-08-08T17:00:00Z",
          endDate: "2026-08-08T15:00:00Z",
          attendance: "offline",
          location: { type: "virtual" },
        }),
      ),
    ).toEqual(["endDate is before startDate", "an offline event needs a place location"]);
    expect(issuesOf(() => event(site, { path: "/e1", name: "E", startDate: null as never, attendance: "online", location: { type: "virtual" } }))).toEqual([
      "startDate is required (an event with no date yet passes richResult: false)",
    ]);
    expect(nodes.event!.location).toEqual({ "@type": "VirtualLocation", url: "https://riddlergo.com/riddler/hunt" });
    expect(nodes.event!).not.toHaveProperty("isAccessibleForFree");
  });

  it("howTo: steps in order, a valid duration", () => {
    expect((nodes.howTo!.step as Array<{ position: number }>).map((s) => s.position)).toEqual([1, 2, 3]);
    expect(issuesOf(() => howTo(site, { path: "/h", name: "H", steps: [], totalTime: "15 minutes" }))).toEqual([
      "steps must have at least one entry",
      "totalTime must be an ISO 8601 duration like PT15M",
    ]);
  });

  it("faqPage: questions with answers, no repeats", () => {
    expect(
      issuesOf(() =>
        faqPage(site, {
          path: "/",
          items: [
            { question: "Free?", answer: "Yes." },
            { question: "free?", answer: "" },
          ],
        }),
      ),
    ).toEqual(["items[1].question repeats an earlier question", "items[1].answer is required"]);
  });

  it("article: an author, a publish date, modified not before published", () => {
    expect(issuesOf(() => article(site, { path: "/b", headline: "H", datePublished: "2026-10-02", dateModified: "2026-10-01", authors: [] }))).toEqual([
      "authors must name at least one author",
      "dateModified is before datePublished",
    ]);
    expect(nodes.blogPosting!["@type"]).toBe("BlogPosting");
  });

  it("itemList: each item links to its own page", () => {
    expect(issuesOf(() => itemList(site, { path: "/l", items: [{ path: "" }] }))).toEqual(["items[0].path is required"]);
    expect(nodes.itemList!.numberOfItems).toBe(2);
  });

  it("place and touristAttraction: real types only, coordinates in range, one node per attraction", () => {
    expect(issuesOf(() => place(site, { name: "X", type: "LandformFeature" as never }))).toEqual([expect.stringContaining('type "LandformFeature"')]);
    expect(issuesOf(() => place(site, { name: "X", geo: { latitude: 91, longitude: 200 } }))).toEqual([
      "geo.latitude must be between -90 and 90",
      "geo.longitude must be between -180 and 180",
    ]);
    const t = nodes.touristAttraction!;
    expect(t).toMatchObject({
      "@type": "TouristAttraction",
      "@id": "https://riddlergo.com/trails/delicate-arch#attraction",
      additionalType: "https://schema.org/Landform",
      aggregateRating: { ratingValue: 4.7, ratingCount: 12 },
      geo: { elevation: "4829 ft" },
      address: { addressCountry: "US" },
    });
    expect(nodes.place!["@id"]).toBe("https://riddlergo.com/#place-delicate-arch");
  });

  it("localBusiness: an address and well-formed hours", () => {
    expect(issuesOf(() => localBusiness(site, { address: {}, openingHours: [{ days: [], opens: "8am", closes: "17:00" }] }))).toEqual([
      "openingHours[0] times must be HH:MM from 00:00 to 23:59",
      "openingHours[0].days must name at least one day",
      "address has no fields",
    ]);
    expect(issuesOf(() => localBusiness(site, {} as never))).toEqual(["address is required"]);
  });

  it("person: a name", () => {
    expect(issuesOf(() => person(site, { name: "" }))).toEqual(["name is required"]);
  });
});

describe("aggregateRatingFrom", () => {
  it("averages to one decimal, and says nothing below the credibility threshold", () => {
    expect(aggregateRatingFrom([5, 4, 4], { min: 3 })).toEqual({ value: 4.3, count: 3, best: 5, worst: 1 });
    expect(aggregateRatingFrom([5, 4], { min: 3 })).toBeUndefined();
    expect(aggregateRatingFrom([])).toBeUndefined();
  });

  it("feeds a builder directly", () => {
    const rating = aggregateRatingFrom([5, 5, 4]);
    expect(product(site, { path: "/p", name: "P", aggregateRating: rating }).aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.7,
      bestRating: 5,
      worstRating: 1,
      ratingCount: 3,
    });
  });
});

describe("closed lists", () => {
  it("lists real availability values", () => {
    expect(AVAILABILITIES).toContain("InStock");
    expect(PLACE_TYPES).not.toContain("LandformFeature" as never);
  });
});

describe("rich results: Google's requirements by default, a plain description on request", () => {
  it("product: an offer makes it a merchant listing, which needs an image", () => {
    expect(issuesOf(() => product(site, { path: "/pricing", id: "plan-pro", name: "Pro", offers: { price: 29, currency: "USD", billing: "month" } }))).toEqual([
      expect.stringContaining("image is required with offers"),
    ]);
  });

  it("product: a review needs a rating, and a rating-less review does not make a Product eligible", () => {
    expect(issuesOf(() => product(site, { path: "/p", name: "P", reviews: [{ author: "Bob", body: "ok" }] }))).toEqual([
      expect.stringContaining("reviews[0].rating is required"),
    ]);
  });

  it("product with richResult: false: a plan with no public price (Riddler Go's enterprise_contact) is still described", () => {
    const enterprise = product(site, { path: "/pricing", id: "plan-enterprise", name: "Enterprise", description: "Contact us.", richResult: false });
    expect(enterprise).toEqual({
      "@type": "Product",
      "@id": "https://riddlergo.com/pricing#plan-enterprise",
      name: "Enterprise",
      description: "Contact us.",
      url: "https://riddlergo.com/pricing",
    });
    expect(product(site, { path: "/p", name: "P", reviews: [{ author: "Bob", body: "ok" }], richResult: false }).review).toEqual([
      { "@type": "Review", author: { "@type": "Person", name: "Bob" }, reviewBody: "ok" },
    ]);
  });

  it("softwareApplication: Google's Software App result needs a price AND a rating or review", () => {
    expect(issuesOf(() => softwareApplication(site, { name: "Riddler Go", applicationCategory: "GameApplication", offers: { price: 0, currency: "USD" } }))).toEqual([
      "aggregateRating or reviews is required: Google's Software App result needs one (an app with no ratings yet passes richResult: false)",
    ]);
  });

  it("softwareApplication with richResult: false: Riddler Go's free app with no ratings, an AdminIgloo feature with no public price", () => {
    const riddlerGo = softwareApplication(site, {
      name: "Riddler Go",
      applicationCategory: "GameApplication",
      operatingSystem: "Any (web browser)",
      offers: { price: 0, currency: "USD", availability: "InStock" },
      richResult: false,
    });
    expect(riddlerGo.offers).toMatchObject({ price: "0.00", priceCurrency: "USD" });
    const feature = softwareApplication(site, { path: "/features/estimator", name: "Estimator", applicationCategory: "BusinessApplication", operatingSystem: "Web", richResult: false });
    expect(feature).not.toHaveProperty("offers");
    expect(feature["@id"]).toBe("https://riddlergo.com/features/estimator#software");
  });

  it("event with richResult: false: an event with no date yet is described without one (Riddler Go's 'omits date fields' test)", () => {
    const undated = event(site, { path: "/riddler/hunt", name: "Hunt", attendance: "online", location: { type: "virtual" }, startDate: null, richResult: false });
    expect(undated).not.toHaveProperty("startDate");
    expect(undated).not.toHaveProperty("endDate");
    expect(issuesOf(() => event(site, { path: "/e1", name: "E", attendance: "online", location: { type: "virtual" }, endDate: "2026-10-02", richResult: false }))).toEqual([
      "endDate needs a startDate",
    ]);
  });
});

describe("event times and statuses", () => {
  const base = { path: "/riddler/hunt", name: "Hunt", attendance: "online", location: { type: "virtual" } } as const;

  it("refuses a start time with no time zone, and keeps an offset as written", () => {
    expect(issuesOf(() => event(site, { ...base, startDate: "2026-10-01T19:00" }))).toEqual([expect.stringMatching(/^startDate has no time zone \(2026-10-01T19:00\)/)]);
    expect(event(site, { ...base, startDate: "2026-10-01T19:00:00-06:00" }).startDate).toBe("2026-10-01T19:00:00-06:00");
    expect(event(site, { ...base, startDate: "2026-10-01" }).startDate).toBe("2026-10-01");
  });

  it("refuses an impossible calendar date", () => {
    expect(issuesOf(() => event(site, { ...base, startDate: "2026-02-30" }))).toEqual(["startDate is not a real calendar date (2026-02-30)"]);
    expect(issuesOf(() => article(site, { path: "/b", headline: "H", datePublished: "2026-04-31", authors: [{ name: "R" }] }))).toEqual([
      "datePublished is not a real calendar date (2026-04-31)",
    ]);
  });

  it("rescheduled needs the date it moved from; previousStartDate means nothing otherwise", () => {
    expect(issuesOf(() => event(site, { ...base, startDate: "2026-11-01", status: "rescheduled" }))).toEqual([
      'status "rescheduled" needs previousStartDate, the date it was moved from',
    ]);
    expect(event(site, { ...base, startDate: "2026-11-01", status: "rescheduled", previousStartDate: "2026-10-01" })).toMatchObject({
      eventStatus: "https://schema.org/EventRescheduled",
      previousStartDate: "2026-10-01",
    });
    expect(issuesOf(() => event(site, { ...base, startDate: "2026-11-01", previousStartDate: "2026-10-01" }))).toEqual(['previousStartDate is only for status "rescheduled"']);
  });

  it("moved-online needs online (or mixed) attendance with a virtual location", () => {
    const place = { type: "place", name: "Hall", address: { addressLocality: "Provo" } } as const;
    expect(issuesOf(() => event(site, { ...base, startDate: "2026-11-01", status: "moved-online", attendance: "offline", location: place }))).toEqual([
      'status "moved-online" needs attendance "online" (or "mixed"), with a virtual location',
    ]);
    expect(event(site, { ...base, startDate: "2026-11-01", status: "moved-online" }).eventStatus).toBe("https://schema.org/EventMovedOnline");
  });
});

describe("localBusiness: the site's own business", () => {
  const address = { streetAddress: "1 Main St", addressLocality: "Provo", addressRegion: "UT", addressCountry: "US" };

  it("refuses a rating a business would publish about itself", () => {
    expect(issuesOf(() => localBusiness(site, { address, aggregateRating: { value: 5, count: 3 } } as never))).toEqual([
      expect.stringContaining("aggregateRating and reviews are not accepted"),
    ]);
  });

  it("writes open-all-day as 00:00 to 23:59 and refuses 24:00", () => {
    expect(issuesOf(() => localBusiness(site, { address, openingHours: [{ days: ["Monday"], opens: "00:00", closes: "24:00" }] }))).toEqual([
      "openingHours[0] times must be HH:MM from 00:00 to 23:59",
    ]);
    expect(localBusiness(site, { address, openingHours: [{ days: ["Monday"], opens: "00:00", closes: "23:59" }] }).openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday"], opens: "00:00", closes: "23:59" },
    ]);
  });
});

describe("logo and sameAs", () => {
  it("refuses a .ico logo and a sameAs on the site itself", () => {
    expect(issuesOf(() => organization(site, { logo: "/favicon.ico?v=2", sameAs: ["/about", "https://riddlergo.com/x", "https://www.instagram.com/riddlergo"] }))).toEqual([
      expect.stringContaining('logo "/favicon.ico?v=2" is an .ico file'),
      expect.stringContaining('sameAs "/about" is on this site'),
      expect.stringContaining('sameAs "https://riddlergo.com/x" is on this site'),
    ]);
    expect(issuesOf(() => localBusiness(site, { address: { addressLocality: "Provo" }, logo: { url: "/icon.ICO" } }))).toEqual([expect.stringContaining("is an .ico file")]);
    expect(issuesOf(() => person(site, { name: "Dallin", sameAs: ["/team/dallin"] }))).toEqual([expect.stringContaining("is on this site")]);
  });
});

describe("offers", () => {
  it("writes one DefinedRegion per shipping country", () => {
    const p = product(site, { path: "/d", name: "D", image: "/d.png", offers: { price: 5, currency: "USD", shipping: { rate: 4, country: ["us", "CA"] } } });
    expect((p.offers as { shippingDetails: { shippingDestination: unknown } }).shippingDetails.shippingDestination).toEqual([
      { "@type": "DefinedRegion", addressCountry: "US" },
      { "@type": "DefinedRegion", addressCountry: "CA" },
    ]);
  });

  it("bills a subscription per period with billingIncrement, never referenceQuantity (merchant listings read that as unit pricing)", () => {
    const spec = (nodes.product!.offers as { priceSpecification: Record<string, unknown> }).priceSpecification;
    expect(spec).toEqual({ "@type": "UnitPriceSpecification", price: "29.00", priceCurrency: "USD", unitCode: "MON", billingIncrement: 1 });
    expect(JSON.stringify(nodes)).not.toContain("referenceQuantity");
  });
});

describe("one page node per URL", () => {
  const faq = [{ question: "Do guests need an account?", answer: "No." }];

  it("webPage({ faq }) is the page AND its FAQ: one node typed WebPage and FAQPage, the questions as mainEntity", () => {
    const page = webPage(site, { path: "/", name: "Riddler Go", faq });
    expect(page["@type"]).toEqual(["WebPage", "FAQPage"]);
    expect(page["@id"]).toBe("https://riddlergo.com/#webpage");
    expect(page.mainEntity).toEqual([{ "@type": "Question", name: "Do guests need an account?", acceptedAnswer: { "@type": "Answer", text: "No." } }]);
    expect(issuesOf(() => webPage(site, { path: "/", name: "X", faq, mainEntity: ref(organizationId(site)) }))).toEqual([expect.stringContaining("faq and mainEntity")]);
  });

  it("graph() refuses two page nodes for one URL: webPage beside faqPage was two pages (and two FAQPages with webPage typed FAQPage)", () => {
    expect(() => graph(webPage(site, { path: "/", name: "Home" }), faqPage(site, { path: "/", items: faq }))).toThrow(/two page nodes .* describe https:\/\/riddlergo.com\//);
    expect(() => graph(collectionPage(site, { path: "/templates", name: "T" }), webPage(site, { path: "/templates", name: "T", id: "other" }))).toThrow(/two page nodes/);
    expect(graph(faqPage(site, { path: "/", items: faq }), nodes.organization, nodes.softwareApplication)["@graph"]).toHaveLength(3);
  });

  it("no longer offers FAQPage as a webPage type", () => {
    expect(WEB_PAGE_TYPES).not.toContain("FAQPage" as never);
    expect(issuesOf(() => webPage(site, { path: "/", name: "X", type: "FAQPage" as never }))).toEqual([expect.stringContaining('type "FAQPage"')]);
  });
});

describe("unresolvedRefs", () => {
  it("lists the references no rendered node defines, across the layout's and the page's blocks", () => {
    const layout = graph(nodes.organization, nodes.webSite);
    const page = graph(webPage(site, { path: "/blog/launch", name: "Launch" }), nodes.article);
    expect(unresolvedRefs(layout, page)).toEqual(["https://riddlergo.com/#person-dallin"]);
    expect(unresolvedRefs(layout, page, graph(nodes.person))).toEqual([]);
    expect(unresolvedRefs(page)).toEqual(["https://riddlergo.com/#organization", "https://riddlergo.com/#person-dallin", "https://riddlergo.com/#website"]);
  });
});
