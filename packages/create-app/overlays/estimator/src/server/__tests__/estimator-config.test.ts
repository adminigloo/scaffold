import { describe, expect, it } from "vitest";
import { DEFAULT_TAKEOFF_MODEL, TAKEOFF_MODEL_RATES } from "__SCOPE__/estimator";
import {
  DEFAULT_ESTIMATOR_TAKEOFF_MODEL,
  DEFAULT_ESTIMATOR_TIME_ZONE,
  ESTIMATOR_FAIL_CLOSED_BUCKETS,
  ESTIMATOR_AI_CEILING_CENTS,
  ESTIMATOR_RATE_LIMITS,
  estimatorDeliveryStatus,
  estimatorLinks,
  firstEstimatorTimeZone,
  linkedVisit,
  takeoffModelFor,
} from "../estimator-config";

/**
 * The estimator decisions this project makes, each on its own: no database,
 * no environment, no request. The routes that use them are a few lines of
 * wiring, checked from their text by the generator's own suite and run for
 * real in the browser scenario (e2e/tests/estimator-scenario.spec.ts).
 */

describe("the business", () => {
  it("starts in a real time zone, never UTC", () => {
    expect(firstEstimatorTimeZone([undefined, undefined])).toBe(DEFAULT_ESTIMATOR_TIME_ZONE);
    expect(DEFAULT_ESTIMATOR_TIME_ZONE).toBe("America/Denver");
    expect(firstEstimatorTimeZone(["America/Chicago"])).toBe("America/Chicago");
    // The estimator's own variable first, then scheduling's.
    expect(firstEstimatorTimeZone(["America/New_York", "America/Chicago"])).toBe("America/New_York");
    expect(firstEstimatorTimeZone([undefined, "America/Chicago"])).toBe("America/Chicago");
    // A typo is skipped rather than written: the next hint, or Denver.
    expect(firstEstimatorTimeZone(["Mars/Olympus_Mons", "America/Phoenix"])).toBe("America/Phoenix");
    expect(firstEstimatorTimeZone(["", "  "])).toBe("America/Denver");
    expect(firstEstimatorTimeZone([" America/Boise "])).toBe("America/Boise");
  });
});

describe("photo reading", () => {
  it("defaults to the package's choice — Claude Haiku 4.5 — and the package can price it", () => {
    expect(DEFAULT_ESTIMATOR_TAKEOFF_MODEL).toBe(DEFAULT_TAKEOFF_MODEL);
    expect(DEFAULT_ESTIMATOR_TAKEOFF_MODEL).toBe("claude-haiku-4-5");
    expect(TAKEOFF_MODEL_RATES[DEFAULT_ESTIMATOR_TAKEOFF_MODEL]).toEqual({
      inputMicrosPerMTok: 1_000_000,
      outputMicrosPerMTok: 5_000_000,
    });
  });

  it("uses ESTIMATOR_TAKEOFF_MODEL when it names one, and the default when it is blank", () => {
    expect(takeoffModelFor(undefined)).toBe("claude-haiku-4-5");
    expect(takeoffModelFor("")).toBe("claude-haiku-4-5");
    expect(takeoffModelFor("   ")).toBe("claude-haiku-4-5");
    expect(takeoffModelFor(" claude-sonnet-5 ")).toBe("claude-sonnet-5");
  });

  it("caps one company's day of photo reading at $1 in a companies project (D14)", () => {
    // Every company's reading spends the platform's AI key; the ceiling is
    // what an owner's own budget is held under.
    expect(ESTIMATOR_AI_CEILING_CENTS).toBe(100);
    expect(Number.isInteger(ESTIMATOR_AI_CEILING_CENTS)).toBe(true);
  });

  it("refuses to read a photo when the throttle's store is down — reading spends money", () => {
    expect([...ESTIMATOR_FAIL_CLOSED_BUCKETS]).toEqual(["takeoff"]);
    // Ten readings an hour from one visitor, on top of the package's own daily
    // budget and per-visitor count.
    expect(ESTIMATOR_RATE_LIMITS.takeoff).toEqual({ limit: 10, windowMs: 60 * 60 * 1000 });
  });
});

