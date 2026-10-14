import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULING_SETTINGS,
  settingsToPolicy,
  updateSchedulingSettingsSchema,
} from "__SCOPE__/scheduling";
import {
  BOOK_VISIT_PATH,
  DEFAULT_SCHEDULING_TIME_ZONE,
  FIRST_SERVICE,
  SCHEDULING_RATE_LIMITS,
  firstSchedulingSettings,
  schedulingDeliveryStatus,
  schedulingLinks,
} from "@/server/scheduling-config";

/**
 * The decisions this project makes about scheduling in BOTH modes, checked
 * without a database. (The single-business mode's own — the fixed business,
 * its staff keys, the crew staff role — are in scheduling-staff.test.ts.) The route files are a few lines that pass these to the package's
 * handlers; what can be wrong is here.
 */

describe("the first settings a business starts with", () => {
  it("uses the zone it was given, when it is a real one", () => {
    const settings = firstSchedulingSettings({ businessName: "Acme Windows", timeZone: "America/New_York" });
    expect(settings.timeZone).toBe("America/New_York");
    expect(settings.businessName).toBe("Acme Windows");
  });

  it("falls back to Mountain Time for a missing or unknown zone, never to UTC", () => {
    // UTC is the package's default for a business that never saved settings,
    // which offers a Salt Lake City customer 3 PM as 9 AM. The first settings
    // exist to stop that.
    for (const timeZone of [undefined, "", "  ", "Mars/Olympus_Mons", "MST7MDT-ish"]) {
      expect(firstSchedulingSettings({ businessName: "Acme", timeZone }).timeZone).toBe(DEFAULT_SCHEDULING_TIME_ZONE);
    }
    expect(DEFAULT_SCHEDULING_TIME_ZONE).not.toBe(DEFAULT_SCHEDULING_SETTINGS.timeZone);
  });

  it("requires an address, because the crew drives to it", () => {
    expect(firstSchedulingSettings({ businessName: "Acme" }).requireAddress).toBe(true);
  });

  it("offers one service the package accepts, and nothing it would refuse at save time", () => {
    const settings = firstSchedulingSettings({ businessName: "Acme", timeZone: "America/Denver" });
    expect(settings.services).toEqual([expect.objectContaining({ ...FIRST_SERVICE })]);
    // The same schema the settings screen saves through.
    expect(updateSchedulingSettingsSchema.safeParse(settings).success).toBe(true);
    // And the policy the public booking page is built from takes it: the one
    // service's length is a length the request form may ask for.
    const policy = settingsToPolicy({
      ...DEFAULT_SCHEDULING_SETTINGS,
      timeZone: "America/Denver",
      services: [{ ...FIRST_SERVICE }],
    });
    expect(policy.durationsMinutes).toContain(FIRST_SERVICE.durationMinutes);
  });

  it("cuts a long project name to what the settings accept rather than failing the first request", () => {
    const settings = firstSchedulingSettings({ businessName: "x".repeat(300) });
    expect(settings.businessName?.length).toBe(120);
  });

  it("starts with online booking OFF and no name, until the owner has looked (BO-08)", () => {
    // The first deploy used to put a live booking page up under the folder
    // name, in a guessed zone. Now nothing is offered until the owner switches
    // it on, and no email signs off with "sched04".
    const settings = firstSchedulingSettings({});
    expect(settings.publicBookingEnabled).toBe(false);
    expect(settings.businessName).toBe("");
  });
});

describe("what the staff screens are told about email (BO-04)", () => {
  const base = {
    commsInstalled: true,
    emailConfigured: true,
    cronSecretSet: true,
    reminderRuns: { dailyAtUtc: "14:00" },
    failedLastWeek: 0,
    overdueReminders: 0,
    overdueSince: null,
    timeZone: "America/Denver",
  } as const;

  it("says emails are on only when a sender is configured", () => {
    expect(schedulingDeliveryStatus(base)).toMatchObject({ customerEmails: true, reminders: true, problems: [] });
    const off = schedulingDeliveryStatus({ ...base, emailConfigured: false });
    expect(off.customerEmails).toBe(false);
    expect(off.customerEmailsOffReason).toContain("RESEND_API_KEY");
    expect(off.reminders).toBe(false);
  });

  it("says reminders are off without the cron secret", () => {
    const status = schedulingDeliveryStatus({ ...base, cronSecretSet: false });
    expect(status.customerEmails).toBe(true);
    expect(status.reminders).toBe(false);
    expect(status.remindersOffReason).toContain("CRON_SECRET");
  });

  it("says nothing goes out at all without comms", () => {
    expect(schedulingDeliveryStatus({ ...base, commsInstalled: false })).toMatchObject({ customerEmails: false, reminders: false });
  });

  it("names failures and a stalled cron in plain words, with the day in the business's zone", () => {
    const status = schedulingDeliveryStatus({
      ...base,
      failedLastWeek: 2,
      overdueReminders: 3,
      overdueSince: new Date("2026-03-11T03:00:00Z"),
    });
    expect(status.problems).toEqual([
      "2 visit emails couldn't be sent in the last 7 days. Messages shows which, and why.",
      expect.stringContaining("3 reminders are waiting to go out: the daily reminder job hasn't run since about Tue, Mar 10."),
    ]);
  });
});

describe("the public API's throttle", () => {
  it("has a budget for every bucket the handler asks about, tightest where it holds time", () => {
    expect(Object.keys(SCHEDULING_RATE_LIMITS).sort()).toEqual(["manage", "read", "request"]);
    const perHour = (bucket: keyof typeof SCHEDULING_RATE_LIMITS) =>
      (SCHEDULING_RATE_LIMITS[bucket].limit * 3_600_000) / SCHEDULING_RATE_LIMITS[bucket].windowMs;
    expect(perHour("request")).toBeLessThan(perHour("manage"));
    expect(perHour("manage")).toBeLessThan(perHour("read"));
  });
});

describe("links on this deployment", () => {
  it("are absolute, because they leave the site in an email", () => {
    const links = schedulingLinks("https://acme.example");
    expect(links.book).toBe("https://acme.example/book-visit");
    expect(links.admin).toBe("https://acme.example/admin/schedule");
    expect(links.manage("tok_123")).toBe("https://acme.example/visit/tok_123");
  });

  it("join the same with or without a trailing slash, and under a path", () => {
    expect(schedulingLinks("https://acme.example/").book).toBe("https://acme.example/book-visit");
    expect(schedulingLinks("https://acme.example/app").book).toBe("https://acme.example/app/book-visit");
  });

  it("encode the token, so it stays one path segment", () => {
    expect(schedulingLinks("https://acme.example").manage("a/b?c")).toBe("https://acme.example/visit/a%2Fb%3Fc");
  });

  it("point the booking link at the page this overlay ships", () => {
    expect(new URL(schedulingLinks("https://acme.example").book).pathname).toBe(BOOK_VISIT_PATH);
  });

  it("include the sign-in page a new crew member is sent to", () => {
    expect(schedulingLinks("https://acme.example").signIn).toBe("https://acme.example/sign-in");
  });
});
