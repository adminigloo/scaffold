import { ImageResponse } from "next/og";
import { describe, expect, it } from "vitest";
import {
  brandedAssets,
  cardBrand,
  cardDecor,
  cardImage,
  cardLayerUrl,
  cardLayout,
  cardMotion,
  cardParams,
  CARD_SANS,
  CARD_SERIF,
  CARD_SIZES,
  createCardRoute,
  decorBox,
  launchCarousel,
  parseCardParams,
  quoteCard,
  sampleCardSets,
  signCardParams,
  splitCardLayer,
  verifyCardParams,
  type CardAssets,
  type CardMotion,
  type CardSpec,
} from "../cards/index.js";
import { cardFonts } from "../cards/fonts.js";

/**
 * A CARD'S LOOK (social 0.5, ../cards/looks.ts): its colours and the pieces
 * around its words, signed with the words; a company's card never wears the
 * app's; and the parts a video moves (its ground, its words on nothing, each
 * piece, the motion sheet), asked for outside the signature since they only
 * ever draw less of the card.
 */

const SECRET = "k".repeat(64);
/** A real 1x1 PNG: satori draws it into whatever box it's given. */
const DOT = { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", width: 1034, height: 834 };

const ASSETS: CardAssets = {
  fonts: cardFonts(),
  serif: CARD_SERIF,
  sans: CARD_SANS,
  theme: { ground: "#0e161c", text: "#e8edf1", muted: "#93a2ae", faint: "rgba(147, 162, 174, 0.18)", accent: "#45c4ad", onAccent: "#0e161c" },
  author: { name: "Maple & Rye", handle: "@maplerye" },
  brand: { name: "Maple & Rye", site: "maplerye.example" },
  looks: {
    party: {
      theme: { ground: "#2d1a5b", accent: "#f1a834", onAccent: "#1a1a1a", button: "#59bc6c", onButton: "#ffffff" },
      decor: ({ width, height }) => [
        { kind: "ball", color: "#29baf8", size: 100, x: width - 60, y: 60, label: "GO", ink: "#ffffff", enter: "pop", delay: 0.1, bob: true },
        { kind: "bit", shape: "rect", color: "#fa5351", size: 40, x: 60, y: 60, rotate: 30, enter: "none" },
        { kind: "art", art: DOT, width: 517, x: 200, y: height - 160, rotate: 180, opacity: 0.5, enter: "spray", from: { x: 0, y: height }, stays: true, delay: 0.3 },
      ],
      eyebrow: { art: { ...DOT, width: 334, height: 52 }, color: "#1a1a1a" },
      words: "slide",
    },
  },
};

const BYLINE = { name: "Maple & Rye", handle: "@maplerye", site: "maplerye.example" };
const route = createCardRoute({ secret: () => SECRET, assets: () => ASSETS, paint: ImageResponse });
const urlOf = (spec: CardSpec) => cardImage(spec, { base: "https://x.test/api/social/card", secret: SECRET, byline: BYLINE }).url;
const get = (url: string) => route(new Request(url));

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

const cover: CardSpec = { ...launchCarousel({ hook: "We're open on Saturdays now, 9 to 1.", text: "From Nov 1.", eyebrow: "New hours", call: "See our hours" }, "square")[0]!, look: "party" };

describe("a card's look", () => {
  it("is signed with its words: it reads back, and can't be swapped or added", () => {
    const signed = signCardParams(cardParams(cover), SECRET);
    expect(verifyCardParams(signed, SECRET)).toBe(true);
    const parsed = parseCardParams(signed);
    expect(parsed.ok && parsed.spec.look).toBe("party");
    const swapped = new URLSearchParams(signed);
    swapped.set("look", "other");
    expect(verifyCardParams(swapped, SECRET)).toBe(false);
    const plain = signCardParams(cardParams({ ...cover, look: undefined }), SECRET);
    const added = new URLSearchParams(plain);
    added.set("look", "party");
    expect(verifyCardParams(added, SECRET)).toBe(false);
    // A look's name is a short key, like a character's.
    expect(parseCardParams(signCardParams(cardParams({ ...cover, look: "Not A Key" }), SECRET)).ok).toBe(false);
  });

  it("is drawn: its pieces and colours on the card, and the plain card for a look the app doesn't have", async () => {
    const looked = await get(urlOf(cover));
    expect(looked.status).toBe(200);
    const plain = await bytesOf(await get(urlOf({ ...cover, look: undefined })));
    const looks = await bytesOf(looked);
    expect(pngSize(looks)).toEqual(CARD_SIZES.square);
    expect(Buffer.from(looks).equals(Buffer.from(plain))).toBe(false);
    const gone = await get(urlOf({ ...cover, look: "retired" }));
    expect(gone.status).toBe(200);
    expect(Buffer.from(await bytesOf(gone)).equals(Buffer.from(plain))).toBe(true);
  }, 30_000);

  it("is the app's own: a company's card is drawn without it, and has no pieces to move", () => {
    const company: CardSpec = { ...quoteCard("Open Saturdays.", "square", { brand: cardBrand({ name: "Green Acres", site: "green.example" }) }), look: "party" };
    expect(brandedAssets(company, ASSETS).looks).toBeUndefined();
    expect(cardDecor(company, brandedAssets(company, ASSETS))).toEqual([]);
    expect(cardMotion(company, ASSETS)).toMatchObject({ look: null, words: "rise", pieces: [] });
  });

  it("fits its brush stroke to the small capitals: the line knows its own width", () => {
    const layout = cardLayout(cover, ASSETS);
    if (layout.kind !== "cover" || !layout.eyebrow) throw new Error("a cover with an eyebrow");
    expect(layout.eyebrow.measured).toBeGreaterThan(0);
    expect(layout.eyebrow.measured).toBeLessThan(layout.eyebrow.width);
  });
});

describe("a card's parts, for a video", () => {
  it("come off before the signature is checked: one part, by name, at a time", () => {
    const signed = signCardParams(cardParams(cover), SECRET);
    const split = splitCardLayer(new URLSearchParams(`${signed}&layer=ground`));
    expect(split.ok && split.layer).toBe("ground");
    expect(split.ok && verifyCardParams(split.params, SECRET)).toBe(true);
    expect(splitCardLayer(new URLSearchParams(`${signed}&layer=words&layer=ground`)).ok).toBe(false);
    expect(splitCardLayer(new URLSearchParams(`${signed}&layer=poster`)).ok).toBe(false);
    expect(splitCardLayer(new URLSearchParams(`${signed}&layer=piece-01`)).ok).toBe(false);
    expect(cardLayerUrl("https://x.test/c?a=1&layer=words", "piece-2")).toBe("https://x.test/c?a=1&layer=piece-2");
  });

  it("give the motion sheet: the size, how the words come on, and each moving piece's box and entrance (a piece that doesn't move is the ground's)", async () => {
    const res = await get(cardLayerUrl(urlOf(cover), "motion"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=/);
    const sheet = (await res.json()) as CardMotion;
    const decor = cardDecor(cover, ASSETS);
    expect(sheet).toEqual({
      width: 1080,
      height: 1080,
      look: "party",
      words: "slide",
      pieces: [
        { index: 0, ...decorBox(decor[0]!), x: 1020, y: 60, from: { x: 1020, y: 60 }, enter: "pop", delay: 0.1, bob: true, stays: false },
        { index: 2, ...decorBox(decor[2]!), x: 200, y: 920, from: { x: 0, y: 1080 }, enter: "spray", delay: 0.3, bob: false, stays: true },
      ],
    });
    expect(await (await get(cardLayerUrl(urlOf({ ...cover, look: undefined }), "motion"))).json()).toEqual({ width: 1080, height: 1080, look: null, words: "rise", pieces: [] });
  }, 30_000);

  it("draw the ground and the words at the card's size, and a piece in its own box", async () => {
    for (const layer of ["ground", "words"] as const) {
      const res = await get(cardLayerUrl(urlOf(cover), layer));
      expect(res.status, layer).toBe(200);
      expect(pngSize(await bytesOf(res)), layer).toEqual(CARD_SIZES.square);
    }
    const box = decorBox(cardDecor(cover, ASSETS)[0]!);
    const piece = await get(cardLayerUrl(urlOf(cover), "piece-0"));
    expect(piece.status).toBe(200);
    expect(pngSize(await bytesOf(piece))).toEqual({ width: box.width, height: box.height });
    // The bit that doesn't move is still drawable on its own; a piece the look hasn't got isn't.
    expect((await get(cardLayerUrl(urlOf(cover), "piece-1"))).status).toBe(200);
    expect((await get(cardLayerUrl(urlOf(cover), "piece-9"))).status).toBe(400);
    expect((await get(`${urlOf(cover)}&layer=nope`)).status).toBe(400);
  }, 60_000);

  it("never let a part through for words the card didn't sign", async () => {
    const forged = new URL(cardLayerUrl(urlOf(cover), "words"));
    forged.searchParams.set("text", "Guaranteed results.");
    expect((await get(forged.toString())).status).toBe(403);
  });
});

describe("the samples, in the app's looks", () => {
  it("add a set for each look (its quote card, its 4:5 cover, its 9:16 announcement), none for a company", () => {
    const looks = [{ key: "party", name: "Party", about: "Balls and confetti" }];
    const sets = sampleCardSets(undefined, { looks });
    const party = sets.find((s) => s.key === "look-party");
    expect(party?.title).toBe("The Party look");
    expect(party?.about).toMatch(/^Balls and confetti\. /);
    expect(party?.specs.map((s) => [s.kind, s.size, s.look, s.page?.index ?? null])).toEqual([
      ["quote", "square", "party", null],
      ["cover", "portrait", "party", null],
      ["cover", "story", "party", 1],
      ["cover", "story", "party", 2],
      ["cta", "story", "party", 3],
    ]);
    expect(sampleCardSets(cardBrand({ name: "Green Acres", site: "green.example" }), { looks }).some((s) => s.key.startsWith("look-"))).toBe(false);
    expect(sampleCardSets().some((s) => s.key.startsWith("look-"))).toBe(false);
  });
});
