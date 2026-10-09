import { describe, expect, it } from "vitest";
import {
  AI_ASSISTANT_DOMAINS,
  AI_ASSISTANT_UTM_SOURCES,
  AI_ENGINE_LABELS,
  AI_ENGINES,
  aiEngineOf,
  classifySource,
  referrerHostOf,
  SOURCE_CLASSIFIER_VERSION,
} from "../sources.js";
import { ASSISTANT_BOT_ENGINES, classifyCrawler } from "../crawlers.js";

const own = ["adminigloo.com"];
/** What ingest stores and classifies: the referrer HOST (never its path) plus the utm source. */
const visit = (referrer: string | null, utmSource?: string, utmMedium?: string) => {
  const referrerHost = referrerHostOf(referrer, own);
  return { bucket: classifySource({ referrerHost, utmSource, utmMedium }), engine: aiEngineOf({ referrerHost, utmSource }) };
};

describe("AI assistant traffic, by engine", () => {
  // [referrer as the browser sends it, utm_source, expected engine]
  const TABLE: Array<[string | null, string | undefined, string]> = [
    ["https://chatgpt.com/", undefined, "chatgpt"],
    ["https://chatgpt.com/c/68f0a1b2-secret-conversation", undefined, "chatgpt"],
    ["https://chat.openai.com/", undefined, "chatgpt"],
    [null, "chatgpt.com", "chatgpt"], // ChatGPT appends utm_source=chatgpt.com to the links it cites
    ["https://www.perplexity.ai/search/how-to-x", undefined, "perplexity"],
    [null, "perplexity.ai", "perplexity"],
    ["https://claude.ai/chat/abc", undefined, "claude"],
    [null, "claude.ai", "claude"],
    ["https://gemini.google.com/app", undefined, "gemini"],
    ["https://aistudio.google.com/prompts/new", undefined, "gemini"],
    ["https://notebooklm.google.com/notebook/x", undefined, "gemini"],
    ["https://copilot.microsoft.com/chats/x", undefined, "copilot"],
    ["https://copilot.cloud.microsoft/", undefined, "copilot"],
    ["https://you.com/search?q=x", undefined, "you"],
    ["https://www.phind.com/search?cache=x", undefined, "phind"],
    ["https://poe.com/chat/x", undefined, "poe"],
    ["https://www.meta.ai/", undefined, "meta"],
    ["https://chat.mistral.ai/chat/x", undefined, "mistral"],
    ["https://chat.deepseek.com/", undefined, "deepseek"],
    ["https://grok.com/chat/x", undefined, "grok"],
    ["https://duck.ai/", undefined, "duckai"],
    ["https://chat.qwen.ai/", undefined, "qwen"],
    ["https://www.kimi.com/", undefined, "kimi"],
    ["https://pi.ai/talk", undefined, "pi"],
    ["android-app://com.openai.chatgpt/", undefined, "chatgpt"],
    ["android-app://com.anthropic.claude/", undefined, "claude"],
    ["android-app://ai.perplexity.app.android/", undefined, "perplexity"],
    ["android-app://com.google.android.apps.bard/", undefined, "gemini"],
    ["android-app://com.microsoft.copilot/", undefined, "copilot"],
  ];

  it.each(TABLE)("%s (utm %s) is %s, in the AI assistants bucket", (referrer, utm, engine) => {
    expect(visit(referrer, utm)).toEqual({ bucket: "aiAssistant", engine });
  });

  it("reads hostnames only — a path never decides", () => {
    // Bing's Copilot answers on bing.com/chat, Google's AI Mode on google.com/search?udm=50:
    // the stored referrer is the host, and the host is a search engine.
    expect(visit("https://www.bing.com/chat?q=x")).toEqual({ bucket: "organic", engine: null });
    expect(visit("https://www.google.com/search?q=x&udm=50")).toEqual({ bucket: "organic", engine: null });
    // A path that names an engine on someone else's host is not that engine.
    expect(visit("https://example.org/chatgpt.com/claude.ai")).toEqual({ bucket: "referral", engine: null });
    expect(aiEngineOf("https://example.org/perplexity.ai")).toBeNull();
    // Lookalikes are not suffix matches.
    expect(aiEngineOf("notchatgpt.com")).toBeNull();
    expect(aiEngineOf("claude.ai.evil.example")).toBeNull();
    // Other Google and Microsoft properties stay what they were.
    expect(visit("https://docs.google.com/document/d/x")).toEqual({ bucket: "referral", engine: null });
    expect(visit("https://mail.google.com/mail/u/0/")).toEqual({ bucket: "email", engine: null });
  });

  it("lists a host only where the assistant IS that host and its subdomains — forums, docs, API platforms and app hubs are not AI", () => {
    // OpenAI's own subdomains are its community forum, help centre and developer platform.
    for (const referrer of ["https://openai.com/index/x", "https://community.openai.com/t/x", "https://help.openai.com/en/", "https://platform.openai.com/docs"]) {
      expect([referrer, visit(referrer)]).toEqual([referrer, { bucket: "referral", engine: null }]);
    }
    // DeepSeek's chat is chat.deepseek.com; platform. and api-docs. are for developers.
    for (const referrer of ["https://platform.deepseek.com/", "https://api-docs.deepseek.com/", "https://www.deepseek.com/"]) {
      expect([referrer, visit(referrer)]).toEqual([referrer, { bucket: "referral", engine: null }]);
    }
    // The Microsoft 365 app hub: Copilot Chat is only a PATH there, and a path is never read (the bing.com/chat rule).
    expect(visit("https://m365.cloud.microsoft/chat")).toEqual({ bucket: "referral", engine: null });
    // The assistants themselves still are.
    expect(visit("https://chat.openai.com/").engine).toBe("chatgpt");
    expect(visit("https://chat.deepseek.com/a/chat/s/x").engine).toBe("deepseek");
    // A utm_source still names them, whatever the host.
    expect(visit("https://community.openai.com/t/x", "chatgpt.com")).toEqual({ bucket: "aiAssistant", engine: "chatgpt" });
  });

  it("keeps the 0.1 element types: a domain or utm source from the lists is a literal, not any string", () => {
    const domain: (typeof AI_ASSISTANT_DOMAINS)[number] = "chatgpt.com";
    const utm: (typeof AI_ASSISTANT_UTM_SOURCES)[number] = "perplexity.ai";
    // @ts-expect-error — not an AI assistant's host
    const notADomain: (typeof AI_ASSISTANT_DOMAINS)[number] = "example.com";
    // @ts-expect-error — not an AI assistant's utm_source
    const notAUtm: (typeof AI_ASSISTANT_UTM_SOURCES)[number] = "newsletter";
    expect([domain, utm, notADomain, notAUtm]).toHaveLength(4);
  });

  it("takes one string as a referrer URL, a host, or a utm_source", () => {
    expect(aiEngineOf("https://www.perplexity.ai/search/x")).toBe("perplexity");
    expect(aiEngineOf("claude.ai")).toBe("claude");
    expect(aiEngineOf("chatgpt")).toBe("chatgpt");
    expect(aiEngineOf("  Perplexity  ")).toBe("perplexity");
    expect(aiEngineOf("")).toBeNull();
    expect(aiEngineOf(null)).toBeNull();
    expect(aiEngineOf({ referrerHost: null, utmSource: null })).toBeNull();
  });

  it("a utm_source naming an engine wins over the host it arrived from", () => {
    expect(aiEngineOf({ referrerHost: "chatgpt.com", utmSource: "perplexity" })).toBe("perplexity");
    expect(aiEngineOf({ referrerHost: "chatgpt.com", utmSource: "newsletter" })).toBe("chatgpt");
  });

  it("keeps the classifier's priority: a paid or emailed link from an AI host is paid or email", () => {
    expect(visit("https://chatgpt.com/", "chatgpt.com", "cpc").bucket).toBe("paid");
    expect(visit("https://chatgpt.com/", "digest", "email").bucket).toBe("email");
  });

  it("every engine host and utm source is in the classifier's lists, and every engine has a label", () => {
    for (const engine of AI_ENGINES) {
      for (const host of engine.hosts) expect(AI_ASSISTANT_DOMAINS).toContain(host);
      for (const utm of engine.utmSources) {
        expect(AI_ASSISTANT_UTM_SOURCES).toContain(utm);
        expect(utm).toBe(utm.toLowerCase());
      }
      expect(AI_ENGINE_LABELS[engine.id]).toBe(engine.label);
    }
    const ids = AI_ENGINES.map((engine) => engine.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No host belongs to two engines.
    const hosts = AI_ENGINES.flatMap((engine) => engine.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("names each assistant's live-fetch bot after its engine", () => {
    for (const [bot, engine] of Object.entries(ASSISTANT_BOT_ENGINES)) {
      expect(AI_ENGINES.map((e) => e.id as string)).toContain(engine);
      expect(classifyCrawler(`Mozilla/5.0 (compatible; ${bot}/1.0)`)).toMatchObject({ name: bot, kind: "ai-assistant" });
    }
  });

  it("is classifier version 2 (0.1 rows carry null)", () => {
    expect(SOURCE_CLASSIFIER_VERSION).toBe(2);
  });
});

describe("the site's own SEO audit", () => {
  it("is a bot, never a visitor", () => {
    expect(classifyCrawler("adminigloo-seo-reports/0.1")).toMatchObject({ name: "AdminIgloo audit", kind: "seo-tool" });
  });
});
