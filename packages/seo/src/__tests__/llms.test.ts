import { describe, expect, it } from "vitest";
import { llmsFullTxt, llmsResponse, llmsTxt, SeoError, type LlmsRegistry } from "../index.js";
import { site, staging } from "./fixtures.js";

/** Riddler Go's content, as the app's own registries would supply it. */
const registry: LlmsRegistry = {
  summary: "Riddler Go is a web platform for hosting interactive puzzle events. Guests join with a QR code; no accounts, no downloads.",
  about: "Hosts author events with puzzles and hints.\n\nParticipants race a live leaderboard.",
  sections: [
    {
      title: "Product",
      items: [
        { title: "Home", path: "/", summary: "Overview and feature summary." },
        { title: "How it works", path: "/how-it-works", summary: "Build, share, watch.", body: "Build an event from puzzles. Share the code. Watch the leaderboard." },
        { title: "Join an event", path: "/join", summary: "Enter a 6-character code." },
      ],
    },
    {
      title: "Templates",
      items: [
        { title: "Bridal shower [hunt]", path: "/templates/bridal-shower", summary: "A themed hunt for guests.", body: "A long description of the bridal shower template. ".repeat(20) },
        { title: "Team building", path: "/templates/team building", summary: "Remote and in-person challenges." },
      ],
    },
    { title: "Updates", optional: true, items: [{ title: "Changelog", path: "/changelog", summary: "What shipped, by version." }] },
  ],
  howItWorks: {
    path: "/how-it-works",
    steps: [
      { name: "Build", text: "Add puzzles and hints." },
      { name: "Share", text: "Send the QR code." },
      { name: "Watch", text: "Follow the live leaderboard." },
    ],
  },
  pricing: {
    path: "/pricing",
    currency: "USD",
    plans: [
      { name: "Free", price: "Free", description: "One event at a time." },
      { name: "Pro", price: 29, interval: "month", description: "Unlimited events.", features: ["Custom branding", "CSV export"] },
      { name: "Event pass", price: 49.5, interval: "one-time" },
    ],
    note: "Prices in US dollars.",
  },
  faqs: {
    path: "/#faq",
    items: [
      { question: "Do guests need an account?", answer: "No. They join with a code." },
      { question: "Can I reuse an event?", answer: "Yes, duplicate it from the dashboard." },
    ],
  },
  contact: { email: "hello@riddlergo.com", path: "/contact" },
};

describe("llms.txt: the index", () => {
  const doc = llmsTxt(site, registry);

  it("is built from the registry only: title, summary, link lists, how it works, pricing, FAQ, contact", () => {
    expect(doc.text).toMatchSnapshot();
    expect(doc.trimmed).toBe(false);
  });

  it("links llms-full.txt and the sitemap (trailcards' llms.txt never linked its full file)", () => {
    expect(doc.text).toContain("- [Full text](https://riddlergo.com/llms-full.txt)\n- [Sitemap](https://riddlergo.com/sitemap.xml)\n");
  });

  it("carries pricing and how-it-works (Riddler Go's llms.txt had neither), each as a link line", () => {
    expect(doc.text).toContain(
      "## Pricing\n\n- [Free](https://riddlergo.com/pricing): Free. One event at a time.\n- [Pro](https://riddlergo.com/pricing): $29/month. Unlimited events.\n- [Event pass](https://riddlergo.com/pricing): $49.50 one-time\n",
    );
    expect(doc.text).toContain("## How it works\n\n- [How it works](https://riddlergo.com/how-it-works): 1. Build; 2. Share; 3. Watch\n");
  });

  it("writes every line under a ## heading as `- [name](url): notes`, the only shape llmstxt.org's parser reads", () => {
    const body = doc.text.slice(doc.text.indexOf("\n## "));
    const lines = body.split("\n").filter((line) => line !== "" && !line.startsWith("## "));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect([line, /^- \[(?:[^\]\\]|\\.)+\]\((?:https?|mailto):[^)\s]+\)(?:: .+)?$/.test(line)]).toEqual([line, true]);
    expect(doc.text).toContain("## Contact\n\n- [Email](mailto:hello@riddlergo.com)\n- [Contact](https://riddlergo.com/contact)\n");
  });

  it("links the FAQ once, not once per question to the same URL", () => {
    expect(doc.text).toContain("## FAQ\n\n- [FAQ](https://riddlergo.com/#faq): 2 questions\n");
    const anchored = llmsTxt(site, { ...registry, faqs: { path: "/#faq", items: [{ question: "Do guests need an account?", answer: "No.", path: "/#faq-accounts" }, ...registry.faqs!.items.slice(1)] } });
    expect(anchored.text).toContain("## FAQ\n\n- [Do guests need an account?](https://riddlergo.com/#faq-accounts)\n- [FAQ](https://riddlergo.com/#faq): 1 question\n");
  });

  it("keeps markdown links intact: brackets escaped, spaces and parentheses encoded", () => {
    expect(doc.text).toContain("- [Bridal shower \\[hunt\\]](https://riddlergo.com/templates/bridal-shower): A themed hunt for guests.");
    expect(doc.text).toContain("(https://riddlergo.com/templates/team%20building)");
  });

  it("puts optional sections under ## Optional, last", () => {
    expect(doc.text.trimEnd().endsWith("## Optional\n\n- [Changelog](https://riddlergo.com/changelog): What shipped, by version.")).toBe(true);
  });
});

