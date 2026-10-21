import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { formatMinor, formatPrice } from "../money.js";
import {
  definePlans,
  freeGrantRows,
  InvalidPlanCatalogError,
  InvalidPlanKeyError,
  notOnSaleReason,
  planOnSale,
} from "../plans.js";
import { defaultPlanInterval, monthsFree, planColumns, planFeatureBullet, planIntervals } from "../presentation.js";
import { loadCompanyPlan } from "../server.js";

/**
 * BILLING 0.6: a FREE TIER the record declares (what an account with no plan
 * holds — the gate, the pricing page and the chooser read the same one), a
 * tier's ON SALE (true / "coming" / false, refused at checkout unless true),
 * and HOW A PLAN IS SHOWN (whole-dollar prices, yearly first, what a plan
 * includes and never "No X", "Everything in Free, plus:").
 */
const WEATHER = definePlans({
  features: {
    weather_live: { kind: "flag", label: "Live prices for every city" },
    weather_tools: { kind: "flag", label: "The payout calculator" },
    cities: { kind: "quota", label: "watchlist cities", labelOne: "watchlist city" },
  },
  free: {
    description: "Follow three cities, prices 30 minutes late.",
    features: { weather_live: false, weather_tools: false, cities: 3 },
  },
  tiers: [
    {
      key: "weather-basic",
      name: "Weather Basic",
      prices: { month: { usd: 1000n }, year: { usd: 10000n } },
      features: { weather_live: true, weather_tools: false, cities: 24 },
    },
    {
      key: "weather-pro",
      name: "Weather Pro",
      onSale: "coming",
      prices: { month: { usd: 2000n }, year: { usd: 20000n } },
      features: { weather_live: true, weather_tools: true, cities: 24 },
    },
    {
      key: "founder",
      name: "Founding member",
      onSale: false,
      prices: { month: { usd: 500n } },
      features: { weather_live: true, weather_tools: true, cities: null },
    },
  ],
});

describe("the free tier, in the record", () => {
  it("resolves with every feature, named Free unless named", () => {
    const free = WEATHER.lines[0]?.free;
    expect(free).toMatchObject({ name: "Free", description: "Follow three cities, prices 30 minutes late." });
    expect(free?.features["cities"]).toMatchObject({ kind: "quota", limit: 3 });
    expect(free?.features["weather_live"]).toMatchObject({ kind: "flag", included: false });
    // NEGATIVE CONTROL: a catalog that declares none has none.
    const none = definePlans({ features: { a: { kind: "flag", label: "A" } }, tiers: [{ key: "x", name: "X", prices: {}, features: { a: true } }] });
    expect(none.lines[0]?.free).toBeNull();
  });

  it("is checked like a tier: every feature given a value, none from elsewhere", () => {
    expect(() =>
      // @ts-expect-error b is missing: a free tier says what it holds of every feature
      definePlans({
        features: { a: { kind: "flag", label: "A" }, b: { kind: "quota", label: "bs" } },
        free: { features: { a: false } },
        tiers: [],
      }),
    ).toThrow(InvalidPlanCatalogError);
    expect(() =>
      // @ts-expect-error z isn't declared
      definePlans({
        features: { a: { kind: "flag", label: "A" } },
        free: { features: { a: false, z: 1 } },
        tiers: [],
      }),
    ).toThrow(/does not declare/);
  });

  it("per line: each line's own, against that line's vocabulary", () => {
    const two = definePlans({
      lines: {
        weather: {
          name: "Weather",
          features: { cities: { kind: "quota", label: "cities" } },
          free: { name: "Free account", features: { cities: 3 } },
          tiers: [{ key: "wb", name: "Basic", prices: { month: { usd: 1000n } }, features: { cities: 24 } }],
        },
        sports: {
          name: "Sports",
          features: { sports: { kind: "flag", label: "Sports" } },
          tiers: [{ key: "sp", name: "Sports", prices: { month: { usd: 500n } }, features: { sports: true } }],
        },
      },
    });
    expect(two.line("weather")?.free?.name).toBe("Free account");
    expect(two.line("sports")?.free).toBeNull();
  });

  it("a tier keyed \"free\" is refused only where a free tier is declared", () => {
    expect(() =>
      definePlans({
        features: { a: { kind: "flag", label: "A" } },
        free: { features: { a: false } },
        tiers: [{ key: "free", name: "Free", prices: { month: { usd: 0n } }, features: { a: false } }],
      }),
    ).toThrow(InvalidPlanKeyError);
    // NEGATIVE CONTROL: without one, a $0 tier keyed "free" is what it always was.
    expect(() =>
      definePlans({ features: { a: { kind: "flag", label: "A" } }, tiers: [{ key: "free", name: "Free", prices: { month: { usd: 0n } }, features: { a: false } }] }),
    ).not.toThrow();
  });

  it("stands for rows: a quota its number, a withheld flag a 0, options none", () => {
    const rows = freeGrantRows(WEATHER.lines[0]!.free!);
    expect(rows).toEqual(
      expect.arrayContaining([
        { feature: "cities", limitValue: 3, usedValue: 0, source: "plan", sourceRef: "free", expiresAt: null },
        { feature: "weather_live", limitValue: 0, usedValue: 0, source: "plan", sourceRef: "free", expiresAt: null },
      ]),
    );
  });
});

