import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { grantsForPlan, planGrantDiff, type PlanGrant } from "../grants.js";
import {
  DEFAULT_PLAN_LINE,
  definePlans,
  InvalidPlanCatalogError,
  InvalidPlanKeyError,
  planLineRefs,
} from "../plans.js";
import { combineStandings, type PlanStanding } from "../standing.js";
import { lineOfStoredRow, liveStripeLines, liveStripeSubscription, loadCompanyPlan } from "../server.js";

/**
 * PRODUCT LINES (billing 0.5). Two things sold on their own — Weather and
 * Sports — each with its own tiers, held at once by one tenant on one Stripe
 * subscription. Tiers inside a line replace each other; lines stack. Every
 * rule below has a negative control: the same input read the one-line way,
 * showing what goes wrong without the line scope.
 */
const TWO_LINES = definePlans({
  lines: {
    weather: {
      name: "Weather",
      features: {
        weather_live: { kind: "flag", label: "Live weather" },
        weather_tools: { kind: "flag", label: "Pro tools" },
        alert_rules: { kind: "quota", label: "alert rules", labelOne: "alert rule" },
      },
      tiers: [
        {
          key: "weather-basic",
          name: "Weather Basic",
          prices: { month: { usd: 500n }, year: { usd: 5000n } },
          features: { weather_live: true, weather_tools: false, alert_rules: 0 },
        },
        {
          key: "weather-pro",
          name: "Weather Pro",
          highlight: true,
          prices: { month: { usd: 2000n }, year: { usd: 20000n } },
          features: { weather_live: true, weather_tools: true, alert_rules: 25 },
        },
      ],
    },
    sports: {
      name: "Sports",
      description: "Every game, live.",
      features: { sports_live: { kind: "flag", label: "Live sports" }, alert_rules: { kind: "quota", label: "alert rules" } },
      tiers: [
        {
          key: "sports",
          name: "Sports",
          // Highlighted too: one "most popular" per LINE is allowed.
          highlight: true,
          prices: { month: { usd: 500n }, year: { usd: 5000n } },
          features: { sports_live: true, alert_rules: 5 },
        },
      ],
    },
  },
});

const ONE_LINE = definePlans({
  features: { seats: { kind: "quota", label: "members" } },
  tiers: [
    { key: "starter", name: "Starter", prices: { month: { usd: 900n } }, features: { seats: 3 } },
    { key: "pro", name: "Pro", prices: { month: { usd: 2900n } }, features: { seats: 10 } },
  ],
});