describe("llms-full.txt: the text", () => {
  const doc = llmsFullTxt(site, registry);

  it("has every body, the steps, every plan with features, every answer", () => {
    expect(doc.text).toMatchSnapshot();
    expect(doc.text).toContain("Build an event from puzzles. Share the code. Watch the leaderboard.");
    expect(doc.text).toContain("### Pro: $29/month\n\nUnlimited events.\n\n- Custom branding\n- CSV export\n");
    expect(doc.text).toContain("### Do guests need an account?\n\nNo. They join with a code.\n");
    expect(doc.text).toContain("1. **Build**: Add puzzles and hints.");
    expect(doc.text).toContain("Hosts author events with puzzles and hints.\n\nParticipants race a live leaderboard.");
  });
});

describe("budgets", () => {
  const big: LlmsRegistry = {
    ...registry,
    sections: [
      ...(registry.sections ?? []),
      {
        title: "Trails",
        items: Array.from({ length: 400 }, (_, i) => ({
          title: `Trail ${i} — Ünïcödé 山`,
          path: `/trails/${i}`,
          summary: `Trail number ${i} in the deck.`,
          body: `A long body for trail ${i}. `.repeat(30),
        })),
      },
    ],
  };

  it("never exceeds the budget, counting UTF-8 bytes, at any size", () => {
    const untrimmed = { index: llmsTxt(site, big, { maxBytes: 1e9 }).bytes, full: llmsFullTxt(site, big, { maxBytes: 1e9 }).bytes };
    expect(untrimmed.index).toBeGreaterThan(30_000);
    expect(untrimmed.full).toBeGreaterThan(300_000);
    for (const maxBytes of [300, 1_000, 2_500, 5_000, 12_000, 40_000, 120_000]) {
      const docs = { index: llmsTxt(site, big, { maxBytes }), full: llmsFullTxt(site, big, { maxBytes }) };
      for (const [kind, doc] of Object.entries(docs)) {
        expect([kind, maxBytes, doc.bytes <= maxBytes]).toEqual([kind, maxBytes, true]);
        expect(doc.bytes).toBe(new TextEncoder().encode(doc.text).length);
        expect(doc.trimmed).toBe(untrimmed[kind as keyof typeof untrimmed] > maxBytes);
      }
    }
  });

  it("drops the optional section first, then items from the end of the LONGEST list, and says how many are left out and where", () => {
    const full = llmsTxt(site, big, { maxBytes: 1_000_000 });
    const doc = llmsTxt(site, big, { maxBytes: Math.floor(full.bytes / 2) });
    expect(doc.cut).toBe(false);
    expect(doc.text).not.toContain("[Changelog]");
    expect(doc.text).toMatch(/- \[…and \d+ more\]\(https:\/\/riddlergo\.com\/sitemap\.xml\)\n/);
    expect(doc.text).toContain("[Trail 0 ");
    expect(doc.text).not.toContain("[Trail 399 ");
    // The short curated lists are whole: the 400-trail list gave way first.
    for (const title of ["[Home]", "[How it works]", "[Join an event]", "[Bridal shower \\[hunt\\]]", "[Team building]"]) expect(doc.text).toContain(title);
    expect(doc.text).toContain("## Pricing");
  });

  it("takes from every list's end once the lists are the same length, not the whole last list first", () => {
    const even: LlmsRegistry = {
      summary: "S.",
      sections: ["A", "B", "C"].map((name) => ({
        title: name,
        items: Array.from({ length: 6 }, (_, i) => ({ title: `${name}${i}`, path: `/${name.toLowerCase()}/${i}`, summary: "x".repeat(40) })),
      })),
    };
    const full = llmsTxt(site, even, { maxBytes: 1e6 });
    const doc = llmsTxt(site, even, { maxBytes: full.bytes - 300 });
    expect(doc.omitted).toBeGreaterThanOrEqual(3);
    for (const name of ["A", "B", "C"]) {
      expect([name, doc.text.includes(`[${name}0]`), doc.text.includes(`[${name}5]`)]).toEqual([name, true, false]);
    }
  });

  it("in the full file, shortens bodies to summaries before dropping anything, and keeps the answers longest", () => {
    const full = llmsFullTxt(site, big, { maxBytes: 10_000_000 });
    const doc = llmsFullTxt(site, big, { maxBytes: Math.floor(full.bytes / 3) });
    expect(doc.shortened).toBeGreaterThan(0);
    expect(doc.omitted).toBe(0);
    expect(doc.text).toContain("Trail number 399 in the deck.");
    const tight = llmsFullTxt(site, big, { maxBytes: 9_000 });
    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.text).toContain("### Do guests need an account?");
  });

  it("cuts at a line boundary only when even the essentials do not fit", () => {
    const doc = llmsTxt(site, big, { maxBytes: 300 });
    expect(doc.cut).toBe(true);
    expect(doc.text.endsWith("\n[truncated]\n")).toBe(true);
    expect(doc.text.startsWith("# Riddler Go\n")).toBe(true);
  });
});

