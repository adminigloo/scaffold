import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  asciiDomain,
  breakdownParts,
  canonicalCidr,
  cleanId,
  createAudience,
  excludedReasonOf,
  globMatches,
  indexMarks,
  isUniqueViolation,
  maskNetwork,
  testHeaderValueFor,
  AudienceError,
  type AudienceStore,
  clientIpFrom,
  countedSubjectClause,
  countedVisitorClause,
  countRowsParts,
  createMasker,
  emailKey,
  emailPatternMatches,
  foldEmail,
  includeInternalHref,
  ipInRange,
  isNonProductionEnv,
  isPrivacyOptOut,
  maskEmail,
  maskRule,
  normalizeDomain,
  normalizeEmail,
  normalizeHost,
  normalizeRuleInput,
  normalizeRuleValue,
  parseCidr,
  readIncludeInternal,
  renderSql,
  RuleValueError,
  signDeviceToken,
  userKeyFor,
  verifyDeviceToken,
  type AudienceRule,
} from "../core.js";
import { countedSubjectSql, countedVisitorSql, ruleDraftSchema } from "../index.js";

describe("normalisation", () => {
  it("emails: trimmed, lower-cased, one @, no spaces", () => {
    expect(normalizeEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(normalizeEmail("no-at-sign")).toBeNull();
    expect(normalizeEmail("a@b@c.com")).toBeNull();
    expect(normalizeEmail("@x.com")).toBeNull();
    expect(normalizeEmail("a@")).toBeNull();
    expect(normalizeEmail("a b@x.com")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("Gmail folding: dots and +tags out, googlemail is gmail, others untouched", () => {
    expect(foldEmail("j.a.n.e+news@gmail.com")).toBe("jane@gmail.com");
    expect(foldEmail("jane@googlemail.com")).toBe("jane@gmail.com");
    expect(foldEmail("j.ane+x@outlook.com")).toBe("j.ane+x@outlook.com");
    expect(emailKey(" J.Ane+X@Gmail.com", true)).toBe("jane@gmail.com");
    expect(emailKey(" J.Ane+X@Gmail.com", false)).toBe("j.ane+x@gmail.com");
  });

  it("domains and hosts", () => {
    expect(normalizeDomain("@RiddlerGo.com")).toBe("riddlergo.com");
    expect(normalizeDomain("*.test")).toBe("test");
    expect(normalizeDomain("riddlergo.com.")).toBe("riddlergo.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeHost("WWW.Example.com:443")).toBe("www.example.com");
    expect(normalizeHost("https://app.example.com/path?q=1")).toBe("app.example.com");
    expect(normalizeHost("[::1]:3000")).toBe("::1");
    expect(normalizeHost("::1")).toBe("::1");
    expect(normalizeHost("")).toBeNull();
  });

  it("rule values per kind, with a sentence when refused", () => {
    expect(normalizeRuleValue("email", " Jane@X.io ")).toBe("jane@x.io");
    expect(normalizeRuleValue("email_domain", "@X.io")).toBe("x.io");
    expect(normalizeRuleValue("email_pattern", "+QA")).toBe("+qa");
    expect(normalizeRuleValue("network", "10.1.2.3/8")).toBe("10.0.0.0/8");
    expect(normalizeRuleValue("network", "203.0.113.9")).toBe("203.0.113.9/32");
    expect(normalizeRuleValue("network", "2001:DB8:0:0:1::/64")).toBe("2001:db8::/64");
    expect(normalizeRuleValue("host", "*.Example.com")).toBe("*.example.com");
    expect(normalizeRuleValue("user_agent", "MyBot")).toBe("mybot");
    expect(normalizeRuleValue("user", "  user_123 ")).toBe("user_123");
    for (const [kind, value] of [
      ["email", "not-an-email"],
      ["email_domain", "has space.com"],
      ["email_pattern", "ab"],
      ["email_pattern", "**"],
      ["network", "10.0.0.0/0"],
      ["network", "300.1.1.1"],
      ["network", "10.0.0.0/33"],
      ["user_agent", "ab"],
      ["user", "   "],
    ] as const) {
      expect(() => normalizeRuleValue(kind, value), `${kind} ${value}`).toThrow(RuleValueError);
    }
    expect(() => normalizeRuleValue("nope" as never, "x")).toThrow(RuleValueError);
  });

  it("a whole rule input: labels trimmed, dates read", () => {
    expect(normalizeRuleInput({ kind: "email", value: "A@B.co", reasonLabel: "  Rachel  ", note: "", appliesFrom: "2026-07-01" })).toEqual({
      kind: "email",
      value: "a@b.co",
      reasonLabel: "Rachel",
      note: null,
      appliesFrom: new Date("2026-07-01T00:00:00Z"),
    });
    expect(() => normalizeRuleInput({ kind: "email", value: "a@b.co", appliesFrom: "yesterday" })).toThrow(RuleValueError);
  });
});

describe("CIDR (ported from analytics verify.ts)", () => {
  it("parses and canonicalises", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ v6: false, base: 167772160, bits: 8 });
    expect(parseCidr("10.0.0.0/x")).toBeNull();
    expect(parseCidr("10.0.0.0/8/9")).toBeNull();
    expect(canonicalCidr("192.168.1.77/16")).toBe("192.168.0.0/16");
    expect(canonicalCidr("::1")).toBe("::1/128");
  });

  it("matches edges of a range exactly", () => {
    const range = parseCidr("192.168.4.0/22")!;
    expect(ipInRange("192.168.4.0", range)).toBe(true);
    expect(ipInRange("192.168.7.255", range)).toBe(true);
    expect(ipInRange("192.168.8.0", range)).toBe(false);
    expect(ipInRange("192.168.3.255", range)).toBe(false);
    const v6 = parseCidr("2001:db8:1234::/48")!;
    expect(ipInRange("2001:db8:1234:ffff::1", v6)).toBe(true);
    expect(ipInRange("2001:db8:1235::1", v6)).toBe(false);
    expect(ipInRange("192.168.4.1", v6)).toBe(false);
  });
});

describe("request helpers", () => {
  it("privacy opt-outs, client IP, include-internal URL", () => {
    expect(isPrivacyOptOut({ "Sec-GPC": "1" })).toBe(true);
    expect(isPrivacyOptOut(new Headers({ dnt: "1" }))).toBe(true);
    expect(isPrivacyOptOut({ dnt: "0" })).toBe(false);
    expect(clientIpFrom({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })).toBe("203.0.113.5");
    expect(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIpFrom({})).toBeNull();
    expect(readIncludeInternal(new URLSearchParams("include_internal=1"))).toBe(true);
    expect(readIncludeInternal({ include_internal: ["true"] })).toBe(true);
    expect(readIncludeInternal({})).toBe(false);
    expect(includeInternalHref("/admin/analytics?range=30d", true)).toBe("/admin/analytics?range=30d&include_internal=1");
    expect(includeInternalHref("/admin/analytics?range=30d&include_internal=1#top", false)).toBe("/admin/analytics?range=30d#top");
    expect(includeInternalHref("https://x.io/a", true)).toBe("https://x.io/a?include_internal=1");
  });

  it("non-production fails OPEN: only a positive signal says so", () => {
    expect(isNonProductionEnv({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isNonProductionEnv({ VERCEL_ENV: "production", NODE_ENV: "development" })).toBe(false);
    expect(isNonProductionEnv({ NODE_ENV: "development" })).toBe(true);
    expect(isNonProductionEnv({ NODE_ENV: "production" })).toBe(false);
    expect(isNonProductionEnv({})).toBe(false);
  });
});

describe("masking for the analytics role", () => {
  it("j***@gmail.com, a tag stable within one masker and different across salts", () => {
    expect(maskEmail("Jane.Doe@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("not an email")).toBe("not an email");
    const a = createMasker("salt-a");
    const b = createMasker("salt-b");
    expect(a.tag("jane@gmail.com")).toBe(a.tag(" JANE@gmail.com"));
    expect(a.tag("jane@gmail.com")).not.toBe(a.tag("john@gmail.com"));
    expect(a.tag("jane@gmail.com")).not.toBe(b.tag("jane@gmail.com"));
    expect(a.label("jane@gmail.com")).toMatch(/^j\*\*\*@gmail\.com · [0-9a-f]{4}$/);
    expect(a.text("ask jane@gmail.com or bob@x.io")).toMatch(/^ask j\*\*\*@gmail\.com · [0-9a-f]{4} or b\*\*\*@x\.io · [0-9a-f]{4}$/);
  });

  it("masks a rule's value, label, note and author — and leaves non-personal values readable", () => {
    const base: AudienceRule = {
      id: "r",
      tenantId: "t",
      kind: "email",
      value: "rachel@gmail.com",
      reasonLabel: "rachel@gmail.com's laptop",
      note: "asked by dallin@riddlergo.com",
      createdBy: "dallin@riddlergo.com",
      createdAt: new Date(),
      disabledAt: null,
      disabledBy: null,
      appliesFrom: null,
    };
    const masked = maskRule(base, createMasker("s"));
    expect(JSON.stringify(masked)).not.toContain("rachel@");
    expect(JSON.stringify(masked)).not.toContain("dallin@");
    expect(masked.value).toMatch(/^r\*\*\*@gmail\.com · /);
    expect(maskRule({ ...base, kind: "email_domain", value: "riddlergo.com" }, createMasker("s")).value).toBe("riddlergo.com");
    expect(maskRule({ ...base, kind: "user", value: "user_2abcdef" }, createMasker("s")).value).toMatch(/^use••• · [0-9a-f]{4}$/);
  });
});

describe("keys", () => {
  const SECRET = "x".repeat(40);
  it("user keys are HMACs: deterministic, tenant-scoped, never the id", () => {
    const key = userKeyFor(SECRET, "t1", "user_123");
    expect(key).toBe(userKeyFor(SECRET, "t1", "user_123"));
    expect(key).not.toBe(userKeyFor(SECRET, "t2", "user_123"));
    expect(key).not.toBe(userKeyFor("y".repeat(40), "t1", "user_123"));
    expect(key).not.toContain("user_123");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("device tokens verify, expire, and refuse tampering or another tenant", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const { token, linkId } = signDeviceToken(SECRET, { tenantId: "t1", by: "dallin@x.io", expiresAt: new Date(now.getTime() + 60_000), maxDevices: 3 });
    expect(verifyDeviceToken(SECRET, "t1", token, now)).toMatchObject({ ok: true, by: "dallin@x.io", maxDevices: 3, linkId });
    expect(verifyDeviceToken(SECRET, "t2", token, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyDeviceToken(SECRET, "t1", token, new Date(now.getTime() + 120_000))).toEqual({ ok: false, reason: "expired" });
    const parts = token.split(".");
    parts[2] = "z"; // raise the device limit
    expect(verifyDeviceToken(SECRET, "t1", parts.join("."), now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyDeviceToken(SECRET, "t1", "garbage", now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a device link does not carry its maker's email in readable form (a URL ends up in history, Referer headers and logs)", () => {
    const { token } = signDeviceToken(SECRET, { tenantId: "t1", by: "jane.staff@riddlergo.com", expiresAt: new Date(Date.now() + 60_000), maxDevices: 5 });
    const decoded = token
      .split(".")
      .map((part) => Buffer.from(part, "base64url").toString("latin1"))
      .join(" ");
    expect(token).not.toContain(Buffer.from("jane.staff@riddlergo.com").toString("base64url"));
    expect(decoded).not.toContain("jane.staff");
    expect(decoded).not.toContain("riddlergo");
  });

  it("refuses a placeholder secret (fewer than 10 different characters), not only a short one", () => {
    const store = {} as AudienceStore;
    expect(() => createAudience({ store, secret: "x".repeat(40) })).toThrow(/placeholder/);
    expect(() => createAudience({ store, secret: "abcabcabcabcabcabcabcabcabcabcabcabc" })).toThrow(/placeholder/);
    expect(() => createAudience({ store, secret: "s3cret-0123456789-abcdefghijklmnopqrstuv", previousSecrets: ["y".repeat(40)] })).toThrow(/previousSecrets\[0\]/);
    expect(() => createAudience({ store, secret: "s3cret-0123456789-abcdefghijklmnopqrstuv" })).not.toThrow();
  });

  it("the smoke-test header's default value is derived from the secret, not a public word", () => {
    const store = {} as AudienceStore;
    const secret = "s3cret-0123456789-abcdefghijklmnopqrstuv";
    const audience = createAudience({ store, secret, tenantId: "site" });
    expect(audience.testHeader).toEqual({ name: "x-aig-audience", value: testHeaderValueFor(secret, "site") });
    expect(audience.testHeader!.value).not.toBe("test");
    expect(audience.testHeader!.value.length).toBeGreaterThanOrEqual(32);
    expect(createAudience({ store, secret, testHeader: false }).testHeader).toBeNull();
    expect(createAudience({ store, secret, testHeader: { value: "mine" } }).testHeader).toEqual({ name: "x-aig-audience", value: "mine" });
  });
});

describe("SQL fragments", () => {
  const dialect = new PgDialect();
  const render = (value: ReturnType<typeof sql>) => dialect.sqlToQuery(value);

  it("countedVisitorSql is a NOT EXISTS anti-join on the app's own alias, tenant bound as a parameter", () => {
    const q = render(countedVisitorSql("s.visitor_id", { tenantId: "site", time: null, session: null }));
    expect(q.sql).toBe(
      "(NOT EXISTS (SELECT 1 FROM aig_audience_marks aig_m WHERE aig_m.tenant_id = $1 AND aig_m.subject_kind = 'visitor' AND aig_m.subject_id = s.visitor_id AND aig_m.cleared_at IS NULL))",
    );
    expect(q.params).toEqual(["site"]);
  });

  it("with a time column it honours appliesFrom; with a session column it also leaves out marked sessions", () => {
    const q = render(countedVisitorSql("s.visitor_id", { tenantId: "t", time: "s.created_at", session: "s.id", marksTable: "rg_marks" }));
    expect(q.sql).toContain("FROM rg_marks aig_m");
    expect(q.sql).toContain("AND (aig_m.applies_from IS NULL OR aig_m.applies_from <= s.created_at)");
    expect(q.sql).toContain(" AND NOT EXISTS (SELECT 1 FROM rg_marks aig_m WHERE aig_m.tenant_id = $2 AND aig_m.subject_kind = 'session' AND aig_m.subject_id = s.id");
    expect(q.params).toEqual(["t", "t"]);
  });

  it("composes inside a larger query, numbering after the app's own parameters", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const q = render(sql`SELECT count(*) FROM analytics_sessions s WHERE s.created_at >= ${from} AND ${countedVisitorSql("s.visitor_id", { tenantId: "t", time: null, session: null })}`);
    expect(q.sql).toContain("s.created_at >= $1 AND (NOT EXISTS");
    expect(q.sql).toContain("tenant_id = $2");
    expect(q.params).toEqual([from, "t"]);
  });

  it("includeInternal makes it always true, so the app can AND it in unconditionally", () => {
    expect(render(countedVisitorSql("s.visitor_id", { tenantId: "t", time: "s.created_at", session: "s.id", includeInternal: true })).sql).toBe("(1 = 1)");
    expect(render(countedSubjectSql("org", "o.id", { tenantId: "t", includeInternal: true })).sql).toBe("(1 = 1)");
  });

  it("countedSubjectSql for orgs, events, orders; a Drizzle column or SQL works as the column", () => {
    expect(render(countedSubjectSql("org", "o.id", { tenantId: "t" })).sql).toContain("aig_m.subject_kind = 'org' AND aig_m.subject_id = o.id");
    expect(render(countedSubjectSql("order", sql.raw('"orders"."id"'), { tenantId: "t" })).sql).toContain('aig_m.subject_id = "orders"."id"');
    expect(() => countedSubjectSql("nope" as never, "o.id", { tenantId: "t" })).toThrow(/unknown subject kind/);
  });

  it("refuses anything but an identifier as a column or table (no SQL through the side door)", () => {
    const none = { time: null, session: null } as const;
    for (const bad of ["s.visitor_id; DROP TABLE x", "s.visitor_id OR 1=1", "", "a.b.c.d", '"unterminated']) {
      expect(() => countedVisitorSql(bad, { tenantId: "t", ...none }), bad).toThrow(/identifier/);
    }
    expect(() => countedVisitorSql("s.visitor_id", { tenantId: "t", marksTable: "marks m; --", ...none })).toThrow(/identifier/);
    expect(() => countedVisitorSql('"s"."visitorId"', { tenantId: "t", ...none })).not.toThrow();
    expect(() => countedVisitorSql("public.s.visitor_id", { tenantId: "t", ...none })).not.toThrow();
  });

  it("renders to raw text for a caller without Drizzle: ? for MySQL, $n for Postgres, CAST for non-text ids", () => {
    const mysql = countedVisitorClause("s.visitor_id", { tenantId: "t", dialect: "mysql", castToText: true, time: null, session: null });
    expect(mysql.sql).toContain("aig_m.subject_id = CAST(s.visitor_id AS CHAR)");
    expect(mysql.sql).toContain("tenant_id = ?");
    expect(mysql.params).toEqual(["t"]);
    const pg = countedSubjectClause("event", "e.id", { tenantId: "t", placeholder: "$", startAt: 4, castToText: true });
    expect(pg.sql).toContain("tenant_id = $4");
    expect(pg.sql).toContain("CAST(e.id AS TEXT)");
  });

  it("the store's two queries over the app's rows have the expected shape", () => {
    const rows = { table: "analytics_sessions", visitor: "visitor_id", time: "created_at", id: "id" };
    const count = renderSql(countRowsParts({ tenantId: "t", rows, from: new Date(0), visitorIds: ["a", "b"], countedOnly: true }), { placeholder: "$" });
    expect(count.sql).toMatch(/^SELECT count\(\*\) AS n, count\(DISTINCT aig_s\.visitor_id\) AS v, min\(aig_s\.created_at\) AS earliest/);
    expect(count.sql).toContain("FROM analytics_sessions aig_s WHERE 1 = 1 AND aig_s.created_at >= $1 AND aig_s.visitor_id IN ($2, $3) AND (NOT EXISTS");
    expect(count.params).toHaveLength(5);
    const none = renderSql(countRowsParts({ tenantId: "t", rows, visitorIds: [], countedOnly: false }));
    expect(none.sql).toContain("AND 1 = 0");
    const breakdown = renderSql(breakdownParts({ tenantId: "t", rows }));
    expect(breakdown.sql).toContain("min(CASE aig_m.reason WHEN 'bot' THEN 0 WHEN 'automation' THEN 1");
    expect(breakdown.sql).toContain("WHEN 'manual' THEN 13 ELSE 14 END");
    expect(breakdown.sql).toContain("(aig_m.subject_kind = 'session' AND aig_m.subject_id = aig_s.id)");
    expect(breakdown.sql).toMatch(/GROUP BY aig_x\.best$/);
    expect(() => countRowsParts({ tenantId: "t", rows: { ...rows, visitor: "s.visitor_id" }, countedOnly: true })).toThrow(/single column/);
  });
});

describe("ruleDraftSchema (server-action input)", () => {
  it("accepts the form's draft and refuses junk", () => {
    expect(ruleDraftSchema.parse({ kind: "email", value: " a@b.co ", reasonLabel: null, appliesFrom: "2026-07-01" })).toMatchObject({ kind: "email", value: "a@b.co" });
    expect(ruleDraftSchema.safeParse({ kind: "email", value: "a@b.co", appliesFrom: "" }).success).toBe(true);
    expect(ruleDraftSchema.safeParse({ kind: "ip", value: "x" }).success).toBe(false);
    expect(ruleDraftSchema.safeParse({ kind: "email", value: "" }).success).toBe(false);
    expect(ruleDraftSchema.safeParse({ kind: "email", value: "a@b.co", appliesFrom: "next week" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review regressions. Each test below fails on the code before its fix.
// ---------------------------------------------------------------------------

describe("email patterns: a linear glob, never a backtracking regex", () => {
  it("matches like a glob: * any run, ? one character, the rest literal, whole string", () => {
    expect(globMatches("qa+clerk_test@gmail.com", "*+clerk_test@*")).toBe(true);
    expect(globMatches("qa+clerk_test@gmail.com", "qa+*@gmail.com")).toBe(true);
    expect(globMatches("qa+clerk_test@gmail.com", "q?+*")).toBe(true);
    expect(globMatches("qa+clerk_test@gmail.com", "*@gmail.co")).toBe(false);
    expect(globMatches("a.b@x.io", "a?b@x.io")).toBe(true);
    expect(globMatches("a.b@x.io", "a.b@x?io")).toBe(true);
    expect(globMatches("axb@x.io", "a.b@x.io")).toBe(false); // "." is literal
    expect(globMatches("A@X.IO", "a@x.io")).toBe(true);
    expect(globMatches("", "*")).toBe(true);
    expect(globMatches("abc", "a**c")).toBe(true);
  });

  it("a pathological pattern on a long address returns at once (it took 45 s as a regex)", () => {
    const pattern = "*a*a*a*a*a*a*a*a*a*b";
    const address = `${"a".repeat(30)}@example.com`;
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) expect(emailPatternMatches(address, pattern)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("email normalisation edge cases", () => {
  it("full-width, dotted capital I, an empty folded mailbox, an over-long address, and IDN domains", () => {
    expect(normalizeEmail("ｊane@gmail.com")).toBe("jane@gmail.com");
    expect(normalizeEmail("İvy@x.io")).toBe("ivy@x.io");
    expect(foldEmail("+abc@gmail.com")).toBe("+abc@gmail.com");
    expect(emailKey("+abc@gmail.com", true)).not.toBe(emailKey("+xyz@gmail.com", true));
    expect(normalizeEmail(`${"a".repeat(250)}@x.io`)).toBeNull();
    expect(normalizeEmail("max@bücher.de")).toBe("max@xn--bcher-kva.de");
    expect(normalizeDomain("Bücher.DE")).toBe("xn--bcher-kva.de");
    expect(asciiDomain("riddlergo.com")).toBe("riddlergo.com");
  });

  it("ids: digits for numbers, refused when empty, too long or carrying control characters", () => {
    expect(cleanId(42)).toBe("42");
    expect(cleanId(" v1 ")).toBe("v1");
    expect(cleanId("")).toBeNull();
    expect(cleanId("v".repeat(201))).toBeNull();
    expect(cleanId("a\u0000b")).toBeNull();
    expect(cleanId({})).toBeNull();
  });
});

describe("SQL guards that keep exclusion from silently turning off", () => {
  const dialect = new PgDialect();
  const render = (value: ReturnType<typeof sql>) => dialect.sqlToQuery(value);

  it("a bare column is refused: inside the anti-join `id` would be the MARK's own id", () => {
    expect(() => countedSubjectSql("org", "id", { tenantId: "t" })).toThrow(/qualify/);
    expect(() => countedSubjectSql("org", '"id"', { tenantId: "t" })).toThrow(/qualify/);
    expect(() => countedVisitorSql("visitor_id", { tenantId: "t", time: null, session: null })).toThrow(/qualify/);
    expect(() => countedVisitorSql("s.visitor_id", { tenantId: "t", time: "created_at", session: null })).toThrow(/qualify/);
    expect(() => countedVisitorSql("s.visitor_id", { tenantId: "t", time: null, session: "id" })).toThrow(/qualify/);
    expect(() => countedSubjectSql("org", "aig_m.id", { tenantId: "t" })).toThrow(/marks alias/);
    expect(render(countedSubjectSql("org", "o.id", { tenantId: "t" })).sql).toContain("aig_m.subject_id = o.id");
  });

  it("the visitor fragment needs `time` and `session` named, so an only-from date and session marks are never dropped by omission", () => {
    expect(() => countedVisitorSql("s.visitor_id", { tenantId: "t" } as never)).toThrow(/needs `time`/);
    expect(() => countedVisitorSql("s.visitor_id", { tenantId: "t", time: "s.created_at" } as never)).toThrow(/needs `session`/);
    expect(() => countedVisitorClause("s.visitor_id", { tenantId: "t", dialect: "mysql" } as never)).toThrow(/needs `time`/);
    const q = render(countedVisitorSql("s.visitor_id", { tenantId: "t", time: "s.created_at", session: "s.id" }));
    expect(q.sql).toContain("applies_from <= s.created_at");
    expect(q.sql).toContain("subject_kind = 'session' AND aig_m.subject_id = s.id");
  });

  it("each dialect's own quoting only: MySQL \"x\" is a string, Postgres `x` is not a quote", () => {
    const none = { time: null, session: null } as const;
    expect(() => countedVisitorClause('"s"."visitor_id"', { tenantId: "t", dialect: "mysql", ...none })).toThrow(/backticks/);
    expect(() => countedVisitorClause("`s`.`visitor_id`", { tenantId: "t", dialect: "mysql", ...none })).not.toThrow();
    expect(() => countedVisitorClause("`s`.`visitor_id`", { tenantId: "t", ...none })).toThrow(/identifier/);
    expect(() => countedVisitorClause('"s"."visitor_id"', { tenantId: "t", ...none })).not.toThrow();
  });
});

describe("masking for the analytics role, beyond full addresses", () => {
  const base: AudienceRule = {
    id: "r",
    tenantId: "t",
    kind: "network",
    value: "73.12.34.56/32",
    reasonLabel: null,
    note: null,
    createdBy: null,
    createdAt: new Date(),
    disabledAt: null,
    disabledBy: null,
    appliesFrom: null,
  };

  it("a single-address network (someone's home) is shortened; an office range stays readable", () => {
    const masker = createMasker("s");
    expect(maskRule(base, masker).value).toMatch(/^73\.12\.•••\/32 · [0-9a-f]{4}$/);
    expect(maskRule({ ...base, value: "2001:db8::1/128" }, masker).value).toMatch(/^2001:db8:•••\/128 · /);
    expect(maskRule({ ...base, value: "203.0.113.0/24" }, masker).value).toBe("203.0.113.0/24");
    expect(maskNetwork("73.12.34.56/32")).toBe("73.12.•••/32");
  });

  it("an email pattern naming a person is shortened, not shown", () => {
    const masked = maskRule({ ...base, kind: "email_pattern", value: "rachel.smith" }, createMasker("s"));
    expect(masked.value).not.toContain("rachel.smith");
    expect(masked.value).toMatch(/^rac••• · [0-9a-f]{4}$/);
  });
});

describe("the read side without SQL (Road Rally builds sessions in JavaScript)", () => {
  const at = (iso: string) => new Date(iso);
  const mark = (
    subjectKind: "visitor" | "session" | "user",
    subjectId: string,
    reason: "role" | "automation" | "email" | "manual",
    extra: { appliesFrom?: Date; clearedAt?: Date } = {},
  ) => ({ subjectKind, subjectId, reason, appliesFrom: extra.appliesFrom ?? null, clearedAt: extra.clearedAt ?? null });

  it("the best active reason among a row's subjects, honouring only-from and ignoring cleared marks", () => {
    const index = indexMarks([
      mark("visitor", "v1", "email"),
      mark("session", "s9", "automation"),
      mark("user", "42", "role", { appliesFrom: at("2026-07-01T00:00:00Z") }),
      mark("visitor", "v2", "manual", { clearedAt: at("2026-08-01T00:00:00Z") }),
    ]);
    expect(index.size).toBe(3);
    expect(excludedReasonOf(index, { at: "2026-09-01T00:00:00Z", visitorId: "v1", sessionId: "s9" })).toBe("automation");
    expect(excludedReasonOf(index, { at: "2026-09-01T00:00:00Z", userId: 42 })).toBe("role");
    expect(excludedReasonOf(index, { at: "2026-06-01T00:00:00Z", userId: 42 })).toBeNull();
    expect(excludedReasonOf(index, { at: "2026-09-01T00:00:00Z", visitorId: "v2" })).toBeNull();
    expect(excludedReasonOf(index, { at: "2026-09-01T00:00:00Z", visitorId: "nobody" })).toBeNull();
  });
});

describe("store errors", () => {
  it("recognises a unique violation however the driver wraps it", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
    expect(isUniqueViolation(new Error("query failed", { cause: Object.assign(new Error("dup"), { code: "23505" }) }))).toBe(true);
    expect(isUniqueViolation({ code: "ER_DUP_ENTRY" })).toBe(true);
    expect(isUniqueViolation(new AudienceError("duplicate_rule", "x"))).toBe(true);
    expect(isUniqueViolation(new AudienceError("not_found", "x"))).toBe(false);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
  });
});

describe("excludedSentence wording", () => {
  it("says 1 session, not 1 sessions, both ways", async () => {
    const { excludedSentence } = await import("../core/words.js");
    expect(excludedSentence({ total: 1, byReason: { role: 1 } })).toBe("Excluded: 1 session (staff 1)");
    expect(excludedSentence({ total: 2, byReason: { role: 2 } })).toBe("Excluded: 2 sessions (staff 2)");
    expect(excludedSentence({ total: 1, byReason: { role: 1 } }, { includeInternal: true })).toBe(
      "Including 1 internal session (staff 1)",
    );
    expect(excludedSentence({ total: 1, byReason: { role: 1 }, unit: "visitors" })).toBe("Excluded: 1 visitor (staff 1)");
  });
});
