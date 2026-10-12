import { describe, expect, it } from "vitest";
import {
  adminErrorText,
  driveLabel,
  expiresIn,
  groupTimeOff,
  issuesByField,
  nextWindow,
  noticeMinutes,
  noticeParts,
  serviceKeyFrom,
  strandedVisitsWarning,
  visitActions,
  weekFromWindows,
  weekProblem,
  windowsFromWeek,
} from "../admin/helpers.js";
import { dayRange, dragStart, layoutLanes, positionVisit, PX_PER_MINUTE, shiftEnd, snapMinutes, weekDates } from "../admin/layout.js";
import {
  buildVisitRequest,
  cutoffMessage,
  EMPTY_VISIT_FORM,
  firstInvalidField,
  friendlyError,
  issuesToFieldErrors,
  toPublicStatusLabel,
  validateVisitForm,
} from "../form.js";
import {
  addDays,
  describeVisitWhen,
  formatClock,
  formatTimeRange,
  googleCalendarUrl,
  groupByPartOfDay,
  groupSlotsByDay,
  partOfDay,
  todayIn,
  zoneAbbreviation,
  zoneLabel,
} from "../time.js";
import { SLOTS, snapshot } from "./fakes.js";

const clean = (s: string) => s.replace(/[   ]/g, " ");