describe("validation and serving", () => {
  it("lists every missing field, and refuses a numeric price with no currency", () => {
    let caught: unknown;
    try {
      llmsTxt(site, { summary: " ", sections: [{ title: "", items: [{ title: "", path: "", summary: "" }] }], pricing: { plans: [{ name: "Pro", price: 9 }] } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SeoError);
    expect((caught as SeoError).issues).toEqual([
      "summary is required",
      "sections[0].title is required",
      "sections[0].items[0].title is required",
      "sections[0].items[0].summary is required",
      "sections[0].items[0].path must be a path or a URL when given",
      "pricing.plans[0]: a numeric price needs an ISO 4217 currency",
    ]);
  });

  it("never lists a page under a private or noindex path (the sitemap and IndexNow keep the same rule)", () => {
    const leaky: LlmsRegistry = {
      summary: "S.",
      sections: [{ title: "Pages", items: [{ title: "Admin", path: "/admin/x", summary: "s" }, { title: "Elsewhere", path: "https://github.com/riddlergo", summary: "s" }] }],
      faqs: { items: [{ question: "Q?", answer: "A.", path: "/sign-in#faq" }] },
      contact: { links: [{ title: "Invite", path: "/invite/abc" }] },
    };
    expect(() => llmsTxt(site, leaky)).toThrow(SeoError);
    let caught: unknown;
    try {
      llmsFullTxt(site, leaky);
    } catch (error) {
      caught = error;
    }
    {
      expect((caught as SeoError).issues).toEqual([
        "sections[0].items[0].path https://riddlergo.com/admin/x is under a private path in the site's path list, so it cannot be listed",
        "faqs.items[0].path https://riddlergo.com/sign-in#faq is under a noindex path in the site's path list, so it cannot be listed",
        "contact.links[0].path https://riddlergo.com/invite/abc is under a private path in the site's path list, so it cannot be listed",
      ]);
    }
  });

  it("serves text/plain with browser caching only (no s-maxage, so a crawler log still sees fetches), kept out of search results", async () => {
    const response = llmsResponse(llmsTxt(site, registry));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain("# Riddler Go");
    expect(llmsResponse("x", { noindex: false }).headers.get("x-robots-tag")).toBeNull();
  });

  it("is empty off production and answers 404, as the sitemap is empty there (the registry is still checked)", async () => {
    const doc = llmsTxt(staging, registry);
    expect(doc).toMatchObject({ text: "", bytes: 0, offProduction: true });
    expect(llmsFullTxt(staging, registry)).toMatchObject({ text: "", offProduction: true });
    const response = llmsResponse(doc);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).not.toContain("staging.riddlergo.com");
    expect(() => llmsTxt(staging, { summary: "" })).toThrow(/summary is required/);
  });
});

describe("content with no page of its own, and a site with no full file", () => {
  /** Riddler Go's llms-full.txt sections that are lists, not pages. */
  const riddlerGo: LlmsRegistry = {
    summary: "Riddler Go is a web platform for hosting interactive puzzle events.",
    sections: [
      { title: "Product", items: [{ title: "Home", path: "/", summary: "Overview." }] },
      {
        title: "Puzzle types",
        items: [
          { title: "Simple answer", summary: "Type the answer." },
          { title: "Word scramble", summary: "Unscramble the letters." },
        ],
      },
      { title: "Event modes", text: "- **Competitive**: a running clock.\n- **Completion**: no rank." },
    ],
    contact: { email: "hello@riddlergo.com", links: [{ title: "Book a call", path: "/book" }] },
  };

  it("links pathless items and text-only sections to the full file, and writes their text there", () => {
    const index = llmsTxt(site, riddlerGo).text;
    expect(index).toContain("## Puzzle types\n\n- [Simple answer](https://riddlergo.com/llms-full.txt): Type the answer.\n");
    expect(index).toContain("## Event modes\n\n- [Event modes](https://riddlergo.com/llms-full.txt)\n");
    expect(index).toContain("## Contact\n\n- [Email](mailto:hello@riddlergo.com)\n- [Book a call](https://riddlergo.com/book)\n");
    const full = llmsFullTxt(site, riddlerGo).text;
    expect(full).toContain("## Puzzle types\n\n### Simple answer\n\nType the answer.\n");
    expect(full).toContain("## Event modes\n\n- **Competitive**: a running clock.\n- **Completion**: no rank.\n");
  });

  it("with fullPath: false, links nothing to a file the site does not serve", () => {
    const index = llmsTxt(site, { ...riddlerGo, faqs: { items: [{ question: "Free?", answer: "Yes." }] } }, { fullPath: false }).text;
    expect(index).not.toContain("llms-full.txt");
    expect(index).toContain("- [Sitemap](https://riddlergo.com/sitemap.xml)\n");
    expect(index).toContain("- Simple answer: Type the answer.\n");
    expect(index).not.toContain("## Event modes");
    expect(index).toContain("## FAQ\n\n- Free?\n");
  });
});
