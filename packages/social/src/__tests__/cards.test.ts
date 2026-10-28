import { readFileSync, readdirSync } from "node:fs";
import { ImageResponse } from "next/og";
import { describe, expect, it } from "vitest";
import { genericHonesty } from "../honesty.js";
import { PLATFORM_IDS } from "../types.js";
import {
  brandedAssets,
  cardAlt,
  cardBrand,
  cardFormatSets,
  cardImage,
  cardLayout,
  cardParams,
  CARD_FONT_FILES,
  CARD_SANS,
  CARD_SERIF,
  CARD_SIZES,
  createCardRoute,
  draftCards,
  FIT_SLACK,
  launchCarousel,
  layoutCard,
  MAX_LIST_ROWS,
  parseCardParams,
  parseFontMetrics,
  quoteCard,
  releaseCarousel,
  SAFE_AREA,
  sampleCardSets,
  signCardParams,
  slideBody,
  storyCarousel,
  textWidth,
  verifyCardParams,
  type CardAssets,
  type CardLayout,
  type CardMetrics,
  type CardSize,
  type CardSpec,
  type LineBlock,
  type TextBlock,
} from "../cards/index.js";
import { CARD_FONT_DATA } from "../cards/font-data.js";
import { cardFonts } from "../cards/fonts.js";
import { EYEBROW, QUOTE, ROW_PAD } from "../cards/layout.js";

/**
 * THE SOCIAL CARDS (../cards): a card's address can't be forged, its words
 * (and a business's name and address, however long) never run off the
 * picture, each format comes out at its platform's pixel size, a company's
 * card is drawn in its own name and colour, and the samples say nothing a
 * business shouldn't.
 */

const FONTS_DIR = new URL("../../fonts/", import.meta.url);
const font = (file: string) => parseFontMetrics(readFileSync(new URL(file, FONTS_DIR)));
const METRICS: CardMetrics = { serif: font("dm-serif-display-400.ttf"), sans: font("inter-700.ttf") };
const SECRET = "k".repeat(64);

const ASSETS: CardAssets = {
  fonts: cardFonts(),
  serif: CARD_SERIF,
  sans: CARD_SANS,
  theme: { ground: "#0e161c", text: "#e8edf1", muted: "#93a2ae", faint: "rgba(147, 162, 174, 0.18)", accent: "#45c4ad", onAccent: "#0e161c", glow: "rgba(69, 196, 173, 0.18)" },
  author: { name: "Maple & Rye", handle: "@maplerye" },
  brand: { name: "Maple & Rye", site: "maplerye.example" },
};