describe("times on the business's clock", () => {
  it("formats wall-clock text without converting it", () => {
    expect(clean(formatClock("09:30"))).toBe("9:30 AM");
    expect(clean(formatClock("13:00"))).toBe("1:00 PM");
    expect(formatClock("24:00")).toBe("midnight");
    expect(clean(formatTimeRange("09:00", "10:00"))).toMatch(/^9:00 – 10:00 AM$/);
    expect(clean(formatTimeRange("11:00", "13:30"))).toMatch(/11:00 AM – 1:30 PM/);
    expect(clean(formatTimeRange("22:00", "24:00"))).toBe("10:00 PM – midnight");
  });

  it("names the zone for the date in view: MDT in October, MST in November", () => {
    expect(zoneAbbreviation("America/Denver", "2026-10-30T16:00:00.000Z")).toBe("MDT");
    expect(zoneAbbreviation("America/Denver", "2026-11-02T16:00:00.000Z")).toBe("MST");
    expect(zoneLabel("America/Denver", "2026-11-02T16:00:00.000Z")).toBe("Mountain Time (MST)");
  });

  it("describes a visit with its date, range and zone", () => {
    expect(clean(describeVisitWhen({ date: "2026-11-02", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-02T16:00:00.000Z", timeZone: "America/Denver" }))).toBe(
      "Monday, November 2, 9:00 – 10:00 AM MST",
    );
  });

  it("today is the business's date: 8 PM in Denver is still today", () => {
    // 2026-10-30 02:00Z is Oct 29, 8 PM MDT; UTC has already rolled over.
    expect(todayIn("America/Denver", Date.parse("2026-10-30T02:00:00Z"))).toBe("2026-10-29");
    expect(todayIn("UTC", Date.parse("2026-10-30T02:00:00Z"))).toBe("2026-10-30");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });

  it("groups slots by their date, in time order, duplicates dropped", () => {
    const days = groupSlotsByDay([SLOTS[2]!, SLOTS[1]!, SLOTS[0]!, SLOTS[0]!]);
    expect(days.map((d) => [d.date, d.slots.map((s) => s.startTime)])).toEqual([
      ["2026-11-02", ["09:00", "13:30"]],
      ["2026-11-03", ["10:00"]],
    ]);
    expect(groupByPartOfDay(days[0]!.slots).map((g) => g.label)).toEqual(["Morning", "Afternoon"]);
    expect([partOfDay("11:59"), partOfDay("12:00"), partOfDay(17 * 60)]).toEqual(["morning", "afternoon", "evening"]);
  });

  it("builds an Add to Google Calendar link from the instants, needing no key", () => {
    const url = googleCalendarUrl({
      title: "Free estimate — Acme Windows",
      startsAt: "2026-11-02T16:00:00.000Z",
      endsAt: "2026-11-02T17:00:00.000Z",
      location: "123 Main St",
      timeZone: "America/Denver",
    })!;
    const params = new URL(url).searchParams;
    expect(url.startsWith("https://calendar.google.com/calendar/render?")).toBe(true);
    expect(params.get("dates")).toBe("20261102T160000Z/20261102T170000Z");
    expect(params.get("location")).toBe("123 Main St");
    expect(params.get("ctz")).toBe("America/Denver");
    expect(googleCalendarUrl({ title: "x", startsAt: "", endsAt: "" })).toBeNull();
  });
});

describe("the visit form", () => {
  it("mirrors the server's checks", () => {
    expect(validateVisitForm(EMPTY_VISIT_FORM, { requireAddress: true })).toEqual({
      name: "Enter your name.",
      email: "Enter your email address.",
      address: "Enter the address where the visit is.",
    });
    expect(validateVisitForm({ ...EMPTY_VISIT_FORM, name: "J", email: "nope" }, { requireAddress: false })).toEqual({
      email: "Enter an email address like you@example.com.",
    });
    const long = validateVisitForm({ ...EMPTY_VISIT_FORM, name: "x".repeat(201), email: "a@b.co", notes: "n".repeat(2001), phone: "1".repeat(61) }, { requireAddress: false });
    expect(Object.keys(long).sort()).toEqual(["name", "notes", "phone"]);
    expect(firstInvalidField({ notes: "x", email: "y" })).toBe("email");
  });

  it("builds the request: trimmed, empty optionals left out, honeypot only when filled", () => {
    const body = buildVisitRequest({
      slotId: "s1",
      service: "estimate",
      values: { ...EMPTY_VISIT_FORM, name: " Jane ", email: " jane@example.com ", address: " 1 Main ", phone: "  " },
      fillMs: 4321.6,
      estimateId: "est_9",
    });
    expect(body).toEqual({ slotId: "s1", service: "estimate", name: "Jane", email: "jane@example.com", address: "1 Main", fillMs: 4322, estimateId: "est_9" });
    expect(buildVisitRequest({ slotId: "s", service: "e", values: { ...EMPTY_VISIT_FORM, website: "spam.example" }, fillMs: 0 }).website).toBe("spam.example");
  });

  it("maps server issues onto fields by wire name", () => {
    expect(issuesToFieldErrors([{ path: ["email"], message: "Bad" }, { path: ["slotId"], message: "x" }, { path: ["address"], message: "Where?" }])).toEqual({
      email: "Bad",
      address: "Where?",
    });
  });

  it("speaks to customers in plain words", () => {
    const err = (code: never, message = "") => ({ code, message, status: 409 });
    expect(friendlyError(err("slot_unavailable" as never), "request")).toBe("That time was just taken. Pick another.");
    expect(friendlyError(err("too_many_requests" as never), "request")).toBe("You already have visits booked or waiting with us. Please call or email us to book another.");
    expect(friendlyError(err("too_soon" as never, "Book at least 24 hours ahead."), "request")).toBe("Book at least 24 hours ahead.");
    expect(friendlyError({ code: "bad_response", message: "", status: 429 }, "request")).toMatch(/lot of tries/);
    expect(friendlyError({ code: "internal", message: "TypeError: x is undefined", status: 500 }, "request")).toBe("Something went wrong on our side. Please try again.");
  });

  it("names every status in the customer's words", () => {
    expect(toPublicStatusLabel("requested", "Acme Windows")).toBe("Waiting for Acme Windows to confirm");
    expect(toPublicStatusLabel("declined", "Acme Windows")).toBe("Acme Windows couldn't make this time");
    expect(toPublicStatusLabel("expired", "Acme")).toBe("Not confirmed in time");
    expect(toPublicStatusLabel("completed", "Acme")).toBe("Done");
    expect(toPublicStatusLabel("missed", "Acme")).toBe("Didn't happen");
  });

  it("says why the cutoff stops online changes, with the phone number", () => {
    expect(cutoffMessage({ cancelCutoffHours: 24, contactPhone: "(801) 555-0143", contactEmail: null })).toBe(
      "This visit starts within 24 hours, so it can't be changed online. Call (801) 555-0143.",
    );
    expect(cutoffMessage({ cancelCutoffHours: 0, contactPhone: null, contactEmail: "o@a.test" })).toBe(
      "This visit has started, so it can't be changed online. Email o@a.test.",
    );
  });
});

describe("calendar geometry", () => {
  it("snaps to the grid and clamps a visit inside the day", () => {
    expect(snapMinutes(614, 30)).toBe(600);
    expect(snapMinutes(616, 30)).toBe(630);
    expect(snapMinutes(-50, 15)).toBe(0);
    expect(snapMinutes(1430, 30, { max: 1440 - 60 })).toBe(1380);
  });

  it("turns a vertical drag into a snapped start that keeps the length", () => {
    const visit = { startTime: "09:00", endTime: "10:00" };
    expect(dragStart(visit, 60 * PX_PER_MINUTE, 30)).toBe("10:00");
    expect(dragStart(visit, 37 * PX_PER_MINUTE, 30)).toBe("09:30");
    expect(dragStart(visit, 10_000, 30)).toBe("23:00");
    expect(dragStart(visit, -10_000, 30)).toBe("00:00");
    expect(shiftEnd(visit, "13:30")).toBe("14:30");
  });

  it("draws the day from the earliest window to the latest, widened for visits", () => {
    expect(dayRange([], [])).toEqual({ startMinute: 420, endMinute: 1140 });
    expect(dayRange([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:30" }], [{ startTime: "06:15", endTime: "07:00" }])).toEqual({
      startMinute: 360,
      endMinute: 1080,
    });
    expect(positionVisit({ startTime: "09:00", endTime: "10:00" }, { startMinute: 480, endMinute: 1080 })).toEqual({ top: 96, height: 96 });
    expect(positionVisit({ startTime: "09:00", endTime: "09:15" }, { startMinute: 480, endMinute: 1080 }).height).toBe(44);
  });

  it("puts overlapping visits side by side", () => {
    const lanes = layoutLanes([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 570, end: 630 },
      { id: "c", start: 600, end: 660 },
      { id: "d", start: 700, end: 760 },
    ]);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("c")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("d")).toEqual({ lane: 0, lanes: 1 });
  });

  it("gives the week holding a date, Monday first", () => {
    expect(weekDates("2026-11-04")).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(weekDates("2026-11-01", 0)[0]).toBe("2026-11-01");
  });
});

describe("staff rules and words", () => {
  it("offers only the moves the server allows, in staff words", () => {
    expect(visitActions(snapshot({ status: "pending", nextStatuses: ["confirmed", "declined", "cancelled"] })).map((a) => a.label)).toEqual(["Accept", "Decline"]);
    expect(visitActions(snapshot()).map((a) => a.label)).toEqual(["Start", "Complete", "No-show", "Cancel visit"]);
    expect(visitActions(snapshot({ status: "expired", nextStatuses: ["confirmed"] })).map((a) => a.label)).toEqual(["Restore"]);
    expect(visitActions(snapshot({ status: "completed", nextStatuses: [] }))).toEqual([]);
  });

  it("shows a refusal's own reason, and fixed words for the rest", () => {
    expect(adminErrorText({ code: "slot_unavailable", message: "Overlaps 10:00–12:00", status: 409 })).toBe("Overlaps 10:00–12:00");
    expect(adminErrorText({ code: "forbidden", message: "nope", status: 403 })).toBe("You don't have permission to do that.");
    expect(adminErrorText({ code: "internal", message: "stack trace", status: 500 })).toBe("Something went wrong on our side. Please try again.");
    expect(issuesByField({ code: "invalid", message: "", status: 400, issues: [{ path: ["services", 0, "name"], message: "Name it" }] })).toEqual({
      "services.0.name": "Name it",
      services: "Name it",
    });
  });

  it("counts down a request's time left", () => {
    const now = Date.parse("2026-10-29T15:00:00Z");
    expect(expiresIn("2026-10-29T20:00:00Z", now)).toBe("expires in 5 h");
    expect(expiresIn("2026-10-29T15:40:00Z", now)).toBe("expires in 40 min");
    expect(expiresIn("2026-11-01T15:00:00Z", now)).toBe("expires in 3 days");
    expect(expiresIn(null, now)).toBeNull();
  });

  it("labels drive times, and says when they are estimates", () => {
    expect(driveLabel({ driveMinutesFromPrevious: 12, previousJobAddress: "14 Elm St" }, false)).toBe("12 min drive from the previous job (14 Elm St)");
    expect(driveLabel({ driveMinutesFromPrevious: 12, previousJobAddress: null }, true)).toBe("about 12 min drive (estimate) from the crew's base");
  });

  it("edits a week of split shifts and finds overlaps", () => {
    const week = weekFromWindows([
      { dayOfWeek: 1, startTime: "13:00", endTime: "17:00" },
      { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
    ]);
    expect(week[1]).toEqual([
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ]);
    expect(weekProblem(week)).toBeNull();
    expect(windowsFromWeek(week)).toHaveLength(2);
    expect(weekProblem(week.map((d, i) => (i === 1 ? [...d, { start: "11:00", end: "14:00" }] : d)))).toBe("Monday: two blocks of hours overlap.");
    expect(nextWindow([{ start: "08:00", end: "12:00" }])).toEqual({ start: "13:00", end: "17:00" });
  });

  it("groups days off into ranges and warns about booked visits", () => {
    const ranges = groupTimeOff([
      { id: "a", date: "2026-11-03", note: "Vacation" },
      { id: "b", date: "2026-11-02", note: "Vacation" },
      { id: "c", date: "2026-11-05", note: null },
    ]);
    expect(ranges.map((r) => [r.from, r.to, r.days, r.ids])).toEqual([
      ["2026-11-02", "2026-11-03", 2, ["b", "a"]],
      ["2026-11-05", "2026-11-05", 1, ["c"]],
    ]);
    expect(strandedVisitsWarning(3)).toBe("3 visits are booked on those days. Move them from the calendar.");
    expect(strandedVisitsWarning(0)).toBeNull();
  });

  it("makes service keys and notice units an owner can read", () => {
    expect(serviceKeyFrom("Free estimate!", [])).toBe("free-estimate");
    expect(serviceKeyFrom("Free estimate", ["free-estimate"])).toBe("free-estimate-2");
    expect(noticeParts(1440)).toEqual({ amount: 1, unit: "days" });
    expect(noticeParts(90)).toEqual({ amount: 1.5, unit: "hours" });
    expect(noticeMinutes(2, "days")).toBe(2880);
  });
});
