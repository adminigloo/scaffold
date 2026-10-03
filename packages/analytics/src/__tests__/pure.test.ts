import { describe, expect, it } from "vitest";
import { classifySource, clickIdKindOf, referrerHostOf } from "../sources.js";
import { classifyCrawler, isAiCrawlerKind } from "../crawlers.js";
import { contentOf, hmacHex, isEngaged, looksLikeToken, normalizePath, parseUserAgent } from "../visitor.js";
import { dayIn, scrubLabel, scrubUtm } from "../ingest.js";
import { createCrawlerVerifier, extractPrefixes, ipInRange, parseCidr } from "../verify.js";
import { rateWebVital, summarizeWebVitals } from "../vitals.js";
import { daysIn, deltaPct, kpi, lastDays, priorPeriod, zeroFill } from "../periods.js";

const own = ["adminigloo.com"];
const src = (referrer: string | null, utm: { source?: string; medium?: string } = {}, clickIdKind: "gclid" | null = null) =>
  classifySource({ referrerHost: referrerHostOf(referrer, own), utmSource: utm.source, utmMedium: utm.medium, clickIdKind });

describe("classifySource", () => {
  it("buckets the common referrers", () => {
    expect(src("https://www.google.com/")).toBe("organic");
    expect(src("https://www.google.co.uk/search?q=x")).toBe("organic");
    expect(src("https://duckduckgo.com/")).toBe("organic");
    expect(src("https://search.brave.com/search?q=x")).toBe("organic");
    expect(src("https://chatgpt.com/")).toBe("aiAssistant");
    expect(src("https://www.perplexity.ai/search/abc")).toBe("aiAssistant");
    expect(src("https://claude.ai/chat/123")).toBe("aiAssistant");
    expect(src("https://gemini.google.com/app")).toBe("aiAssistant");
    expect(src("https://lm.facebook.com/l.php?u=x")).toBe("social");
    expect(src("https://t.co/abc")).toBe("social");
    expect(src("https://www.linkedin.com/feed/")).toBe("social");
    expect(src("https://news.ycombinator.com/item?id=1")).toBe("social");
    expect(src("https://mail.google.com/mail/u/0/")).toBe("email");
    expect(src("https://docs.google.com/document/d/x")).toBe("referral");
    expect(src("https://somebody.dev/post")).toBe("referral");
    expect(src(null)).toBe("direct");
  });

  it("treats your own site as no referrer at all", () => {
    expect(src("https://adminigloo.com/pricing")).toBe("direct");
    expect(src("https://www.adminigloo.com/")).toBe("direct");
  });

  it("follows the priority order: offline > paid > email > AI > search > social > referral > direct", () => {
    expect(src("https://www.google.com/", { source: "qr", medium: "physical" })).toBe("offline");
    expect(src("https://www.google.com/", {}, "gclid")).toBe("paid");
    expect(src("https://www.facebook.com/", { medium: "paid_social" })).toBe("paid");
    expect(src(null, { source: "newsletter", medium: "email" })).toBe("email");
    expect(src(null, { source: "chatgpt" })).toBe("aiAssistant");
    expect(src(null, { source: "some-partner" })).toBe("referral");
  });

  it("reads android app referrers", () => {
    expect(src("android-app://com.google.android.googlequicksearchbox/")).toBe("organic");
    expect(src("android-app://com.google.android.gm/")).toBe("email");
    expect(src("android-app://com.linkedin.android/")).toBe("social");
  });

  it("keeps only the referrer host — never its path or query", () => {
    expect(referrerHostOf("https://www.google.com/search?q=secret+thing", own)).toBe("google.com");
    expect(referrerHostOf("not a url ::", own)).toBeNull();
  });

  it("notes which ad click id was present, never its value", () => {
    expect(clickIdKindOf(new URLSearchParams("gclid=abc123&x=1"))).toBe("gclid");
    expect(clickIdKindOf(new URLSearchParams("fbclid=zzz"))).toBe("fbclid");
    expect(clickIdKindOf(new URLSearchParams("q=1"))).toBeNull();
  });
});

