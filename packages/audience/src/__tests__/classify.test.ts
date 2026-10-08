import { describe, expect, it } from "vitest";
import {
  allMatches,
  classify,
  markScopeOf,
  REASON_ORDER,
  REASON_FOR_KIND,
  RULE_KINDS,
  resolveDefaults,
  ruleMatchesUser,
  type ActorFacts,
  type AudienceRule,
  type ClassifyOptions,
  type RuleKind,
} from "../core.js";

let n = 0;
function rule(kind: RuleKind, value: string, extra: Partial<AudienceRule> = {}): AudienceRule {
  n += 1;
  return {
    id: `r${n}`,
    tenantId: "t",
    kind,
    value,
    reasonLabel: null,
    note: null,
    createdBy: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    disabledAt: null,
    disabledBy: null,
    appliesFrom: null,
    ...extra,
  };
}

const NONE = resolveDefaults(false);
const ALL = resolveDefaults(undefined);
const opts = (rules: AudienceRule[] = [], extra: Partial<ClassifyOptions> = {}): ClassifyOptions => ({
  rules,
  defaults: NONE,
  foldGmail: true,
  ...extra,
});
const reasonOf = (facts: ActorFacts, options: ClassifyOptions) => classify(facts, options)?.reason ?? null;

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

describe("every rule kind matches what it names, and nothing else", () => {
  it("user: the user id, exactly", () => {
    const r = rule("user", "user_rachel");
    expect(classify({ userId: "user_rachel" }, opts([r]))).toMatchObject({ reason: "named_user", ruleId: r.id });
    expect(classify({ userId: "user_rachel2" }, opts([r]))).toBeNull();
    expect(classify({ userId: "USER_RACHEL" }, opts([r]))).toBeNull();
  });

  it("email: trimmed, lower-cased, Gmail dots and +tags folded", () => {
    const r = rule("email", "jane.doe@gmail.com");
    for (const email of ["jane.doe@gmail.com", " JANE.DOE@gmail.com ", "janedoe@gmail.com", "j.a.n.e.d.o.e+promo@googlemail.com"]) {
      expect(reasonOf({ email }, opts([r])), email).toBe("email");
    }
    expect(reasonOf({ email: "jane.doe@example.org" }, opts([r]))).toBeNull();
    expect(reasonOf({ email: "jane.doe2@gmail.com" }, opts([r]))).toBeNull();
  });

  it("email: folding is Gmail-only, and can be turned off", () => {
    const outlook = rule("email", "jane@outlook.com");
    expect(reasonOf({ email: "jane+x@outlook.com" }, opts([outlook]))).toBeNull();
    const gmail = rule("email", "janedoe@gmail.com");
    expect(reasonOf({ email: "jane.doe@gmail.com" }, opts([gmail], { foldGmail: false }))).toBeNull();
    expect(reasonOf({ email: "janedoe@gmail.com" }, opts([gmail], { foldGmail: false }))).toBe("email");
  });

  it("email_domain: the domain and its subdomains, never a lookalike", () => {
    const r = rule("email_domain", "riddlergo.com");
    expect(reasonOf({ email: "rachel@riddlergo.com" }, opts([r]))).toBe("domain");
    expect(reasonOf({ email: "ops@mail.riddlergo.com" }, opts([r]))).toBe("domain");
    expect(reasonOf({ email: "x@notriddlergo.com" }, opts([r]))).toBeNull();
    expect(reasonOf({ email: "x@riddlergo.com.evil.io" }, opts([r]))).toBeNull();
  });

  it("email_pattern: a substring, or a glob over the whole address", () => {
    const sub = rule("email_pattern", "riddlerroadrally");
    expect(reasonOf({ email: "qa.riddlerroadrally@gmail.com" }, opts([sub]))).toBe("pattern");
    const glob = rule("email_pattern", "qa-*@*");
    expect(reasonOf({ email: "qa-17@foo.io" }, opts([glob]))).toBe("pattern");
    expect(reasonOf({ email: "xqa-17@foo.io" }, opts([glob]))).toBeNull();
    // A pattern is matched on the UNFOLDED address, so a Gmail +tag survives.
    const plus = rule("email_pattern", "+qa@");
    expect(reasonOf({ email: "dallin+qa@gmail.com" }, opts([plus]))).toBe("pattern");
  });

  it("org, event, order: by id", () => {
    const org = rule("org", "org_staff");
    const event = rule("event", "evt_test");
    const order = rule("order", "ord_test");
    expect(reasonOf({ orgIds: ["org_a", "org_staff"] }, opts([org]))).toBe("org");
    expect(reasonOf({ orgIds: ["org_a"] }, opts([org]))).toBeNull();
    expect(reasonOf({ eventId: "evt_test" }, opts([event]))).toBe("event");
    expect(reasonOf({ orderId: "ord_test" }, opts([order]))).toBe("order");
    expect(reasonOf({ orderId: "ord_real" }, opts([order]))).toBeNull();
  });

  it("visitor: one device", () => {
    const r = rule("visitor", "v-123");
    expect(reasonOf({ visitorId: "v-123" }, opts([r]))).toBe("device");
    expect(reasonOf({ visitorId: "v-1234" }, opts([r]))).toBeNull();
  });

  it("network: IPv4 and IPv6 ranges, mapped and bracketed forms, never a neighbour", () => {
    const v4 = rule("network", "203.0.113.0/24");
    const v6 = rule("network", "2001:db8::/32");
    expect(reasonOf({ ip: "203.0.113.77" }, opts([v4]))).toBe("network");
    expect(reasonOf({ ip: "::ffff:203.0.113.77" }, opts([v4]))).toBe("network");
    expect(reasonOf({ ip: "203.0.113.77:51234" }, opts([v4]))).toBe("network");
    expect(reasonOf({ ip: "203.0.114.1" }, opts([v4]))).toBeNull();
    expect(reasonOf({ ip: "2001:db8:abcd::1" }, opts([v6]))).toBe("network");
    expect(reasonOf({ ip: "[2001:db8::5]" }, opts([v6]))).toBe("network");
    expect(reasonOf({ ip: "2001:db9::1" }, opts([v6]))).toBeNull();
    expect(reasonOf({ ip: "not an ip" }, opts([v4, v6]))).toBeNull();
  });

  it("host: an allow-list — once one exists, every other host is non-production", () => {
    const prod = rule("host", "riddlergo.com");
    const www = rule("host", "www.riddlergo.com");
    expect(reasonOf({ host: "riddlergo.com" }, opts([prod, www]))).toBeNull();
    expect(reasonOf({ host: "WWW.riddlergo.com:443" }, opts([prod, www]))).toBeNull();
    expect(reasonOf({ host: "staging.riddlergo.com" }, opts([prod, www]))).toBe("non_production");
    // No host known: fails open (counted).
    expect(reasonOf({ host: null }, opts([prod]))).toBeNull();
    // No allow-list at all: only the defaults' deny-list applies.
    expect(reasonOf({ host: "staging.riddlergo.com" }, opts([]))).toBeNull();
  });

  it("user_agent: a case-insensitive substring", () => {
    const r = rule("user_agent", "mymonitor");
    expect(classify({ userAgent: "Mozilla/5.0 (MyMonitor 2.1)" }, opts([r]))).toMatchObject({ reason: "automation", ruleId: r.id });
    expect(reasonOf({ userAgent: CHROME }, opts([r]))).toBeNull();
  });

  it("covers every kind and maps each to its reason", () => {
    expect(Object.keys(REASON_FOR_KIND).sort()).toEqual([...RULE_KINDS].sort());
  });

  it("disabled rules never match", () => {
    const r = rule("email", "jane@x.io", { disabledAt: new Date() });
    expect(reasonOf({ email: "jane@x.io" }, opts([r]))).toBeNull();
  });
});