describe("definePlans with lines", () => {
  it("every tier and every row names its line; the catalog lists the lines in order", () => {
    expect(TWO_LINES.lines.map((line) => [line.key, line.name, line.implicit])).toEqual([
      ["weather", "Weather", false],
      ["sports", "Sports", false],
    ]);
    expect(TWO_LINES.tier("weather-pro")?.line).toBe("weather");
    expect(TWO_LINES.tier("sports")?.line).toBe("sports");
    expect(TWO_LINES.line("sports")?.description).toBe("Every game, live.");
    expect(TWO_LINES.line("nope")).toBeUndefined();
    expect(new Set(TWO_LINES.rows.map((row) => `${row.tierKey}:${row.line}`))).toEqual(
      new Set(["weather-basic:weather", "weather-pro:weather", "sports:sports"]),
    );
    // sort order runs across lines, in declaration order (the plans table sorts as the page reads).
    expect(TWO_LINES.tiers.map((tier) => tier.sortOrder)).toEqual([0, 10, 20]);
    // The vocabulary is the union; a feature both lines declare is listed once.
    expect(TWO_LINES.features.map((heading) => heading.feature)).toEqual(["weather_live", "weather_tools", "alert_rules", "sports_live"]);
    // A line's own vocabulary only.
    expect(TWO_LINES.line("sports")?.features.map((heading) => heading.feature)).toEqual(["sports_live", "alert_rules"]);
    expect(Object.keys(TWO_LINES.tier("sports")!.features)).toEqual(["sports_live", "alert_rules"]);
  });

  it("a catalog written without lines is ONE implicit line, so every existing project reads the same", () => {
    expect(ONE_LINE.lines).toHaveLength(1);
    expect(ONE_LINE.lines[0]).toMatchObject({ key: DEFAULT_PLAN_LINE, implicit: true });
    expect(ONE_LINE.tiers.every((tier) => tier.line === DEFAULT_PLAN_LINE)).toBe(true);
    expect(ONE_LINE.rows.every((row) => row.line === DEFAULT_PLAN_LINE)).toBe(true);
    expect(DEFAULT_PLAN_LINE).toBe("main");
  });

  it("refuses what would let one line's subscription reach another's", () => {
    const tier = (key: string) => ({ key, name: key, prices: { month: { usd: 100n } }, features: {} });
    // Tier keys are unique ACROSS lines: a webhook names a tier with no line beside it.
    expect(() => definePlans({ lines: { a: { name: "A", features: {}, tiers: [tier("x")] }, b: { name: "B", features: {}, tiers: [tier("x")] } } })).toThrow(
      InvalidPlanKeyError,
    );
    expect(() => definePlans({ lines: { "Bad Key": { name: "A", features: {}, tiers: [tier("x")] } } })).toThrow(/product line "Bad Key"/);
    expect(() => definePlans({ lines: {} })).toThrow(InvalidPlanCatalogError);
    // One feature, two kinds: their rows would sum into nonsense.
    expect(() =>
      definePlans({
        lines: {
          a: { name: "A", features: { f: { kind: "flag", label: "F" } }, tiers: [{ ...tier("x"), features: { f: true } }] },
          b: { name: "B", features: { f: { kind: "quota", label: "F" } }, tiers: [{ ...tier("y"), features: { f: 3 } }] },
        },
      }),
    ).toThrow(/is a flag in one product line and a quota/);
    // A value for a feature the tier's line doesn't sell (another line's) is refused at construction.
    expect(() =>
      definePlans({
        lines: {
          a: { name: "A", features: { f: { kind: "flag", label: "F" } }, tiers: [{ ...tier("x"), features: { f: true } }] },
          b: { name: "B", features: {}, tiers: [{ ...tier("y"), features: { f: true } as unknown as Record<string, never> }] },
        },
      }),
    ).toThrow(/the "b" line does not declare/);
    // Two highlights in ONE line is still refused.
    expect(() =>
      definePlans({
        lines: { a: { name: "A", features: {}, tiers: [{ ...tier("x"), highlight: true }, { ...tier("y"), highlight: true }] } },
      }),
    ).toThrow(/both "x" and "y" are highlighted/);
  });
});

describe("planLineRefs and the line-scoped grant diff", () => {
  const weatherBasic = TWO_LINES.tier("weather-basic")!;
  const weatherPro = TWO_LINES.tier("weather-pro")!;
  const sports = TWO_LINES.tier("sports")!;
  // A tenant on Weather Basic AND Sports, with alerts used on both.
  const held: PlanGrant[] = [...grantsForPlan(weatherBasic), ...grantsForPlan(sports)];

  it("one line: no scope at all (every plan row is the line's, as before lines)", () => {
    expect(planLineRefs(ONE_LINE, DEFAULT_PLAN_LINE)).toBeUndefined();
    expect(planLineRefs(TWO_LINES, "weather")).toEqual(new Set(["weather-basic", "weather-pro"]));
    expect(planLineRefs(TWO_LINES, "sports")).toEqual(new Set(["sports"]));
  });

  it("upgrading Weather updates Weather's rows in place and leaves Sports' rows alone", () => {
    const diff = planGrantDiff(held, weatherPro, { refs: planLineRefs(TWO_LINES, "weather") });
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
    expect(diff.change.map((c) => [c.feature, c.previous.sourceRef, c.next.sourceRef, c.next.limitValue])).toEqual([
      ["alert_rules", "weather-basic", "weather-pro", 25],
      ["weather_live", "weather-basic", "weather-pro", 1],
      ["weather_tools", "weather-basic", "weather-pro", 1],
    ]);
    // NEGATIVE CONTROL: unscoped, the shared `alert_rules` feature matches
    // whichever row comes first and Sports' live row is REMOVED as an orphan.
    const unscoped = planGrantDiff(held, weatherPro);
    expect(unscoped.remove.some((grant) => grant.sourceRef === "sports")).toBe(true);
  });

  it("cancelling Sports removes only Sports' rows", () => {
    const diff = planGrantDiff(held, null, { refs: planLineRefs(TWO_LINES, "sports") });
    expect(diff.remove.map((grant) => grant.sourceRef)).toEqual(["sports", "sports"]);
    expect(diff.add).toEqual([]);
    expect(diff.change).toEqual([]);
    // NEGATIVE CONTROL: unscoped, a cancellation takes Weather's rows too.
    expect(planGrantDiff(held, null).remove.some((grant) => grant.sourceRef === "weather-basic")).toBe(true);
  });

  it("refuses a tier from another line (it would rewrite that line's rows)", () => {
    expect(() => planGrantDiff(held, sports, { refs: planLineRefs(TWO_LINES, "weather") })).toThrow(InvalidPlanKeyError);
  });
});