describe("on sale", () => {
  it("defaults to true; \"coming\" and false are kept; a retired tier is never on sale", () => {
    expect(WEATHER.tier("weather-basic")?.onSale).toBe(true);
    expect(WEATHER.tier("weather-pro")?.onSale).toBe("coming");
    expect(WEATHER.tier("founder")?.onSale).toBe(false);
    const retired = definePlans({ features: {}, tiers: [{ key: "old", name: "Old", isActive: false, prices: { month: { usd: 100n } }, features: {} }] });
    expect(retired.tier("old")?.onSale).toBe(false);
  });

  it("only true sells, and each refusal says why", () => {
    expect(planOnSale(WEATHER.tier("weather-basic")!)).toBe(true);
    expect(planOnSale(WEATHER.tier("weather-pro")!)).toBe(false);
    expect(planOnSale(WEATHER.tier("founder")!)).toBe(false);
    expect(notOnSaleReason(WEATHER.tier("weather-basic")!)).toBeNull();
    expect(notOnSaleReason(WEATHER.tier("weather-pro")!)).toBe("Weather Pro is coming soon. It can't be bought yet.");
    expect(notOnSaleReason(WEATHER.tier("founder")!)).toBe("Founding member isn't for sale.");
  });

  it("refuses a record that retires a tier and sells it", () => {
    expect(() =>
      definePlans({ features: {}, tiers: [{ key: "x", name: "X", isActive: false, onSale: "coming", prices: {}, features: {} }] }),
    ).toThrow(/retired/);
  });

  it("the projection still has every tier's rows (a coming plan is seeded and synced; it just isn't sold)", () => {
    expect(WEATHER.rows.map((row) => row.key)).toEqual(
      expect.arrayContaining(["weather-pro:month:usd", "weather-pro:year:usd", "founder:month:usd"]),
    );
  });
});

describe("prices", () => {
  it("whole units when exact, every decimal otherwise; JPY has none", () => {
    expect(formatPrice(1000n, "usd")).toBe("$10");
    expect(formatPrice(1250n, "usd")).toBe("$12.50");
    expect(formatPrice(1000n, "jpy")).toBe("¥1,000");
    // NEGATIVE CONTROL: the invoice form keeps the decimals.
    expect(formatMinor(1000n, "usd")).toBe("$10.00");
    expect(formatMinor(-50n, "usd")).toBe("-$0.50");
  });

  it("months free: $10/mo against $100/yr is 2; nothing saved is null", () => {
    expect(monthsFree(WEATHER.tier("weather-basic")!, "usd")).toBe(2);
    expect(monthsFree({ prices: { month: { usd: 1000n }, year: { usd: 12000n } } }, "usd")).toBeNull();
    expect(monthsFree({ prices: { month: { usd: 1000n } } }, "usd")).toBeNull();
  });

  it("yearly first, and a page opens on it", () => {
    expect(planIntervals(WEATHER)).toEqual(["year", "month"]);
    expect(defaultPlanInterval(WEATHER)).toBe("year");
    expect(defaultPlanInterval({ intervals: ["month"] })).toBe("month");
  });
});