describe("the app's callback", () => {
  it("a label is the role reason; false/empty is counted", () => {
    expect(classify({ roleLabel: "platform role: staff" }, opts())).toMatchObject({ reason: "role", ruleId: null, detail: "platform role: staff", personal: true });
    expect(classify({ roleLabel: false }, opts())).toBeNull();
    expect(classify({ roleLabel: "   " }, opts())).toBeNull();
  });
});

describe("defaults with no configuration", () => {
  it("test sign-ups and reserved domains", () => {
    expect(reasonOf({ email: "dallin+clerk_test@example.com" }, opts([], { defaults: ALL }))).toBe("domain");
    expect(reasonOf({ email: "dallin+clerk_test@gmail.com" }, opts([], { defaults: ALL }))).toBe("pattern");
    expect(reasonOf({ email: "qa+test@gmail.com" }, opts([], { defaults: ALL }))).toBe("pattern");
    for (const email of ["a@example.org", "a@example.net", "a@shop.test", "a@x.invalid", "a@dev.localhost"]) {
      expect(reasonOf({ email }, opts([], { defaults: ALL })), email).toBe("domain");
    }
    expect(reasonOf({ email: "a@examples.com" }, opts([], { defaults: ALL }))).toBeNull();
    expect(reasonOf({ email: "test@gmail.com" }, opts([], { defaults: ALL }))).toBeNull();
  });

  it("non-production hosts, and the app's own flag", () => {
    for (const host of ["localhost:3000", "127.0.0.1", "[::1]:3000", "riddler-go-git-main-x.vercel.app", "app.localhost"]) {
      expect(reasonOf({ host }, opts([], { defaults: ALL })), host).toBe("non_production");
    }
    expect(reasonOf({ host: "riddlergo.com" }, opts([], { defaults: ALL }))).toBeNull();
    expect(reasonOf({ nonProduction: true }, opts([], { defaults: NONE }))).toBe("non_production");
  });

  it("a production site served from vercel.app is exempt once declared", () => {
    expect(reasonOf({ host: "myapp.vercel.app" }, opts([], { defaults: ALL, productionHosts: ["myapp.vercel.app"] }))).toBeNull();
    expect(reasonOf({ host: "myapp.vercel.app" }, opts([rule("host", "myapp.vercel.app")], { defaults: ALL }))).toBeNull();
    expect(reasonOf({ host: "myapp-git-x.vercel.app" }, opts([], { defaults: ALL, productionHosts: ["myapp.vercel.app"] }))).toBe("non_production");
  });

  it("automation user agents, webdriver and the smoke-test header", () => {
    const agents = [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36",
      "Mozilla/5.0 Playwright/1.49",
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Chrome-Lighthouse",
      "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
      "Checkly/1.0 (https://www.checklyhq.com)",
      "Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
      "puppeteer-core",
    ];
    for (const userAgent of agents) expect(reasonOf({ userAgent }, opts([], { defaults: ALL })), userAgent).toBe("automation");
    expect(reasonOf({ userAgent: CHROME }, opts([], { defaults: ALL }))).toBeNull();
    expect(reasonOf({ webdriver: true }, opts([], { defaults: ALL }))).toBe("automation");
    expect(reasonOf({ testHeader: true }, opts([], { defaults: NONE }))).toBe("automation");
  });

  it("crawlers are bots — apart from automation, and a CUBOT phone is a person", () => {
    expect(reasonOf({ userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, opts([], { defaults: ALL }))).toBe("bot");
    expect(reasonOf({ userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" }, opts([], { defaults: ALL }))).toBe("bot");
    expect(reasonOf({ userAgent: "facebookexternalhit/1.1" }, opts([], { defaults: ALL }))).toBe("bot");
    expect(reasonOf({ userAgent: "Mozilla/5.0 (Linux; Android 10; CUBOT P50 Build/QP1A) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" }, opts([], { defaults: ALL }))).toBeNull();
  });

  it("each group can be switched off", () => {
    const off = resolveDefaults({ emailDomains: false, hosts: false, automation: false, bots: false, emailPatterns: false });
    expect(reasonOf({ email: "a@example.com", host: "localhost", userAgent: "HeadlessChrome Googlebot/2.1", webdriver: true }, opts([], { defaults: off }))).toBeNull();
  });
});

describe("precedence: the first reason wins, so per-reason counts add up", () => {
  it("is exactly the documented order", () => {
    expect(REASON_ORDER).toEqual([
      "bot",
      "automation",
      "non_production",
      "role",
      "named_user",
      "email",
      "domain",
      "pattern",
      "org",
      "event",
      "order",
      "device",
      "network",
      "manual",
    ]);
  });

  it("an actor matching everything is counted once, under the highest reason — and peeling reasons off walks down the order", () => {
    const rules = [
      rule("user", "u1"),
      rule("email", "jane@riddlergo.com"),
      rule("email_domain", "riddlergo.com"),
      rule("email_pattern", "jane@"),
      rule("org", "o1"),
      rule("event", "e1"),
      rule("order", "x1"),
      rule("visitor", "v1"),
      rule("network", "10.0.0.0/8"),
    ];
    const full: ActorFacts = {
      userAgent: "Googlebot/2.1",
      webdriver: true,
      nonProduction: true,
      roleLabel: "staff",
      userId: "u1",
      email: "jane@riddlergo.com",
      orgIds: ["o1"],
      eventId: "e1",
      orderId: "x1",
      visitorId: "v1",
      ip: "10.1.2.3",
    };
    const walk: Array<[keyof ActorFacts | "defaults-bot", string]> = [
      ["userAgent", "bot"],
      ["webdriver", "automation"],
      ["nonProduction", "non_production"],
      ["roleLabel", "role"],
      ["userId", "named_user"],
      ["email", "email"],
    ];
    const facts: ActorFacts = { ...full };
    for (const [field, expected] of walk) {
      expect(reasonOf(facts, opts(rules, { defaults: ALL })), `with ${String(field)}`).toBe(expected);
      delete (facts as Record<string, unknown>)[field];
    }
    // Remove the exact-email rule, then the domain, then the pattern…
    let remaining = rules.filter((r) => r.kind !== "email" && r.kind !== "user");
    expect(reasonOf({ ...facts, email: "jane@riddlergo.com" }, opts(remaining))).toBe("domain");
    remaining = remaining.filter((r) => r.kind !== "email_domain");
    expect(reasonOf({ ...facts, email: "jane@riddlergo.com" }, opts(remaining))).toBe("pattern");
    expect(reasonOf(facts, opts(remaining))).toBe("org");
    delete facts.orgIds;
    expect(reasonOf(facts, opts(remaining))).toBe("event");
    delete facts.eventId;
    expect(reasonOf(facts, opts(remaining))).toBe("order");
    delete facts.orderId;
    expect(reasonOf(facts, opts(remaining))).toBe("device");
    delete facts.visitorId;
    expect(reasonOf(facts, opts(remaining))).toBe("network");
    delete facts.ip;
    expect(reasonOf(facts, opts(remaining))).toBeNull();
  });

  it("lists every match, best first; within one reason the ones no rule owns come first", () => {
    const pattern = rule("email_pattern", "+clerk_test@");
    const all = allMatches({ email: "a+clerk_test@gmail.com", roleLabel: "staff" }, opts([pattern], { defaults: ALL }));
    expect(all.map((m) => [m.reason, m.ruleId])).toEqual([
      ["role", null],
      ["pattern", null],
      ["pattern", pattern.id],
    ]);
  });
});

describe("ruleMatchesUser — the retroactive half uses the same matching", () => {
  it("agrees with intake for every person kind", () => {
    const user = { id: "u9", email: "J.Doe+x@gmail.com" };
    expect(ruleMatchesUser(rule("user", "u9"), user, true)).toBe(true);
    expect(ruleMatchesUser(rule("email", "jdoe@gmail.com"), user, true)).toBe(true);
    expect(ruleMatchesUser(rule("email", "jdoe@gmail.com"), user, false)).toBe(false);
    expect(ruleMatchesUser(rule("email_domain", "gmail.com"), user, true)).toBe(true);
    expect(ruleMatchesUser(rule("email_pattern", "+x@"), user, true)).toBe(true);
    expect(ruleMatchesUser(rule("org", "u9"), user, true)).toBe(false);
    expect(ruleMatchesUser(rule("email", "jdoe@gmail.com"), { id: "u1", email: null }, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review regressions. Each test below fails on the code before its fix.
// ---------------------------------------------------------------------------

describe("what each reason marks", () => {
  it("person reasons mark the device and the user; one visit's facts mark the visit; a test event or order marks the visit", () => {
    for (const reason of ["role", "named_user", "email", "domain", "pattern", "org"] as const) expect(markScopeOf(reason), reason).toBe("person");
    expect(markScopeOf("device")).toBe("device");
    for (const reason of ["bot", "automation", "non_production", "network"] as const) expect(markScopeOf(reason), reason).toBe("visit");
    for (const reason of ["event", "order"] as const) expect(markScopeOf(reason), reason).toBe("subject");
  });

  it("an org is about the person: intake marks the member, and apply finds members through orgIds", () => {
    const org = rule("org", "org_demo");
    expect(classify({ orgIds: ["org_demo"] }, opts([org]))).toMatchObject({ reason: "org", personal: true });
    expect(ruleMatchesUser(org, { id: "u1", orgIds: ["org_demo"] }, true)).toBe(true);
    expect(ruleMatchesUser(org, { id: "u1", orgIds: ["org_other"] }, true)).toBe(false);
    expect(ruleMatchesUser(org, { id: "u1" }, true)).toBe(false);
  });
});

describe("a production-host miss belongs to the host rules that caused it", () => {
  it("one match per host rule, so removing a mistyped rule takes its marks away; a list in code owns its own", () => {
    const www = rule("host", "www.riddlergo.com");
    const staging = rule("host", "staging.riddlergo.com");
    const all = allMatches({ host: "riddlergo.com" }, opts([www, staging]));
    expect(all.map((m) => [m.reason, m.ruleId])).toEqual([
      ["non_production", www.id],
      ["non_production", staging.id],
    ]);
    const withCode = allMatches({ host: "riddlergo.com" }, opts([www], { productionHosts: ["app.riddlergo.com"] }));
    expect(withCode.map((m) => m.ruleId)).toEqual([null, www.id]);
    // The default deny-list (localhost, previews) is no rule's doing.
    expect(allMatches({ host: "localhost" }, opts([www], { defaults: ALL })).map((m) => m.ruleId)).toEqual([null]);
  });
});

describe("numeric ids (Road Rally's users are integers)", () => {
  it("a user rule and an org rule match a numeric id by its digits", () => {
    expect(ruleMatchesUser(rule("user", "42"), { id: 42 }, true)).toBe(true);
    expect(ruleMatchesUser(rule("org", "7"), { id: 42, orgIds: [7] }, true)).toBe(true);
  });
});