describe("combineStandings", () => {
  const s = (state: PlanStanding["state"], until: Date | null = null): PlanStanding => ({
    state,
    open: state !== "ended" && state !== "none",
    until,
    tierKey: null,
  });

  it("the best line wins: one paid line keeps the tenant open whatever the other says", () => {
    expect(combineStandings([s("ended"), s("active")]).state).toBe("active");
    expect(combineStandings([s("none"), s("grace", new Date(5))]).state).toBe("grace");
    expect(combineStandings([s("ended"), s("none")]).state).toBe("ended");
    expect(combineStandings([])).toEqual({ state: "none", open: false, until: null, tierKey: null });
    // A tie goes to the one that lasts longer (null: it doesn't stop by itself).
    expect(combineStandings([s("ending", new Date(10)), s("ending", new Date(20))]).until).toEqual(new Date(20));
    expect(combineStandings([s("active", new Date(10)), s("active", null)]).until).toBeNull();
  });
});

describe("standing per line (PGlite)", () => {
  const NOW = new Date("2026-10-16T12:00:00Z");

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
      insert into plans (id, key, name, interval) values
        ('pw', 'weather-pro:month:usd', 'Weather Pro', 'month'),
        ('ps', 'sports:month:usd', 'Sports', 'month');
      -- Weather Pro, paying (an older row, mirrored before lines: it still says 'main').
      insert into subscriptions (id, tenant_id, plan_id, line, stripe_subscription_id, stripe_item_id, stripe_customer_id, status, created_at)
        values ('s1', 't', 'pw', 'main', 'sub_1', null, 'cus_1', 'active', '2026-09-01'),
      -- Sports, on the same Stripe subscription, removed yesterday (the newest row).
               ('s2', 't', 'ps', 'sports', 'sub_1', 'si_s', 'cus_1', 'canceled', '2026-10-01');
      insert into entitlements (id, tenant_id, feature, limit_value, used_value, source, source_ref) values
        ('e1', 't', 'weather_live', 1, 0, 'plan', 'weather-pro'),
        ('e2', 't', 'alert_rules', 25, 4, 'plan', 'weather-pro');
    `);
    return { pg, db: drizzle(pg) };
  }

  it("each line stands on its own; the tenant is open while any line is", async () => {
    const { pg, db } = await setup();
    const plan = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0, plans: TWO_LINES });
    expect(plan.lines.get("weather")?.standing).toMatchObject({ state: "active", open: true, tierKey: "weather-pro" });
    expect(plan.lines.get("sports")?.standing).toMatchObject({ state: "ended", open: false, tierKey: "sports" });
    expect(plan.lines.get("sports")?.subscription).toMatchObject({ stripeSubscriptionId: "sub_1", stripeItemId: "si_s" });
    expect(plan.standing).toMatchObject({ state: "active", open: true });
    expect(plan.entitlements.get("alert_rules")).toMatchObject({ limit: 25, used: 4 });
    // NEGATIVE CONTROL: read as one line, the newest row (Sports, cancelled) is
    // the whole tenant's subscription — Weather Pro's own standing is lost.
    const flat = await loadCompanyPlan(db, { tenantId: "t", now: NOW, trialStartedAt: null, trialDays: 0 });
    expect(flat.standing.tierKey).toBe("sports");
    expect([...flat.lines.keys()]).toEqual([DEFAULT_PLAN_LINE]);
    await pg.close();
  });

  it("every live line on the one Stripe subscription, newest first; a row from before lines is placed by its tier", async () => {
    const { pg, db } = await setup();
    await pg.exec(`update subscriptions set status = 'active' where id = 's2'`);
    const lines = await liveStripeLines(db, "t");
    expect(lines.map((line) => [line.planKey, line.stripeSubscriptionId, line.stripeItemId])).toEqual([
      ["sports:month:usd", "sub_1", "si_s"],
      ["weather-pro:month:usd", "sub_1", null],
    ]);
    expect(lineOfStoredRow(TWO_LINES, "weather-pro:month:usd", "main")).toBe("weather");
    expect(lineOfStoredRow(undefined, "weather-pro:month:usd", "main")).toBe("main");
    expect((await liveStripeSubscription(db, "t"))?.stripeSubscriptionId).toBe("sub_1");
    await pg.close();
  });
});