describe("the columns a plans page shows", () => {
  const yearly = planColumns(WEATHER, { interval: "year", currency: "usd" });

  it("Free first, then what's on sale and coming; never a plan sold by hand", () => {
    expect(yearly.map((column) => [column.key, column.onSale])).toEqual([
      ["free", true],
      ["weather-basic", true],
      ["weather-pro", "coming"],
    ]);
  });

  it("prices read \"$100\" a year with \"2 months free\", and Free says Free", () => {
    expect(yearly[0]?.price).toEqual({ kind: "free", label: "Free" });
    expect(yearly[1]?.price).toEqual({ kind: "amount", label: "$100", interval: "year", per: "/yr", note: "2 months free" });
    const monthly = planColumns(WEATHER, { interval: "month", currency: "usd" });
    expect(monthly[1]?.price).toEqual({ kind: "amount", label: "$10", interval: "month", per: "/mo", note: null });
  });

  it("lists what a plan includes — never \"No …\" — and the next one up says what it adds", () => {
    expect(yearly[0]?.includes.map((bullet) => bullet.text)).toEqual(["3 watchlist cities"]);
    expect(yearly[1]).toMatchObject({ buildsOn: "Free" });
    expect(yearly[1]?.includes.map((bullet) => bullet.text)).toEqual(["Live prices for every city", "24 watchlist cities"]);
    expect(yearly[2]).toMatchObject({ buildsOn: "Weather Basic" });
    expect(yearly[2]?.includes.map((bullet) => bullet.text)).toEqual(["The payout calculator"]);
    for (const column of yearly) for (const bullet of [...column.includes, ...column.everything]) expect(bullet.text).not.toMatch(/^No /);
    expect(planFeatureBullet({ kind: "flag", feature: "x", label: "Coming: tools", included: false })).toBeNull();
  });

  it("a tier with LESS than the one before lists everything (\"everything in, plus\" would be untrue)", () => {
    const odd = definePlans({
      features: { a: { kind: "flag", label: "A" }, n: { kind: "quota", label: "ns" } },
      tiers: [
        { key: "one", name: "One", prices: { month: { usd: 100n } }, features: { a: true, n: 10 } },
        { key: "two", name: "Two", prices: { month: { usd: 200n } }, features: { a: false, n: 50 } },
      ],
    });
    const columns = planColumns(odd, { interval: "month", currency: "usd" });
    expect(columns[1]).toMatchObject({ buildsOn: null });
    expect(columns[1]?.includes.map((bullet) => bullet.text)).toEqual(["50 ns"]);
  });

  it("\"Most popular\" only where the record sets it", () => {
    expect(yearly.some((column) => column.highlight)).toBe(false);
    const flagged = definePlans({ features: {}, tiers: [{ key: "p", name: "P", highlight: true, prices: { month: { usd: 100n } }, features: {} }] });
    expect(planColumns(flagged, { interval: "month", currency: "usd" })[0]?.highlight).toBe(true);
  });

  it("headline features come first", () => {
    const columns = planColumns(WEATHER, { interval: "year", currency: "usd", headline: ["cities"] });
    expect(columns[1]?.includes.map((bullet) => bullet.feature)).toEqual(["cities", "weather_live"]);
  });
});

describe("the gate reads the free tier (PGlite)", () => {
  async function setup() {
    const pg = new PGlite();
    await pg.exec(`
      create table plans (id text primary key, tenant_id text not null default '*', key text not null, name text not null,
        description text, interval text not null, price_minor bigint, currency text not null default 'usd',
        stripe_product_id text, stripe_price_id text, is_active boolean not null default true, sort_order integer not null default 0,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table subscriptions (id text primary key, tenant_id text not null, plan_id text not null references plans(id),
        line text not null default 'main', stripe_subscription_id text, stripe_item_id text, stripe_customer_id text, status text not null,
        current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean not null default false,
        canceled_at timestamptz, trial_ends_at timestamptz, last_event_at timestamptz, last_event_id text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table entitlements (id text primary key, tenant_id text not null, feature text not null, limit_value integer,
        used_value integer not null default 0, source text not null, source_ref text, expires_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      insert into plans (id, key, name, interval) values ('pb', 'weather-basic:month:usd', 'Weather Basic', 'month');
    `);
    return { pg, db: drizzle(pg) };
  }
  const NOW = new Date("2026-10-21T12:00:00Z");

  it("no plan: the free tier's three cities and nothing live; a grant still adds to it", async () => {
    const { pg, db } = await setup();
    const plan = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0, plans: WEATHER });
    expect(plan.entitlements.get("cities")).toMatchObject({ limit: 3 });
    expect(plan.entitlements.get("weather_live")).toMatchObject({ limit: 0 });
    await pg.exec(`insert into entitlements (id, tenant_id, feature, limit_value, source) values ('g', 't', 'cities', 2, 'grant')`);
    const granted = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0, plans: WEATHER });
    expect(granted.entitlements.get("cities")).toMatchObject({ limit: 5 });
    // NEGATIVE CONTROL: read without the record, there's no free tier to add.
    const bare = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0 });
    expect(bare.entitlements.get("cities")).toMatchObject({ limit: 2 });
    await pg.close();
  });

  it("a paid plan replaces it: Basic's 24, never 24 + 3", async () => {
    const { pg, db } = await setup();
    await pg.exec(`
      insert into subscriptions (id, tenant_id, plan_id, stripe_subscription_id, status, current_period_end)
        values ('s', 't', 'pb', 'sub_1', 'active', '2026-11-21');
      insert into entitlements (id, tenant_id, feature, limit_value, source, source_ref) values
        ('e1', 't', 'cities', 24, 'plan', 'weather-basic'), ('e2', 't', 'weather_live', 1, 'plan', 'weather-basic');
    `);
    const plan = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0, plans: WEATHER });
    expect(plan.entitlements.get("cities")).toMatchObject({ limit: 24 });
    expect(plan.entitlements.get("weather_live")).toMatchObject({ limit: 1 });
    // And once it has ended, the free tier is back.
    await pg.exec(`update subscriptions set status = 'canceled', current_period_end = '2026-10-01'; delete from entitlements;`);
    const ended = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0, plans: WEATHER });
    expect(ended.entitlements.get("cities")).toMatchObject({ limit: 3 });
    await pg.close();
  });
});