/** Real words, then words as wide as the font draws them. */
const WORDS = "we are now open on saturdays from nine to one for pickups and drop offs and weekday hours stay the same as always".split(" ");
const WIDE = ["WWWWW", "MMMMM", "@@@@", "Wm%Mw"];
function textOf(length: number, wide = false): string {
  const pool = wide ? WIDE : WORDS;
  let out = "";
  for (let i = 0; out.length < length; i++) out += `${out ? " " : ""}${pool[i % pool.length]}`;
  return out.slice(0, length).trim();
}
const LENGTHS = [3, 12, 30, 60, 90, 140, 200, 280, 400];

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("a card's address is signed", () => {
  const spec: CardSpec = { kind: "stat", size: "portrait", value: "$45", text: "A first visit is $45, any day of the week.", eyebrow: "New price" };
  const signed = signCardParams(cardParams(spec), SECRET);

  it("verifies with its key, and reads back as the same card", () => {
    expect(verifyCardParams(signed, SECRET)).toBe(true);
    const parsed = parseCardParams(signed);
    expect(parsed.ok && parsed.spec).toEqual(spec);
  });

  it("refuses a changed word, a changed number, an added or repeated parameter, a missing or edited signature, another key", () => {
    const tamper = (edit: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(signed);
      edit(p);
      return verifyCardParams(p, SECRET);
    };
    expect(tamper((p) => p.set("text", "Guaranteed results."))).toBe(false);
    expect(tamper((p) => p.set("value", "$4"))).toBe(false);
    expect(tamper((p) => p.set("note", "extra"))).toBe(false);
    expect(tamper((p) => p.append("text", "again"))).toBe(false);
    expect(tamper((p) => p.append("sig", p.get("sig")!))).toBe(false);
    expect(tamper((p) => p.delete("sig"))).toBe(false);
    expect(tamper((p) => p.set("sig", `${p.get("sig")!.slice(0, -1)}A`))).toBe(false);
    expect(verifyCardParams(signed, "x".repeat(64))).toBe(false);
    expect(verifyCardParams(signed, "")).toBe(false);
  });

  it("signs a company's brand with the rest: its name can't be swapped, and it reads back whole", () => {
    const words = cardBrand({ name: "Green Acres", site: "https://app.example.com/t/green-acres/", handle: "@greenacres", accent: "#1F7A4D", onAccent: "#ffffff" });
    expect(words).toEqual({ name: "Green Acres", site: "app.example.com/t/green-acres", handle: "@greenacres", accent: "#1f7a4d", onAccent: "#ffffff" });
    const branded = signCardParams(cardParams(quoteCard("Open on Saturdays.", "square", { brand: words })), SECRET);
    expect(verifyCardParams(branded, SECRET)).toBe(true);
    const parsed = parseCardParams(branded);
    expect(parsed.ok && parsed.spec.brand).toEqual(words);
    const swapped = new URLSearchParams(branded);
    swapped.set("brand", "Somebody Else");
    expect(verifyCardParams(swapped, SECRET)).toBe(false);
    // A colour that isn't a colour is dropped, never signed.
    expect(cardBrand({ name: "A", site: "a.example", accent: "red; background:url(x)" })).toEqual({ name: "A", site: "a.example" });
  });

  it("refuses a well-signed query that names no card, half a brand, or a picture the app doesn't have", async () => {
    const route = createCardRoute({ secret: () => SECRET, assets: () => ASSETS, paint: ImageResponse });
    const at = (params: URLSearchParams) => route(new Request(`https://x.test/api/social/card?${params}`));
    const forged = new URLSearchParams(signed);
    forged.set("text", "Guaranteed results.");
    const refused = await at(forged);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toMatch(/^text\/plain/);
    expect((await at(signCardParams(new URLSearchParams({ kind: "poster", size: "square", text: "Hello" }), SECRET))).status).toBe(400);
    expect((await at(signCardParams(new URLSearchParams({ kind: "quote", size: "square", text: "Hello", brand: "Half" }), SECRET))).status).toBe(400);
    expect((await at(signCardParams(new URLSearchParams({ kind: "cover", size: "portrait", text: "Hello", character: "mascot" }), SECRET))).status).toBe(400);
  });
});

/** Every block of words on a laid-out card, with what it must fit in. */
function blocksOf(layout: CardLayout): { text: TextBlock[]; lines: { block: LineBlock; serif: boolean; tracking: number }[] } {
  const sans = (block: LineBlock) => ({ block, serif: false, tracking: 0 });
  const serif = (block: LineBlock) => ({ block, serif: true, tracking: 0 });
  const eyebrow = (block: LineBlock | null) => (block ? [{ block, serif: false, tracking: EYEBROW.tracking }] : []);
  const chrome = (l: { wordmark: LineBlock; footer: LineBlock }) => [serif(l.wordmark), sans(l.footer)];
  switch (layout.kind) {
    case "quote":
      return { text: [layout.text], lines: [serif(layout.name), sans(layout.handle), sans(layout.site)] };
    case "cover":
      return { text: [layout.text], lines: [...eyebrow(layout.eyebrow), ...chrome(layout)] };
    case "stat":
      return { text: [layout.text, ...(layout.note ? [layout.note] : [])], lines: [serif(layout.value), ...eyebrow(layout.eyebrow), ...chrome(layout)] };
    case "list":
      return {
        text: [layout.text, ...(layout.note ? [layout.note] : [])],
        lines: [...eyebrow(layout.eyebrow), ...chrome(layout), ...layout.rows.flatMap((r) => [sans(r.label), ...(r.detail ? [sans(r.detail)] : []), ...(r.value ? [serif(r.value)] : [])])],
      };
    case "cta":
      return { text: layout.note ? [layout.note] : [], lines: [serif(layout.site), sans(layout.button), ...eyebrow(layout.eyebrow), ...chrome(layout)] };
  }
}