describe("the public API's throttle", () => {
  it("bounds every bucket the handler asks about", () => {
    expect(Object.keys(ESTIMATOR_RATE_LIMITS).sort()).toEqual(["calculate", "photo", "read", "respond", "submit", "takeoff"]);
    for (const policy of Object.values(ESTIMATOR_RATE_LIMITS)) {
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowMs).toBeGreaterThan(0);
    }
    // A lead is the one that writes a row a person must read: five an hour.
    expect(ESTIMATOR_RATE_LIMITS.submit).toEqual({ limit: 5, windowMs: 60 * 60 * 1000 });
    // The live price follows every keystroke: plenty.
    expect(ESTIMATOR_RATE_LIMITS.calculate.limit).toBeGreaterThanOrEqual(60);
  });
});

describe("what the staff screens are told about email", () => {
  it("says plainly why nothing is emailed", () => {
    expect(estimatorDeliveryStatus({ commsInstalled: false, emailConfigured: false, cronSecretSet: false })).toMatchObject({
      emails: false,
      followUps: false,
      note: expect.stringContaining("set up without customer emails"),
    });
    expect(estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: false, cronSecretSet: true })).toMatchObject({
      emails: false,
      followUps: false,
      note: expect.stringContaining("RESEND_API_KEY"),
    });
    expect(estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: true, cronSecretSet: false })).toMatchObject({
      emails: true,
      followUps: false,
      note: expect.stringContaining("CRON_SECRET"),
    });
    expect(estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: true, cronSecretSet: true })).toEqual({
      emails: true,
      followUps: true,
      note: null,
    });
  });
});

describe("links", () => {
  it("are absolute, whatever shape the app's address takes, and keep a token in one path segment", () => {
    for (const base of ["https://summit.example", "https://summit.example/"]) {
      const links = estimatorLinks(base);
      expect(links.estimatePage).toBe("https://summit.example/estimate");
      expect(links.quote("abc_DEF-123")).toBe("https://summit.example/quote/abc_DEF-123");
      expect(links.adminEstimate("est 1")).toBe("https://summit.example/admin/estimates/est%201");
      expect(links.embedBase).toBe("https://summit.example/api/estimator");
      expect(links.bookVisit("e1")).toBe("https://summit.example/book-visit?estimate=e1");
      expect(links.scheduleAdmin).toBe("https://summit.example/admin/schedule");
    }
    expect(estimatorLinks("https://example.com/app").quote("t/../x")).toBe("https://example.com/app/quote/t%2F..%2Fx");
  });
});

describe("a visit booked from an estimate", () => {
  const scheduleAdmin = "https://summit.example/admin/schedule";

  it("is listed in the business's zone, with its status in words and a link to its day", () => {
    const visit = linkedVisit(
      {
        id: "v1",
        status: "confirmed",
        // Monday 2026-11-02 09:00 in Denver (MST, after the clocks fell back).
        startsAt: new Date("2026-11-02T16:00:00Z"),
        scheduledDate: new Date("2026-11-02T00:00:00Z"),
        startTime: "09:00",
      },
      "America/Denver",
      scheduleAdmin,
    );
    expect(visit).toEqual({
      id: "v1",
      when: "Mon, Nov 2, 9:00 AM MST",
      status: "confirmed",
      url: "https://summit.example/admin/schedule?date=2026-11-02",
    });
  });

  it("says a request is a request, and reads an old row with no start instant", () => {
    const visit = linkedVisit(
      { id: "v2", status: "pending", startsAt: null, scheduledDate: new Date("2026-10-30T00:00:00Z"), startTime: "13:30" },
      "America/Denver",
      scheduleAdmin,
    );
    expect(visit.when).toBe("Fri, Oct 30, 1:30 PM");
    expect(visit.status).toBe("requested");
    expect(visit.url).toBe("https://summit.example/admin/schedule?date=2026-10-30");
    const started = linkedVisit(
      { id: "v3", status: "in_progress", startsAt: null, scheduledDate: new Date("2026-10-30T00:00:00Z"), startTime: "13:30" },
      "UTC",
      scheduleAdmin,
    );
    expect(started.status).toBe("in progress");
  });
});
