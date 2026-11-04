import { describe, expect, it } from "vitest";
import { linkTagsOf, postLinkTags, SOCIAL_MEDIUM, taggedLink } from "../links.js";
import { fits, PLATFORMS } from "../platforms.js";
import type { Platform, PostSource } from "../types.js";
import { writePost } from "../writer.js";

/**
 * EVERY POST'S LINK, TAGGED (src/social/links.ts, the marketer review's
 * change 2): the platform, "social", the post's kind and its key on the link
 * wherever the platform shows it, never on an image, and every draft still
 * within its platform's length with the tagged link in place.
 */
const LINK = "https://example.com/weather/settled/2026-10-26";
const tags = postLinkTags("threads", { kind: "results", key: "results:2026-10-26" });

describe("a tagged link", () => {
  it("carries the platform, social, the kind and the key", () => {
    expect(tags).toEqual({ source: "threads", medium: SOCIAL_MEDIUM, campaign: "results", content: "results:2026-10-26" });
    expect(taggedLink(LINK, tags)).toBe(`${LINK}?utm_source=threads&utm_medium=social&utm_campaign=results&utm_content=results%3A2026-10-26`);
    expect(linkTagsOf(taggedLink(LINK, tags))).toEqual(tags);
  });

  it("keeps the page's own query and its #part, and replaces any tag it already had", () => {
    const tagged = taggedLink("https://example.com/pricing?plan=weather-basic&utm_source=old&UTM_TERM=x#founding", tags);
    expect(tagged).toBe("https://example.com/pricing?plan=weather-basic&utm_source=threads&utm_medium=social&utm_campaign=results&utm_content=results%3A2026-10-26#founding");
    expect(new URL(tagged).searchParams.getAll("utm_source")).toEqual(["threads"]);
  });

  it("gives back an address it can't read as one, untagged: the link still works", () => {
    expect(taggedLink("/weather", tags)).toBe("/weather");
    expect(taggedLink("mailto:hi@example.com", tags)).toBe("mailto:hi@example.com");
    expect(linkTagsOf("not a link")).toBeNull();
    expect(linkTagsOf(LINK)).toBeNull();
  });

  it("a site's bare address gets its slash, then the tags", () => {
    expect(taggedLink("https://example.com", tags)).toBe("https://example.com/?utm_source=threads&utm_medium=social&utm_campaign=results&utm_content=results%3A2026-10-26");
  });
});

const ALL: readonly Platform[] = ["x", "threads", "bluesky", "telegram", "discord", "linkedin", "facebook", "instagram", "tiktok", "reddit"];

const source: PostSource = {
  key: "results:2026-10-26",
  kind: "results",
  author: "Al",
  voice: null,
  day: "2026-10-27",
  facts: { title: "How the highs settled on Oct 26", lines: ["The favorite came in for 17 of 24 cities.", "Biggest upset: Denver, a 70¢ favorite."] },
  platforms: ALL,
  hook: "Oct 26: 17 of 24 favorites came in.",
  linkUrl: LINK,
  linkLabel: "Every city",
  hashtags: ["#Kalshi", "#weather", "#data"],
  template: (p) =>
    p === "reddit"
      ? ["Oct 26's results\n\n17 of 24 favorites came in. Biggest upset: Denver, a 70¢ favorite."]
      : ["17 of 24 favorites came in. Biggest upset: Denver, a 70¢ favorite. The rest of the cities settled where the market said they would, give or take a degree.", "17 of 24 favorites came in."],
  images: (p) => (p === "reddit" ? [] : [{ url: `https://example.com/card/${p}.png`, alt: "The hook", width: 1080, height: 1080 }]),
};

const tagOf = (p: Platform) => `utm_source=${p}&utm_medium=social&utm_campaign=results&utm_content=results%3A2026-10-26`;