/** How tall the card's stacked content is, against the room it has. */
function stacked(layout: CardLayout): { used: number; room: number } {
  const eyebrow = (e: LineBlock | null) => (e ? EYEBROW.size + EYEBROW.gap : 0);
  if (layout.kind === "quote") {
    const room = layout.frame.height - QUOTE.top - QUOTE.bottom - QUOTE.footer - QUOTE.footerGap;
    return { used: QUOTE.avatar + QUOTE.gap + layout.text.height, room };
  }
  const body = slideBody(layout.frame);
  switch (layout.kind) {
    case "cover":
      return { used: eyebrow(layout.eyebrow) + layout.text.height + (layout.art ? layout.art + 24 : 0), room: body.height };
    case "stat":
      return { used: eyebrow(layout.eyebrow) + layout.value.size * 1.02 + 32 + layout.text.height + (layout.note ? layout.note.height + 40 : 0), room: body.height };
    case "list":
      return { used: eyebrow(layout.eyebrow) + layout.text.height + 40 + layout.rows.length * layout.rowHeight + (layout.note ? layout.note.height + 28 : 0), room: body.height };
    case "cta":
      return {
        used: eyebrow(layout.eyebrow) + (layout.art ? layout.art + 36 : 0) + layout.site.size * 1.1 + 32 + layout.button.size * 1.2 + 56 + (layout.note ? layout.note.height + 32 : 0),
        room: body.height,
      };
  }
}

function expectFits(layout: CardLayout, label: string) {
  const { text, lines } = blocksOf(layout);
  for (const block of text) {
    expect(block.lines.length * block.size * block.box.lineHeight, `${label}: height of "${block.text.slice(0, 40)}"`).toBeLessThanOrEqual(block.box.height + 0.01);
    expect(block.lines.length, label).toBeLessThanOrEqual(block.box.maxLines ?? Infinity);
    const serif = ("text" in layout && block === layout.text) || layout.kind === "quote";
    for (const line of block.lines) expect(textWidth(serif ? METRICS.serif : METRICS.sans, line, block.size), `${label}: "${line}"`).toBeLessThanOrEqual(block.box.width * FIT_SLACK + 0.01);
  }
  for (const { block, serif, tracking } of lines) {
    expect(textWidth(serif ? METRICS.serif : METRICS.sans, block.text, block.size, tracking), `${label}: "${block.text}"`).toBeLessThanOrEqual(block.width * FIT_SLACK + 0.01);
  }
  if (layout.kind === "list") {
    for (const row of layout.rows) {
      const height = row.label.size * 1.15 + (row.detail ? 6 + row.detail.size * 1.15 : 0);
      expect(height, `${label}: a row of "${row.label.text}"`).toBeLessThanOrEqual(layout.rowHeight - ROW_PAD + 0.01);
      if (row.value) expect(row.value.size, label).toBeLessThanOrEqual(layout.rowHeight - ROW_PAD);
    }
    expect(layout.medal, label).toBeLessThanOrEqual(layout.rowHeight);
  }
  const { used, room } = stacked(layout);
  expect(used, `${label}: stacked height`).toBeLessThanOrEqual(room + 0.01);
}

