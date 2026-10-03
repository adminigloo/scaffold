import { describe, expect, it } from "vitest";
import {
  expandBusy,
  IcsParseError,
  parseContentLine,
  parseIcsBusy,
  parseIcsCalendar,
  parseIcsDuration,
  parseRrule,
  resolveTzid,
  unfoldLines,
} from "../ical.js";

const DENVER = "America/Denver";

/** Wrap VEVENT bodies in a calendar; lines joined with CRLF like a real export. */
function cal(events: string[], header: string[] = []): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...header,
    ...events.flatMap((event) => ["BEGIN:VEVENT", ...event.trim().split("\n").map((line) => line.trim()), "END:VEVENT"]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function busy(ics: string, from: string, to: string, timezone = DENVER, maxInstances?: number): string[] {
  return parseIcsBusy(ics, {
    from: new Date(from),
    to: new Date(to),
    timezone,
    ...(maxInstances === undefined ? {} : { maxInstances }),
  }).map((interval) => `${interval.start.toISOString().slice(0, 16)}/${interval.end.toISOString().slice(0, 16)}`);
}

/**
 * A realistic Google Calendar "secret address in iCal format" export: the
 * VTIMEZONE block Google always emits (ignored — the TZID is resolved by name
 * with Intl), a folded DESCRIPTION, a weekly series with an EXDATE and a
 * moved instance, an all-day transparent birthday, an all-day opaque
 * vacation, a UTC one-off, a cancelled event and a "free" event.
 */
const GOOGLE_EXPORT = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:dallin@example.com",
  "X-WR-TIMEZONE:America/Denver",
  "BEGIN:VTIMEZONE",
  "TZID:America/Denver",
  "X-LIC-LOCATION:America/Denver",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0600",
  "TZNAME:MDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0600",
  "TZOFFSETTO:-0700",
  "TZNAME:MST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Denver:20260914T100000",
  "DTEND;TZID=America/Denver:20260914T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
  "EXDATE;TZID=America/Denver:20261007T100000",
  "DTSTAMP:20261001T120000Z",
  "UID:7kukuqrfedlm2f9t3vqm1@google.com",
  "CREATED:20260901T000000Z",
  "DESCRIPTION:Weekly standup\\, with notes that run long enough to need foldi",
  " ng across more than one line in the export",
  "LAST-MODIFIED:20260901T000000Z",
  "LOCATION:",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Standup",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Denver:20261012T140000",
  "DTEND;TZID=America/Denver:20261012T150000",
  "DTSTAMP:20261001T120000Z",
  "UID:7kukuqrfedlm2f9t3vqm1@google.com",
  "RECURRENCE-ID;TZID=America/Denver:20261012T100000",
  "SEQUENCE:1",
  "STATUS:CONFIRMED",
  "SUMMARY:Standup (moved)",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261009",
  "DTEND;VALUE=DATE:20261010",
  "RRULE:FREQ=YEARLY",
  "DTSTAMP:20261001T120000Z",
  "UID:birthday@google.com",
  "SUMMARY:Birthday",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261015",
  "DTEND;VALUE=DATE:20261017",
  "DTSTAMP:20261001T120000Z",
  "UID:vacation@google.com",
  "SUMMARY:Out of office",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261013T200000Z",
  "DTEND:20261013T203000Z",
  "DTSTAMP:20261001T120000Z",
  "UID:dentist@google.com",
  "SUMMARY:Dentist",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261014T160000Z",
  "DTEND:20261014T170000Z",
  "DTSTAMP:20261001T120000Z",
  "UID:cancelled@google.com",
  "STATUS:CANCELLED",
  "SUMMARY:Called off",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261014T180000Z",
  "DTEND:20261014T190000Z",
  "DTSTAMP:20261001T120000Z",
  "UID:free@google.com",
  "SUMMARY:Focus time (free)",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("the content-line reader", () => {
  it("unfolds continuation lines (space or tab)", () => {
    expect(unfoldLines("A:one\r\n two\r\n\tthree\r\nB:x")).toEqual(["A:onetwothree", "B:x"]);
    expect(unfoldLines("A:lf\n only")).toEqual(["A:lfonly"]);
  });

  it("splits name, params and value, honouring DQUOTEd colons and semicolons", () => {
    expect(parseContentLine('ATTENDEE;CN="Doe, Jane: CFO";ROLE=REQ-PARTICIPANT:mailto:jane@example.com')).toEqual({
      name: "ATTENDEE",
      params: { CN: "Doe, Jane: CFO", ROLE: "REQ-PARTICIPANT" },
      value: "mailto:jane@example.com",
    });
    expect(parseContentLine("dtstart;tzid=America/Denver:20261005T090000")?.name).toBe("DTSTART");
    expect(parseContentLine("garbage")).toBeNull();
  });

  it("parses durations, rules and zone names", () => {
    expect(parseIcsDuration("PT45M")).toEqual({ days: 0, seconds: 2700 });
    expect(parseIcsDuration("P1DT2H")).toEqual({ days: 1, seconds: 7200 });
    expect(parseIcsDuration("P2W")).toEqual({ days: 14, seconds: 0 });
    expect(parseIcsDuration("-PT15M")).toEqual({ days: -0, seconds: -900 });
    expect(parseIcsDuration("P")).toBeNull();
    expect(parseIcsDuration("nonsense")).toBeNull();
    expect(parseRrule("FREQ=HOURLY", DENVER)).toBeNull();
    expect(parseRrule("FREQ=MONTHLY;BYDAY=-1FR,2TU;INTERVAL=2", DENVER)?.byDay).toEqual([
      { n: -1, weekday: 5 },
      { n: 2, weekday: 2 },
    ]);
    expect(resolveTzid("America/Denver")).toBe("America/Denver");
    expect(resolveTzid("Mountain Standard Time")).toBe("America/Denver");
    expect(resolveTzid("/mozilla.org/20050126_1/America/New_York")).toBe("America/New_York");
    expect(resolveTzid("Custom Zone 1")).toBeNull();
  });

  it("refuses a body that is not a calendar (Google's HTML for a revoked address)", () => {
    expect(() => parseIcsCalendar("<!doctype html><html><body>Not found</body></html>")).toThrow(IcsParseError);
    expect(() => parseIcsCalendar("")).toThrow(IcsParseError);
  });
});

describe("a realistic Google Calendar export", () => {
  it("expands to exactly the opaque, live busy time in the window", () => {
    // Monday 2026-10-05 00:00 MDT → Monday 2026-10-19 00:00 MDT.
    expect(busy(GOOGLE_EXPORT, "2026-10-05T06:00:00Z", "2026-10-19T06:00:00Z")).toEqual([
      "2026-10-05T16:00/2026-10-05T17:00", // Mon standup, 10:00 MDT
      // Wed 7th: EXDATE.  Mon 12th: moved to 14:00 by its override.
      "2026-10-12T20:00/2026-10-12T21:00",
      "2026-10-13T20:00/2026-10-13T20:30", // dentist (UTC)
      "2026-10-14T16:00/2026-10-14T17:00", // Wed standup; the cancelled and the free event are ignored
      "2026-10-15T06:00/2026-10-17T06:00", // two all-day vacation days, in the host's zone
    ]);
  });

  it("parses the calendar zone and ignores the VTIMEZONE component", () => {
    const parsed = parseIcsCalendar(GOOGLE_EXPORT);
    expect(parsed.calendarZone).toBe("America/Denver");
    expect(parsed.events).toHaveLength(7);
  });
});

describe("time values", () => {
  it("reads TZID, UTC, floating (host zone) and Windows zone names", () => {
    const ics = cal([
      "UID:a\nDTSTART;TZID=Asia/Kolkata:20261005T093000\nDTEND;TZID=Asia/Kolkata:20261005T100000",
      "UID:b\nDTSTART:20261005T120000Z\nDTEND:20261005T123000Z",
      "UID:c\nDTSTART:20261005T090000\nDTEND:20261005T093000",
      'UID:d\nDTSTART;TZID="Mountain Standard Time":20261005T130000\nDTEND;TZID="Mountain Standard Time":20261005T133000',
    ]);
    expect(busy(ics, "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z")).toEqual([
      "2026-10-05T04:00/2026-10-05T04:30", // 09:30 IST
      "2026-10-05T12:00/2026-10-05T12:30",
      "2026-10-05T15:00/2026-10-05T15:30", // floating 09:00 read as Denver
      "2026-10-05T19:00/2026-10-05T19:30", // 13:00 "Mountain Standard Time" = Denver (MDT in October)
    ]);
  });

  it("reads an unknown TZID in the calendar's X-WR-TIMEZONE", () => {
    const ics = cal(["UID:a\nDTSTART;TZID=Custom 1:20261005T090000\nDTEND;TZID=Custom 1:20261005T100000"], [
      "X-WR-TIMEZONE:America/New_York",
    ]);
    expect(busy(ics, "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z")).toEqual(["2026-10-05T13:00/2026-10-05T14:00"]);
  });

  it("uses DURATION when there is no DTEND, and defaults sensibly when neither is given", () => {
    const ics = cal([
      "UID:a\nDTSTART:20261005T150000Z\nDURATION:PT45M",
      "UID:b\nDTSTART;VALUE=DATE:20261007\nDURATION:P2D",
      "UID:c\nDTSTART;VALUE=DATE:20261010",
      "UID:d\nDTSTART:20261005T200000Z", // zero-length: busy for no time
    ]);
    expect(busy(ics, "2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z")).toEqual([
      "2026-10-05T15:00/2026-10-05T15:45",
      "2026-10-07T06:00/2026-10-09T06:00",
      "2026-10-10T06:00/2026-10-11T06:00",
    ]);
  });

  it("includes an event that started before the window and runs into it", () => {
    const ics = cal(["UID:a\nDTSTART:20261004T200000Z\nDTEND:20261005T020000Z"]);
    expect(busy(ics, "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z")).toEqual(["2026-10-04T20:00/2026-10-05T02:00"]);
  });
});

describe("RRULE expansion", () => {
  const window = (ics: string) => busy(ics, "2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z");

  it("DAILY with COUNT and INTERVAL", () => {
    const ics = cal(["UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=3"]);
    expect(window(ics)).toEqual([
      "2026-10-05T15:00/2026-10-05T15:30",
      "2026-10-07T15:00/2026-10-07T15:30",
      "2026-10-09T15:00/2026-10-09T15:30",
    ]);
  });

  it("DAILY with UNTIL (inclusive)", () => {
    const ics = cal(["UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;UNTIL=20261007T150000Z"]);
    expect(window(ics)).toHaveLength(3);
  });

  it("COUNT counts from DTSTART even when every instance is before the window", () => {
    const ics = cal(["UID:a\nDTSTART:20260101T150000Z\nDTEND:20260101T153000Z\nRRULE:FREQ=DAILY;COUNT=5"]);
    expect(window(ics)).toEqual([]);
  });

  it("an open-ended series started years ago lands on the right days (fast-forward)", () => {
    const ics = cal(["UID:a\nDTSTART:20200101T150000Z\nDTEND:20200101T153000Z\nRRULE:FREQ=DAILY;INTERVAL=3"]);
    const out = busy(ics, "2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z");
    // 2020-01-01 + 3k days: 2026-10-01 is day 2465 (not a multiple of 3); 2466 → 10-02.
    expect(out).toEqual([
      "2026-10-02T15:00/2026-10-02T15:30",
      "2026-10-05T15:00/2026-10-05T15:30",
      "2026-10-08T15:00/2026-10-08T15:30",
    ]);
  });

  it("WEEKLY with BYDAY stays on the wall clock across the DST change", () => {
    const ics = cal([
      "UID:a\nDTSTART;TZID=America/Denver:20261026T090000\nDTEND;TZID=America/Denver:20261026T093000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    ]);
    expect(window(ics)).toEqual([
      "2026-10-26T15:00/2026-10-26T15:30", // 09:00 MDT
      "2026-11-02T16:00/2026-11-02T16:30", // 09:00 MST
      "2026-11-09T16:00/2026-11-09T16:30",
    ]);
  });

  it("WEEKLY every other week on two days, with WKST", () => {
    const ics = cal([
      "UID:a\nDTSTART:20261006T150000Z\nDTEND:20261006T160000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU;COUNT=4",
    ]);
    expect(window(ics).map((s) => s.slice(0, 10))).toEqual(["2026-10-06", "2026-10-08", "2026-10-20", "2026-10-22"]);
  });

  it("MONTHLY by ordinal weekday: the last Friday and the second Tuesday", () => {
    const lastFriday = cal(["UID:a\nDTSTART:20261030T170000Z\nDTEND:20261030T180000Z\nRRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=2"]);
    expect(window(lastFriday).map((s) => s.slice(0, 10))).toEqual(["2026-10-30", "2026-11-27"]);
    const secondTuesday = cal(["UID:b\nDTSTART:20261013T170000Z\nDTEND:20261013T180000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3"]);
    expect(window(secondTuesday).map((s) => s.slice(0, 10))).toEqual(["2026-10-13", "2026-11-10", "2026-12-08"]);
  });

  it("MONTHLY on the 31st skips the months without one (never clamps)", () => {
    const ics = cal(["UID:a\nDTSTART:20261031T170000Z\nDTEND:20261031T180000Z\nRRULE:FREQ=MONTHLY;COUNT=3"]);
    expect(busy(ics, "2026-10-01T00:00:00Z", "2027-04-01T00:00:00Z").map((s) => s.slice(0, 10))).toEqual([
      "2026-10-31",
      "2026-12-31",
      "2027-01-31",
    ]);
  });

  it("MONTHLY BYMONTHDAY=-1 and BYSETPOS=-1 (last weekday)", () => {
    const lastDay = cal(["UID:a\nDTSTART:20261031T170000Z\nDTEND:20261031T180000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3"]);
    const wide = (ics: string) => busy(ics, "2026-10-01T00:00:00Z", "2027-02-01T00:00:00Z").map((s) => s.slice(0, 10));
    expect(wide(lastDay)).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    const lastWeekday = cal([
      "UID:b\nDTSTART:20261030T170000Z\nDTEND:20261030T180000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
    ]);
    // Oct 30 is a Friday, Nov 30 a Monday, Dec 31 a Thursday, Jan 29 a Friday (Jan 31 is a Sunday).
    expect(wide(lastWeekday)).toEqual(["2026-10-30", "2026-11-30", "2026-12-31", "2027-01-29"]);
  });

  it("EXDATE (several, comma-separated) removes instances", () => {
    const ics = cal([
      "UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE:20261006T150000Z,20261008T150000Z",
    ]);
    expect(window(ics).map((s) => s.slice(0, 10))).toEqual(["2026-10-05", "2026-10-07", "2026-10-09"]);
  });

  it("EXDATE on an all-day series matches by date", () => {
    const ics = cal(["UID:a\nDTSTART;VALUE=DATE:20261005\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;VALUE=DATE:20261006"]);
    expect(window(ics)).toEqual(["2026-10-05T06:00/2026-10-06T06:00", "2026-10-07T06:00/2026-10-08T06:00"]);
  });

  it("a cancelled RECURRENCE-ID override removes just that instance", () => {
    const ics = cal([
      "UID:s\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;COUNT=3",
      "UID:s\nRECURRENCE-ID:20261006T150000Z\nDTSTART:20261006T150000Z\nDTEND:20261006T153000Z\nSTATUS:CANCELLED",
    ]);
    expect(window(ics).map((s) => s.slice(0, 10))).toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("an override marked free removes the instance; one moved keeps its new time", () => {
    const ics = cal([
      "UID:s\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;COUNT=3",
      "UID:s\nRECURRENCE-ID:20261006T150000Z\nDTSTART:20261006T150000Z\nDTEND:20261006T153000Z\nTRANSP:TRANSPARENT",
      "UID:s\nRECURRENCE-ID:20261007T150000Z\nDTSTART:20261007T190000Z\nDTEND:20261007T200000Z",
    ]);
    expect(window(ics)).toEqual(["2026-10-05T15:00/2026-10-05T15:30", "2026-10-07T19:00/2026-10-07T20:00"]);
  });

  it("a cancelled or transparent master contributes nothing", () => {
    const ics = cal([
      "UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY;COUNT=3\nSTATUS:CANCELLED",
      "UID:b\nDTSTART:20261005T170000Z\nDTEND:20261005T173000Z\nRRULE:FREQ=DAILY;COUNT=3\nTRANSP:TRANSPARENT",
    ]);
    expect(window(ics)).toEqual([]);
  });

  it("RDATE adds instances at their own times", () => {
    const ics = cal(["UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRDATE:20261009T180000Z"]);
    expect(window(ics)).toEqual(["2026-10-05T15:00/2026-10-05T15:30", "2026-10-09T18:00/2026-10-09T18:30"]);
  });

  it("an unsupported FREQ counts the event once", () => {
    const ics = cal(["UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=HOURLY;COUNT=5"]);
    expect(window(ics)).toEqual(["2026-10-05T15:00/2026-10-05T15:30"]);
  });

  it("caps the expansion, however hostile the feed", () => {
    const ics = cal(["UID:a\nDTSTART:20200101T000000Z\nDTEND:20200101T000100Z\nRRULE:FREQ=DAILY"]);
    expect(busy(ics, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z", DENVER, 50)).toHaveLength(50);
    // The default cap is 5,000.
    expect(busy(ics, "2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z").length).toBe(5000);
  });

  it("expands only inside the window", () => {
    const parsed = parseIcsCalendar(cal(["UID:a\nDTSTART:20261005T150000Z\nDTEND:20261005T153000Z\nRRULE:FREQ=DAILY"]));
    const out = expandBusy(parsed, { from: new Date("2026-10-10T00:00:00Z"), to: new Date("2026-10-12T00:00:00Z"), timezone: DENVER });
    expect(out.map((interval) => interval.start.toISOString().slice(0, 10))).toEqual(["2026-10-10", "2026-10-11"]);
  });
});