describe("classifyCrawler", () => {
  it("tells the AI kinds apart, specific before generic", () => {
    expect(classifyCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot")).toMatchObject({ name: "ChatGPT-User", kind: "ai-assistant" });
    expect(classifyCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot")).toMatchObject({ name: "GPTBot", kind: "ai-training" });
    expect(classifyCrawler("Mozilla/5.0; compatible; OAI-SearchBot/1.0")).toMatchObject({ kind: "ai-search" });
    expect(classifyCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)")).toMatchObject({ name: "ClaudeBot", kind: "ai-training" });
    expect(classifyCrawler("Claude-User/1.0")).toMatchObject({ kind: "ai-assistant" });
    expect(classifyCrawler("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toMatchObject({ kind: "ai-search" });
    expect(classifyCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toMatchObject({ name: "Googlebot", kind: "search" });
    expect(classifyCrawler("facebookexternalhit/1.1")).toMatchObject({ kind: "social" });
    expect(classifyCrawler("Mozilla/5.0 (compatible; AhrefsBot/7.0)")).toMatchObject({ kind: "seo-tool" });
    expect(classifyCrawler("python-requests/2.31")).toMatchObject({ kind: "other" });
  });

  it("leaves real browsers alone", () => {
    expect(classifyCrawler("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBeNull();
    expect(classifyCrawler("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBeNull();
    expect(classifyCrawler(null)).toBeNull();
  });

  it("knows which kinds are AI", () => {
    expect(isAiCrawlerKind("ai-assistant")).toBe(true);
    expect(isAiCrawlerKind("search")).toBe(false);
  });
});

describe("parseUserAgent", () => {
  it("reads coarse families", () => {
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toEqual({ device: "mobile", browser: "Safari", os: "iOS" });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toEqual({ device: "desktop", browser: "Edge", os: "Windows" });
    expect(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toMatchObject({ device: "tablet", os: "iOS" });
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toEqual({ device: "mobile", browser: "Chrome", os: "Android" });
  });
});

describe("normalizePath", () => {
  it("drops the query and hash, where tokens and search terms live", () => {
    expect(normalizePath("/checkout/success?session_id=cs_test_abc123")).toBe("/checkout/success");
    expect(normalizePath("/pricing#faq")).toBe("/pricing");
  });

  it("redacts capability tokens but keeps readable slugs", () => {
    expect(normalizePath("/invoice/Zk3q9fQx2LmN8pR4tV7wY1bC")).toBe("/invoice/:token");
    expect(normalizePath("/invite/01a0f981-c172-7f38-9c77-1eb69a66739e")).toBe("/invite/:token");
    expect(normalizePath("/features/feedback")).toBe("/features/feedback");
    expect(normalizePath("/blog/release-notes-2026-09-30")).toBe("/blog/release-notes-2026-09-30");
    expect(normalizePath("/blog/how-we-built-a-feedback-widget")).toBe("/blog/how-we-built-a-feedback-widget");
    expect(looksLikeToken("averyveryverylongsluglikethis")).toBe(false);
  });

  it("applies app patterns first, and trims a trailing slash", () => {
    expect(normalizePath("/products/blue-shirt/", [{ pattern: /^\/products\/[^/]+/, replace: "/products/:slug" }])).toBe("/products/:slug");
    expect(normalizePath("/")).toBe("/");
  });

  it("reads a content dimension from the path", () => {
    expect(contentOf("/features/feedback", [{ type: "feature", pattern: /^\/features\/([^/]+)/ }])).toEqual({ type: "feature", key: "feedback" });
    expect(contentOf("/pricing", [{ type: "feature", pattern: /^\/features\/([^/]+)/ }])).toBeNull();
  });
});

describe("engagement (GA4, pinned)", () => {
  it("is 10 seconds, or 2 page views, or a conversion", () => {
    expect(isEngaged({ durationMs: 9_999, pageViewCount: 1 })).toBe(false);
    expect(isEngaged({ durationMs: 10_000, pageViewCount: 1 })).toBe(true);
    expect(isEngaged({ durationMs: 0, pageViewCount: 2 })).toBe(true);
    expect(isEngaged({ durationMs: 0, pageViewCount: 1, converted: true })).toBe(true);
  });
});

describe("the visitor key building blocks", () => {
  it("hmacHex is stable, 32 hex, and changes with the key or the message", async () => {
    const a = await hmacHex("salt-a", "203.0.113.7\u0000UA\u0000t1");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await hmacHex("salt-a", "203.0.113.7\u0000UA\u0000t1")).toBe(a);
    expect(await hmacHex("salt-b", "203.0.113.7\u0000UA\u0000t1")).not.toBe(a);
    expect(await hmacHex("salt-a", "203.0.113.7\u0000UA\u0000t2")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("dayIn rolls over at the configured zone's midnight", () => {
    const at = new Date("2026-10-03T03:30:00Z"); // 21:30 on the 2nd in Denver
    expect(dayIn(at, "UTC")).toBe("2026-10-03");
    expect(dayIn(at, "America/Denver")).toBe("2026-10-02");
    expect(dayIn(at, "Not/AZone")).toBe("2026-10-03");
  });
});

describe("scrubbing", () => {
  it("drops labels that carry a person or a secret", () => {
    expect(scrubLabel("Email code to someone@gmail.com")).toBeNull();
    expect(scrubLabel("Call +1 (801) 555-0134")).toBeNull();
    expect(scrubLabel("Open inv_0f3a9c2b7d1e4f5a6b8c9d0e1f2a3b4c5d6e")).toBeNull();
    expect(scrubLabel("  Press   the demo  ")).toBe("Press the demo");
    expect(scrubLabel("")).toBeNull();
  });

  it("keeps campaign names and refuses subscriber ids in UTM values", () => {
    expect(scrubUtm("spring-launch_2026")).toBe("spring-launch_2026");
    expect(scrubUtm("someone@example.com")).toBeNull();
    expect(scrubUtm("sub_9fK2mQ7xLp3RtV8wZy4B6nD1")).toBeNull();
    expect(scrubUtm("<script>alert(1)</script>")).toBe("scriptalert1/script");
    expect(scrubUtm("x".repeat(300))?.length).toBe(100);
  });

  it("redacts the app's real token shapes from paths (invoice and invite)", () => {
    const invoice = "inv_" + "0f3a9c2b7d1e4f5a6b8c9d0e1f2a3b4c5d6e";
    const invite = "Zk3q9fQx2LmN8pR4tV7wY1bC_aB-cD3eF5gH7iJ9kL0";
    expect(normalizePath(`/invoice/${invoice}`)).toBe("/invoice/:token");
    expect(normalizePath(`/invite/${invite}`)).toBe("/invite/:token");
    expect(normalizePath("/checkout/success?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x")).toBe("/checkout/success");
  });
});

describe("crawler verification", () => {
  it("matches IPv4 and IPv6 ranges", () => {
    const v4 = parseCidr("20.171.206.0/24")!;
    expect(ipInRange("20.171.206.17", v4)).toBe(true);
    expect(ipInRange("20.171.207.1", v4)).toBe(false);
    expect(ipInRange("::ffff:20.171.206.17", v4)).toBe(true);
    const v6 = parseCidr("2001:4860:4801:10::/64")!;
    expect(ipInRange("2001:4860:4801:10::1", v6)).toBe(true);
    expect(ipInRange("2001:4860:4801:11::1", v6)).toBe(false);
    expect(parseCidr("nonsense")).toBeNull();
  });

  it("reads the published list shape", () => {
    expect(extractPrefixes({ creationTime: "x", prefixes: [{ ipv4Prefix: "1.2.3.0/24" }, { ipv6Prefix: "2001:db8::/32" }] })).toEqual(["1.2.3.0/24", "2001:db8::/32"]);
  });

  it("verifies only from inside the operator's ranges, and never on a failed fetch", async () => {
    const fetchImpl = (async (url: string) =>
      url.includes("gptbot")
        ? new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: "20.171.206.0/24" }] }))
        : new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const verifier = createCrawlerVerifier({ fetchImpl });
    expect(await verifier.verify("GPTBot", "20.171.206.17")).toBe(true);
    expect(await verifier.verify("GPTBot", "203.0.113.9")).toBe(false);
    expect(await verifier.verify("PerplexityBot", "20.171.206.17")).toBe(false);
    expect(await verifier.verify("ClaudeBot", "20.171.206.17")).toBe(false);
    expect(await verifier.verify("GPTBot", null)).toBe(false);
  });
});

describe("web vitals", () => {
  it("rates at Google's boundaries, boundary values in the better bucket", () => {
    expect(rateWebVital("LCP", 2500)).toBe("good");
    expect(rateWebVital("LCP", 2501)).toBe("needs-improvement");
    expect(rateWebVital("INP", 501)).toBe("poor");
    expect(rateWebVital("CLS", 0.1)).toBe("good");
  });

  it("always reports all three metrics", () => {
    const summary = summarizeWebVitals([{ metric: "LCP", p75: "1800", samples: "12" }, { metric: "bogus", p75: 1, samples: 1 }]);
    expect(summary.map((s) => s.metric)).toEqual(["LCP", "INP", "CLS"]);
    expect(summary[0]).toEqual({ metric: "LCP", p75: 1800, samples: 12, rating: "good" });
    expect(summary[1]).toEqual({ metric: "INP", p75: null, samples: 0, rating: null });
  });
});

describe("periods", () => {
  it("'last 7 days' is exactly 7 days, today included", () => {
    const range = lastDays(7, new Date("2026-10-02T15:00:00Z"));
    expect(daysIn(range)).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("the prior period is the same length, immediately before", () => {
    const range = lastDays(7, new Date("2026-10-02T15:00:00Z"));
    const prior = priorPeriod(range);
    expect(daysIn(prior)).toHaveLength(7);
    expect(prior.to.getTime()).toBe(range.from.getTime());
  });

  it("never invents an infinite delta", () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBe(0);
    expect(deltaPct(15, 10)).toBe(50);
    expect(kpi(12, 6)).toEqual({ current: 12, prior: 6, deltaPct: 100, smallSample: true });
  });

  it("zero-fills days with no rows", () => {
    const range = lastDays(3, new Date("2026-10-02T15:00:00Z"));
    const filled = zeroFill(range, [{ date: "2026-10-01", n: 4 }], (date) => ({ date, n: 0 }));
    expect(filled).toEqual([{ date: "2026-09-30", n: 0 }, { date: "2026-10-01", n: 4 }, { date: "2026-10-02", n: 0 }]);
  });
});

describe("zone-aligned ranges", () => {
  it("gives exactly N local days, midnight to midnight, across a DST change", async () => {
    const { lastDays, startOfDayIn, dayInZone } = await import("../periods.js");
    // Denver, a day after the November DST change.
    const now = new Date("2026-11-02T18:00:00Z");
    const range = lastDays(30, now, "America/Denver");
    expect(range.to.toISOString()).toBe("2026-11-03T07:00:00.000Z"); // MST midnight
    expect(range.from.toISOString()).toBe("2026-10-04T06:00:00.000Z"); // MDT midnight
    expect(dayInZone(range.from, "America/Denver")).toBe("2026-10-04");
    expect(dayInZone(new Date(range.to.getTime() - 1), "America/Denver")).toBe("2026-11-02");
    expect(startOfDayIn("2026-03-08", "America/Denver").toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(startOfDayIn("2026-03-09", "America/Denver").toISOString()).toBe("2026-03-09T06:00:00.000Z");
    // UTC stays exactly what it was.
    expect(lastDays(7, new Date("2026-10-02T12:00:00Z")).from.toISOString()).toBe("2026-09-26T00:00:00.000Z");
  });
});

describe("self-referrals", () => {
  it("treats the site's own host as no referrer, whatever port the host list carries", async () => {
    const { referrerHostOf } = await import("../sources.js");
    expect(referrerHostOf("http://localhost:3000/pricing", ["localhost:3000"])).toBeNull();
    expect(referrerHostOf("localhost", ["localhost:3500"])).toBeNull();
    expect(referrerHostOf("https://www.adminigloo.com/", ["adminigloo.com"])).toBeNull();
    expect(referrerHostOf("https://news.ycombinator.com/item?id=1", ["adminigloo.com"])).toBe("news.ycombinator.com");
  });
});