describe("the words never run off a card", () => {
  const SIZES: CardSize[] = ["square", "portrait", "story"];
  const BRANDS = [
    { name: "Maple & Rye", site: "maplerye.example", handle: "@maplerye", author: "Maple & Rye" },
    // A company with a long name and a long address: its wordmark, footer and handle step down and never run off.
    { name: "Alpha Lawn Care & Landscaping of the Greater Valley", site: "app.example.com/t/alpha-lawn-care-and-landscaping", handle: "@alphalawncareandlandscaping", author: "Alpha Lawn Care & Landscaping of the Greater Valley" },
  ];

  it("measures with the font files' own widths (an M is wider than an i)", () => {
    expect(textWidth(METRICS.serif, "M", 100)).toBeGreaterThan(textWidth(METRICS.serif, "i", 100) * 2);
    expect(textWidth(METRICS.serif, "71°", 100)).toBeGreaterThan(0);
    for (const { file } of CARD_FONT_FILES) expect(font(file).widths.get("¢".codePointAt(0)!), file).toBeGreaterThan(0);
  });

  for (const size of SIZES) {
    for (const wide of [false, true]) {
      it(`fits every length on every ${size} card${wide ? ", in the widest letters" : ""}, stepping the size down as the words grow`, () => {
        for (const brand of BRANDS) {
          const steps: Record<string, number[]> = {};
          for (const n of LENGTHS) {
            const words = textOf(n, wide);
            const specs: CardSpec[] = [
              { kind: "quote", size, text: words, date: "Oct 27" },
              { kind: "cover", size, text: words.slice(0, 200), eyebrow: textOf(Math.min(n, 60), wide) },
              { kind: "stat", size, value: textOf(Math.min(n, 24), wide), text: words.slice(0, 200), eyebrow: "A number", note: words.slice(0, 200) },
              {
                kind: "list",
                size,
                text: words.slice(0, 120),
                eyebrow: "What's new",
                ranked: true,
                rows: Array.from({ length: MAX_LIST_ROWS }, () => ({ label: textOf(Math.min(n, 60), wide), detail: textOf(Math.min(n, 80), wide), value: textOf(Math.min(n, 24), wide) })),
                note: words.slice(0, 200),
              },
              { kind: "cta", size, text: textOf(Math.min(n, 60), wide), eyebrow: "Every detail", note: words.slice(0, 200) },
            ];
            for (const spec of specs) {
              const layout = layoutCard(spec, METRICS, brand);
              expectFits(layout, `${spec.kind} ${size} ${n} chars${wide ? " wide" : ""} (${brand.name.slice(0, 12)})`);
              if (layout.kind === "quote" || layout.kind === "cover") (steps[spec.kind] ??= []).push(layout.text.size);
            }
          }
          // Longer words never get a bigger size.
          for (const [kind, sizes] of Object.entries(steps)) expect([...sizes].sort((a, b) => b - a), kind).toEqual(sizes);
        }
      });
    }
  }

  it("breaks a word too long for any line, and cuts what can't fit with an ellipsis", () => {
    const brand = BRANDS[0]!;
    const layout = layoutCard({ kind: "quote", size: "square", text: "x".repeat(400) }, METRICS, brand);
    expectFits(layout, "one long word");
    // Only then may satori break a word (and the lines go unbalanced): "thermometers" stays whole.
    expect(layout.kind === "quote" && layout.text.broken).toBe(true);
    const whole = layoutCard({ kind: "quote", size: "portrait", text: "Our new thermometers arrived. We checked 18 of 30 ovens." }, METRICS, brand);
    expect(whole.kind === "quote" && whole.text.broken).toBe(false);
    const long = layoutCard({ kind: "cover", size: "story", text: textOf(200, true) }, METRICS, brand);
    expectFits(long, "wide cover");
    expect(long.kind === "cover" && long.text.cut).toBe(true);
    expect(long.kind === "cover" && long.text.text.endsWith("…")).toBe(true);
  });
});

