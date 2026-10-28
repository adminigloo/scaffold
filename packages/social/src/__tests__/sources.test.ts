import { describe, expect, it } from "vitest";
import { combineHonesty, genericHonesty, honestyFrom } from "../honesty.js";
import { fits, HOOK_MAX } from "../platforms.js";
import { hookOf, launchSource, parseHashtags, releaseSource } from "../sources.js";
import { PLATFORM_IDS } from "../types.js";
import { writePost } from "../writer.js";

/**
 * THE GENERIC SOURCES AND THE HONESTY LIST (../sources.ts, ../honesty.ts):
 * an announcement and a release become a draft for every platform that fits
 * it, in the business's own words when there's no AI; the honesty list
 * refuses hype, guarantees and pressure, and an app adds its own rules.
 */
const target = { author: "Maple & Rye", voice: null, day: "2026-10-27", link: "https://example.com/hours", images: () => [] };

describe("an announcement", () => {
  it("is the person's words for every platform, its first sentence the hook, and fits each one", async () => {
    const source = launchSource({ ...target, key: "launch:1", facts: "  We're open on Saturdays now, 9 to 1.   Weekday hours stay the same. " });
    expect(source.hook).toBe("We're open on Saturdays now, 9 to 1.");
    expect(source.facts).toMatchObject({ title: source.hook, lines: ["We're open on Saturdays now, 9 to 1. Weekday hours stay the same."] });
    expect(source.platforms).toEqual(PLATFORM_IDS);
    const written = await writePost(source, { complete: null });
    expect(written).toHaveLength(10);
    for (const w of written) expect(fits(w.platform, w.text), w.platform).toBe(true);
    // Reddit's title line is the hook.
    expect(written.find((w) => w.platform === "reddit")!.text.split("\n")[0]).toBe("We're open on Saturdays now, 9 to 1.");
  });

  it("cuts a hook that won't fit on the image at a whole word", () => {
    const hook = hookOf("Starting on the first of November we are open every single Saturday morning for pickups, drop-offs and anything else you need.");
    expect([...hook].length).toBeLessThanOrEqual(HOOK_MAX);
    expect(hook.endsWith("…")).toBe(true);
  });
});

describe("a release", () => {
  it("keeps whole lines: every item where there's room, the first few, then the first alone", async () => {
    const source = releaseSource({ ...target, release: { version: "2.4.0", title: "Online booking and reminders", items: ["Book online any time, day or night", "A text reminder the day before", "Move or cancel from the text", "Pay a deposit when you book"] } });
    expect(source.key).toBe("release:2.4.0");
    expect(source.template("x")[0]).toBe("Online booking and reminders (2.4.0)\n- Book online any time, day or night\n- A text reminder the day before\n- Move or cancel from the text\n- Pay a deposit when you book");
    expect(source.template("x").at(-1)).toBe("Online booking and reminders (2.4.0)\n- Book online any time, day or night");
    const written = await writePost(source, { complete: null });
    for (const w of written) expect(fits(w.platform, w.text), w.platform).toBe(true);
  });
});

describe("hashtags", () => {
  it("are code's: one word each, a # in front, no repeats in any case, five at most", () => {
    expect(parseHashtags("#bakery, new-menu  #Bakery #2026 sour_dough ## a b c d")).toEqual(["#bakery", "#newmenu", "#sour_dough", "#a", "#b"]);
    expect(parseHashtags("")).toEqual([]);
  });
});

describe("the honesty list", () => {
  it("refuses hype, guarantees, pressure and miracle claims, and lets plain words through", () => {
    expect(genericHonesty("Guaranteed fresh every morning.")).toBe("it read as a guarantee");
    expect(genericHonesty("A revolutionary new loaf.")).toBe("it read as hype (revolutionary)");
    expect(genericHonesty("Our bread is a game-changer.")).toBe("it read as hype (game-changing)");
    expect(genericHonesty("The best in town, hands down.")).toBe("it read as a claim to be the best");
    expect(genericHonesty("Hurry, before it's gone!")).toBe("it read as pressure to buy");
    expect(genericHonesty("This tea cures colds.")).toBe("it read as a health or miracle claim");
    expect(genericHonesty("Open Saturdays!!")).toBe("it read as shouting (!!)");
    expect(genericHonesty("We're open on Saturdays now, 9 to 1.")).toBeNull();
    expect(genericHonesty("The kettle is always on.")).toBeNull();
  });

  it("takes an app's own rules on top, the first reason winning", () => {
    const shop = honestyFrom([[/\bfree\b/i, "a promise of something free"]]);
    const check = combineHonesty(genericHonesty, shop, null, undefined);
    expect(check("Free coffee on Saturdays.")).toBe("it read as a promise of something free");
    expect(check("Guaranteed free coffee.")).toBe("it read as a guarantee");
    expect(check("Coffee on Saturdays.")).toBeNull();
  });
});