describe("the writer, asked to tag links", () => {
  it("tags the first comment on X and LinkedIn, the link card on Bluesky, the text elsewhere, never an image or a bio-link caption", async () => {
    const written = await writePost(source, { complete: null, tagLinks: true });
    expect(written).toHaveLength(ALL.length);
    for (const w of written) {
      const rule = PLATFORMS[w.platform];
      if (rule.linkIn === "comment") {
        expect(w.firstComment).toBe(`Every city: ${LINK}?${tagOf(w.platform)}`);
        expect(w.text).not.toContain("https://");
      }
      if (rule.linkIn === "text") {
        // The link, then the hashtags where the platform takes them.
        expect(w.text).toContain(`\n\nEvery city: ${LINK}?${tagOf(w.platform)}`);
        expect(w.firstComment).toBeNull();
      }
      if (rule.linkIn === "card") {
        // Bluesky (social 0.2): no address in the text; the draft keeps the tagged link for its card.
        expect(w.text).not.toContain("https://");
        expect(w.firstComment).toBeNull();
        expect(w.linkUrl).toBe(`${LINK}?${tagOf(w.platform)}`);
      }
      if (rule.linkIn === "bio") {
        expect(w.text).toContain("Link in bio.");
        expect(w.text).not.toContain("https://");
      }
      // The cards are drawn as they were: no tag on any image.
      expect(w.images.every((i) => !i.url.includes("utm_"))).toBe(true);
      // Its own template is tagged the same way, so going back to it keeps the tag.
      if (rule.linkIn === "text") expect(w.templateText).toContain(tagOf(w.platform));
      expect(fits(w.platform, w.text)).toBe(true);
    }
  });

  it("fits every platform with the longer link in place; Bluesky's link card leaves its 300 to the words", async () => {
    const plain = await writePost(source, { complete: null });
    const tagged = await writePost(source, { complete: null, tagLinks: true });
    const bluesky = (ws: typeof plain) => ws.find((w) => w.platform === "bluesky")!.text;
    // Bluesky counts the whole address, so in 0.1 the tagged link left room for the short version only. Its link
    // is a card now: the long version fits tagged or not, with its three hashtags.
    expect(bluesky(plain)).toContain("give or take a degree");
    expect(bluesky(tagged)).toBe(bluesky(plain));
    expect(bluesky(tagged).endsWith("#Kalshi #weather #data")).toBe(true);
    // X counts any link as 23 whatever its length, and its link is in the comment anyway: the text is the same.
    expect(tagged.find((w) => w.platform === "x")!.text).toBe(plain.find((w) => w.platform === "x")!.text);
  });

  it("leaves the link as the source gave it when not asked", async () => {
    const written = await writePost(source, { complete: null });
    expect(written.find((w) => w.platform === "x")!.firstComment).toBe(`Every city: ${LINK}`);
    expect(written.every((w) => !`${w.text}${w.firstComment ?? ""}`.includes("utm_"))).toBe(true);
  });

  it("has nothing to tag on a post with no link", async () => {
    const written = await writePost({ ...source, linkUrl: null }, { complete: null, tagLinks: true });
    expect(written.every((w) => w.firstComment === null && !w.text.includes("https://") && !w.text.includes("Link in bio."))).toBe(true);
  });

  it("tags the AI's words the same way in words mode, and measures them with the tagged link", async () => {
    const answer = JSON.stringify({ hook: "17 of 24.", ...Object.fromEntries(ALL.map((p) => [p, p === "reddit" ? "Oct 26: 17 of 24\n\n17 of 24 favorites came in." : "17 of 24 favorites came in."])) });
    const asked: string[] = [];
    const written = await writePost({ ...source, voice: "You are Al." }, {
      complete: async ({ prompt }) => {
        asked.push(prompt);
        return answer;
      },
      tagLinks: true,
    });
    expect(written.find((w) => w.platform === "threads")).toMatchObject({ writtenBy: "ai", text: `17 of 24 favorites came in.\n\nEvery city: ${LINK}?${tagOf("threads")}\n\n#Kalshi` });
    // The room the AI is offered already leaves space for the longer link.
    const room = (prompt: string, p: Platform) => Number(new RegExp(`- ${p}: at most (\\d+) characters`).exec(prompt)?.[1]);
    const untaggedAsk: string[] = [];
    await writePost({ ...source, voice: "You are Al." }, {
      complete: async ({ prompt }) => {
        untaggedAsk.push(prompt);
        return answer;
      },
    });
    expect(room(asked[0]!, "threads")).toBeLessThan(room(untaggedAsk[0]!, "threads"));
    // Bluesky's link is a card: the tag takes none of its room.
    expect(room(asked[0]!, "bluesky")).toBe(room(untaggedAsk[0]!, "bluesky"));
    expect(room(asked[0]!, "x")).toBe(room(untaggedAsk[0]!, "x"));
  });
});