describe("each format comes out at its platform's size", () => {
  it("keeps 9:16 inside TikTok's safe zone: clear of the top 10%, the bottom 22% and the right 15%", () => {
    const { width, height } = CARD_SIZES.story;
    expect(SAFE_AREA.story.top).toBeGreaterThanOrEqual(height * 0.1);
    expect(SAFE_AREA.story.bottom).toBeGreaterThanOrEqual(height * 0.22);
    expect(SAFE_AREA.story.right).toBeGreaterThanOrEqual(width * 0.15);
    for (const kind of ["cover", "stat", "list", "cta"] as const) {
      const spec = { kind, size: "story", text: "See what's new", value: "312", rows: [{ label: "Saturdays" }] } as CardSpec;
      const layout = layoutCard(spec, METRICS, { name: "Maple & Rye", site: "maplerye.example", handle: "@maplerye", author: "Maple & Rye" });
      const body = slideBody(layout.frame);
      expect(body.top, kind).toBeGreaterThanOrEqual(height * 0.1);
      expect(body.top + body.height, kind).toBeLessThanOrEqual(height * 0.78);
      expect(layout.frame.left + layout.frame.contentWidth, kind).toBeLessThanOrEqual(width * 0.85);
    }
  });

  const route = createCardRoute({ secret: () => SECRET, assets: () => ASSETS, paint: ImageResponse });
  const green = cardBrand({ name: "Green Acres", site: "app.example.com/t/green-acres", accent: "#1f7a4d", onAccent: "#ffffff" });
  const launch = { hook: "We're open on Saturdays now, 9 to 1.", text: "Starting Nov 1 we're open on Saturdays from 9 to 1. Weekday hours stay the same.", eyebrow: "New hours", call: "See our hours" };
  const cases: [string, CardSpec][] = [
    ["quote 1:1", quoteCard("We're open on Saturdays now, 9 to 1.", "square", { date: "Oct 27" })],
    ["quote 4:5, a company's", quoteCard("No more waiting until Monday.", "portrait", { brand: green })],
    ...launchCarousel(launch, "story").map((spec): [string, CardSpec] => [`launch 9:16 ${spec.kind} ${spec.page?.index}`, spec]),
    ...launchCarousel({ ...launch, brand: green }, "portrait").map((spec): [string, CardSpec] => [`launch 4:5 ${spec.kind} ${spec.page?.index}, a company's`, spec]),
    ...releaseCarousel({ version: "2.4", title: "Online booking", items: ["Book online", "Text reminders"], call: "See what's new" }, "portrait").map((spec): [string, CardSpec] => [`release 4:5 ${spec.kind}`, spec]),
    ...storyCarousel({ hook: "Our year in numbers.", stats: [{ value: "312", line: "Homes cleaned." }], call: "Book a cleaning" }, "square").map((spec): [string, CardSpec] => [`story 1:1 ${spec.kind}`, spec]),
  ];

  for (const [label, spec] of cases) {
    it(`${label}: ${CARD_SIZES[spec.size].width}x${CARD_SIZES[spec.size].height} PNG`, async () => {
      const url = new URL(cardImage(spec, { base: "https://example.com/api/social/card", secret: SECRET, byline: { name: "Maple & Rye", handle: "@maplerye", site: "maplerye.example" } }).url);
      const response = await route(new Request(url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toContain("s-maxage=");
      expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual(CARD_SIZES[spec.size]);
    }, 30_000);
  }
});

describe("a company's card is drawn in its own name", () => {
  it("takes the brand words over the app's, with its colour and its first letter for the mark", () => {
    const spec = quoteCard("Open on Saturdays.", "square", { brand: cardBrand({ name: "Green Acres", site: "green.example", accent: "#1f7a4d", onAccent: "#ffffff" }) });
    const drawn = brandedAssets(spec, { ...ASSETS, brand: { ...ASSETS.brand, mark: { src: "data:image/png;base64,AA==", width: 1, height: 1 } } });
    expect(drawn.brand).toEqual({ name: "Green Acres", site: "green.example" });
    expect(drawn.author).toEqual({ name: "Green Acres", handle: "green.example" });
    expect(drawn.theme.accent).toBe("#1f7a4d");
    const layout = cardLayout(spec, ASSETS);
    expect(layout.kind === "quote" && [layout.name.text, layout.handle.text, layout.site.text]).toEqual(["Green Acres", "green.example", "green.example"]);
    expect(cardAlt(spec, { name: "Maple & Rye", handle: "@maplerye", site: "maplerye.example" })).toBe("Green Acres (green.example): Open on Saturdays.");
  });
});

describe("a draft's cards, per platform", () => {
  it("is a 1:1 quote card for X and the like, a 4:5 one for LinkedIn, the 4:5 carousel for Instagram and Facebook, 9:16 for TikTok, none for Reddit", () => {
    const shapes = Object.fromEntries(
      PLATFORM_IDS.map((p) => [p, draftCards(p, { quote: (size) => quoteCard("Hook.", size), carousel: (size) => launchCarousel({ hook: "Hook.", text: "The details.", call: "See more" }, size) }).map((s) => `${s.kind} ${s.size}`)]),
    );
    expect(shapes).toEqual({
      x: ["quote square"],
      threads: ["quote square"],
      bluesky: ["quote square"],
      telegram: ["quote square"],
      discord: ["quote square"],
      linkedin: ["quote portrait"],
      facebook: ["cover portrait", "cover portrait", "cta portrait"],
      instagram: ["cover portrait", "cover portrait", "cta portrait"],
      tiktok: ["cover story", "cover story", "cta story"],
      reddit: [],
    });
  });

  it("numbers the slides, keeps the details slide only when it says more than the hook, and cuts long words to what the route accepts", () => {
    const slides = launchCarousel({ hook: "New hours.", text: "New hours.", call: "See our hours" });
    expect(slides.map((s) => [s.kind, s.page])).toEqual([
      ["cover", { index: 1, count: 2 }],
      ["cta", { index: 2, count: 2 }],
    ]);
    const long = launchCarousel({ hook: "A hook.", text: "A long announcement. ".repeat(40), call: "x".repeat(90) });
    for (const spec of long) expect(parseCardParams(signCardParams(cardParams(spec), SECRET)).ok, spec.kind).toBe(true);
  });
});

describe("the samples", () => {
  it("cover every kind and size, sign into addresses the route draws, and say nothing the generic honesty list refuses", async () => {
    const sets = sampleCardSets(cardBrand({ name: "Green Acres", site: "green.example" }));
    const specs = sets.flatMap((s) => s.specs);
    expect(new Set(specs.map((s) => s.kind))).toEqual(new Set(["quote", "cover", "stat", "list", "cta"]));
    expect(new Set(specs.map((s) => s.size))).toEqual(new Set(["square", "portrait", "story"]));
    const byline = { name: "Maple & Rye", handle: "@maplerye", site: "maplerye.example" };
    const formats = cardFormatSets(sets, (spec) => cardImage(spec, { base: "/api/social/card", secret: SECRET, byline }));
    expect(formats.flatMap((f) => f.images)).toHaveLength(specs.length);
    for (const image of formats.flatMap((f) => f.images)) {
      expect(verifyCardParams(new URL(image.url, "https://example.com").searchParams, SECRET)).toBe(true);
      expect(image.label).toMatch(/^(\d+ of \d+ · )?[a-z]+ · (1:1|4:5|9:16) · \d+×\d+$/);
    }
    for (const spec of specs) {
      const words = [...Object.values(spec).filter((v): v is string => typeof v === "string"), cardAlt(spec, byline), ...(spec.kind === "list" ? spec.rows.map((r) => r.label) : [])];
      for (const text of words) expect(genericHonesty(text), text).toBeNull();
    }
  });
});

describe("the fonts", () => {
  it("travel inside the ./fonts entry, byte for byte the files in fonts/ (run `pnpm embed-fonts` after changing one)", () => {
    const files = readdirSync(FONTS_DIR).filter((f) => f.endsWith(".ttf")).sort();
    expect(Object.keys(CARD_FONT_DATA).sort()).toEqual(files);
    expect(CARD_FONT_FILES.map((f) => f.file).sort()).toEqual(files);
    for (const file of files) expect(Buffer.from(CARD_FONT_DATA[file]!, "base64").equals(readFileSync(new URL(file, FONTS_DIR))), file).toBe(true);
    const fonts = cardFonts();
    expect(fonts.map((f) => [f.name, f.weight])).toEqual(CARD_FONT_FILES.map((f) => [f.name, f.weight]));
    expect(parseFontMetrics(fonts[0]!.data).unitsPerEm).toBeGreaterThan(0);
  });
});
