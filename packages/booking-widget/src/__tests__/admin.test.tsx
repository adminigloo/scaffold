import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimeOff, Holidays } from "../admin/AvailabilityPanel.js";
import { BookingAdmin } from "../admin/BookingAdmin.js";
import { BookingRow, CancelPanel, adapterSlotSource } from "../admin/BookingsPanel.js";
import {
  canCancel,
  canMove,
  canRecordOutcome,
  cancelButtonLabel,
  cancelReasonLabel,
  confirmButtonLabel,
  datesInRange,
  describeExceptionGroup,
  groupBlackouts,
  groupExceptions,
  mailtoInvitee,
  MAX_RANGE_DAYS,
  moveButtonLabel,
  sameWeekly,
  setupChecklist,
  weekFrom,
  weekProblem,
  weekToWindows,
} from "../admin/helpers.js";
import { CalendarCard, FeedCard, HostCard, TypeCard } from "../admin/SettingsPanel.js";
import { bookingAdminCss } from "../admin/styles.js";
import type { AdminBooking, AdminBookingType, AdminException, AdminHost, BookingAdminAdapter } from "../admin/types.js";

/**
 * The admin screens without a DOM: the rules as pure functions, and the
 * pieces rendered to a string, asserting on what the host reads and which
 * buttons exist. The flows themselves (tabs, the checklist jumping to a
 * card, moving a call with the picker, adding a week off) run in a real
 * browser in e2e/tests/booking-widget.spec.ts.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[   ]/g, " ");

const NOW = Date.parse("2026-10-06T18:00:00Z");
const HOUR = 3_600_000;

const host: AdminHost = {
  id: "h1",
  displayName: "Dallin",
  email: "dallin@example.com",
  timezone: "America/Denver",
  meetingLink: "https://meet.example.com/abc",
  phone: null,
  inviteMailbox: null,
  busyIcsUrl: "https://calendar.google.com/…ics ✓",
  busySync: { error: null, failingSince: null, okAt: null },
  hasFeedToken: true,
  autoConfirm: true,
};

const intro: AdminBookingType = {
  id: "t1",
  key: "intro",
  name: "Intro call",
  description: null,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  stepMinutes: 30,
  minNoticeMinutes: 720,
  horizonDays: 21,
  maxPerDay: null,
  media: ["video", "phone"],
  hostIds: [],
  isActive: true,
  sortOrder: 0,
};

function booking(overrides: Partial<AdminBooking> = {}): AdminBooking {
  return {
    id: "b1",
    typeKey: "intro",
    typeName: "Intro call",
    hostId: "h1",
    hostDisplayName: "Dallin",
    status: "confirmed",
    start: new Date(NOW + 48 * HOUR),
    end: new Date(NOW + 48 * HOUR + 30 * 60_000),
    hostTimezone: "America/Denver",
    inviteeTimezone: "America/New_York",
    inviteeName: "Ada Lovelace",
    inviteeEmail: "ada@example.com",
    inviteePhone: "+18015550143",
    inviteeCompany: "Engines",
    notes: null,
    medium: "video",
    source: null,
    sequence: 0,
    cancelledBy: null,
    cancelReason: null,
    outcome: null,
    ...overrides,
  };
}

const unused = () => Promise.reject(new Error("not used in this test"));

function adapter(emailsEnabled: boolean, overrides: Partial<BookingAdminAdapter> = {}): BookingAdminAdapter {
  return {
    emailsEnabled,
    listBookings: unused,
    getBooking: unused,
    cancelBooking: unused,
    confirmBooking: unused,
    setOutcome: unused,
    rescheduleBooking: unused,
    listRescheduleSlots: unused,
    listHosts: unused,
    upsertHost: unused,
    testCalendar: unused,
    rotateFeed: unused,
    getAvailability: unused,
    setWeekly: unused,
    addException: unused,
    removeException: unused,
    listBlackouts: unused,
    addBlackout: unused,
    removeBlackout: unused,
    listTypes: unused,
    upsertType: unused,
    ...overrides,
  };
}

const buttons = (out: string) => [...out.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("what a booking may do now", () => {
  it("Outcome only once the call has STARTED — never on a future call", () => {
    expect(canRecordOutcome(booking(), NOW)).toBe(false);
    expect(canRecordOutcome(booking({ start: new Date(NOW - 10 * 60_000), end: new Date(NOW + 20 * 60_000) }), NOW)).toBe(true);
    expect(canRecordOutcome(booking({ start: new Date(NOW - 48 * HOUR), end: new Date(NOW - 47 * HOUR) }), NOW)).toBe(true);
    expect(canRecordOutcome(booking({ status: "cancelled", start: new Date(NOW - 48 * HOUR) }), NOW)).toBe(false);
    // ISO strings (plain JSON adapters) work the same as Dates.
    expect(canRecordOutcome(booking({ start: new Date(NOW + HOUR).toISOString() }), NOW)).toBe(false);
  });

  it("Cancel only a live call that has not ended; Move only one that has not started", () => {
    expect(canCancel(booking(), NOW)).toBe(true);
    expect(canCancel(booking({ status: "requested" }), NOW)).toBe(true);
    expect(canCancel(booking({ end: new Date(NOW - 1) }), NOW)).toBe(false);
    expect(canCancel(booking({ status: "completed" }), NOW)).toBe(false);
    expect(canMove(booking(), NOW)).toBe(true);
    expect(canMove(booking({ start: new Date(NOW - 1) }), NOW)).toBe(false);
    expect(canMove(booking({ typeKey: null }), NOW)).toBe(false);
    expect(canMove(booking({ status: "cancelled" }), NOW)).toBe(false);
  });

  it("button words follow whether email is wired", () => {
    expect(cancelButtonLabel(true)).toBe("Cancel the call and email them");
    expect(cancelButtonLabel(false)).toBe("Cancel the call");
    expect(confirmButtonLabel(true)).toBe("Confirm and email them");
    expect(confirmButtonLabel(false)).toBe("Confirm");
    expect(moveButtonLabel(true)).toBe("Move the call and email them");
    expect(moveButtonLabel(false)).toBe("Move the call");
    expect(cancelReasonLabel(true, "Ada")).toContain("it goes in the email");
    expect(cancelReasonLabel(false, "Ada")).not.toContain("email");
    expect(mailtoInvitee("ada@example.com", "Your call & more", "Sorry")).toBe(
      "mailto:ada@example.com?subject=Your%20call%20%26%20more&body=Sorry",
    );
  });
});

describe("a booking row", () => {
  const row = (b: AdminBooking, emails = true) =>
    html(<BookingRow booking={b} adapter={adapter(emails)} scope="upcoming" type={intro} locale="en-US" onChanged={() => {}} nowMs={NOW} />);

  it("a future call: move and cancel, but no outcome", () => {
    const labels = buttons(row(booking()));
    expect(labels).toContain("Move call");
    expect(labels).toContain("Cancel call");
    expect(labels).not.toContain("Record outcome");
    expect(labels).toContain("History");
  });

  it("a call in progress can be marked; it can no longer be moved", () => {
    const labels = buttons(row(booking({ start: new Date(NOW - 10 * 60_000), end: new Date(NOW + 20 * 60_000) })));
    expect(labels).toContain("Record outcome");
    expect(labels).not.toContain("Move call");
    expect(labels).toContain("Cancel call");
  });

  it("shows the time in the host's zone and the invitee's clock beside it", () => {
    const out = row(booking());
    expect(out).toContain("Thu, Oct 8 · 12:00 – 12:30 PM MDT");
    expect(out).toContain("for them (America/New York)");
    expect(out).toContain('href="mailto:ada@example.com"');
    expect(out).toContain('href="tel:+18015550143"');
  });

  it("a request: 'Confirm and email them' with email, plain 'Confirm' and a mailto without", () => {
    const withEmail = row(booking({ status: "requested" }), true);
    expect(buttons(withEmail)).toContain("Confirm and email them");
    expect(withEmail).not.toContain("won&#x27;t tell them");
    const without = row(booking({ status: "requested" }), false);
    expect(buttons(without)).toContain("Confirm");
    expect(buttons(without)).not.toContain("Confirm and email them");
    expect(without).toContain("Email isn&#x27;t set up, so confirming won&#x27;t tell them.");
    expect(without).toContain("mailto:ada@example.com?subject=Your%20Intro%20call%20is%20confirmed");
  });

  it("the cancel panel: the email promise only when email is wired, else a prefilled mailto", () => {
    const on = html(<CancelPanel booking={booking()} adapter={adapter(true)} locale="en-US" onDone={() => {}} />);
    expect(buttons(on)).toContain("Cancel the call and email them");
    expect(on).toContain("A note for Ada Lovelace (optional, it goes in the email)");
    // Negative control: with email on there is no "tell them yourself" link.
    expect(on).not.toContain("data-aibk-tell-them");
    const off = html(<CancelPanel booking={booking()} adapter={adapter(false)} locale="en-US" onDone={() => {}} />);
    expect(buttons(off)).toContain("Cancel the call");
    expect(off).not.toContain("and email them");
    expect(off).not.toContain("it goes in the email");
    expect(off).toContain("data-aibk-tell-them");
    expect(off).toContain("Email isn&#x27;t set up, so they won&#x27;t hear from us.");
    expect(off).toMatch(/href="mailto:ada@example.com\?subject=Your%20Intro%20call%20on%20[^"]+%20is%20cancelled"/);
  });
});

describe("the Move call picker's source", () => {
  it("asks the adapter for the booking's slots and turns its throw into the picker's error state", async () => {
    const asked: unknown[] = [];
    const ok = adapterSlotSource(
      adapter(true, {
        listRescheduleSlots: async (input) => {
          asked.push(input);
          return { slots: [{ start: "2026-10-08T18:00:00Z", end: "2026-10-08T18:30:00Z" }] };
        },
      }),
      "b1",
    );
    const answer = await ok.slots({ type: "intro", from: "2026-10-06T00:00:00Z", to: "2026-11-05T00:00:00Z" });
    expect(asked).toEqual([{ id: "b1", typeKey: "intro", from: "2026-10-06T00:00:00Z", to: "2026-11-05T00:00:00Z" }]);
    expect(answer).toEqual({
      ok: true,
      data: { slots: [{ start: "2026-10-08T18:00:00.000Z", end: "2026-10-08T18:30:00.000Z" }], busySync: "off" },
    });
    const failing = adapterSlotSource(adapter(true, { listRescheduleSlots: () => Promise.reject(new Error("nope")) }), "b1");
    const error = await failing.slots({ type: "intro", from: "a", to: "b" });
    expect(error.ok).toBe(false);
    expect(!error.ok && error.error.message).toBe("nope");
  });
});

describe("dates and ranges", () => {
  it("expands an optional 'until' into every date, both ends included", () => {
    expect(datesInRange("2026-10-12")).toEqual({ dates: ["2026-10-12"] });
    expect(datesInRange("2026-10-12", "")).toEqual({ dates: ["2026-10-12"] });
    expect(datesInRange("2026-12-30", "2027-01-02")).toEqual({ dates: ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"] });
    expect(datesInRange("2026-10-12", "2026-10-11")).toEqual({ error: "The end date has to be on or after the start date." });
    expect(datesInRange("", "2026-10-11")).toEqual({ error: "Pick a date." });
    const tooLong = datesInRange("2026-01-01", "2026-12-31");
    expect("error" in tooLong && tooLong.error).toContain(String(MAX_RANGE_DAYS));
  });

  it("groups a week off into one row, and keeps different things apart", () => {
    const row = (id: string, date: string, extra: Partial<AdminException> = {}): AdminException => ({
      id,
      date,
      kind: "off",
      startMinute: null,
      endMinute: null,
      note: "Vacation",
      ...extra,
    });
    const rows = [
      // Out of order on purpose: the server's order is not trusted.
      row("e3", "2026-10-14"),
      row("e1", "2026-10-12"),
      row("e2", "2026-10-13"),
      row("e4", "2026-10-15"),
      row("e5", "2026-10-16"),
      row("e6", "2026-10-17"),
      row("e7", "2026-10-18"),
      // A gap breaks the run.
      row("e9", "2026-10-20"),
      // Same dates, different kind or hours: their own rows.
      row("b1", "2026-10-21", { kind: "block", startMinute: 600, endMinute: 660, note: null }),
      row("b2", "2026-10-22", { kind: "block", startMinute: 600, endMinute: 660, note: null }),
      row("b3", "2026-10-22", { kind: "block", startMinute: 840, endMinute: 900, note: null }),
      // Different note: not merged.
      row("x1", "2026-10-23", { note: "Conference" }),
      row("x2", "2026-10-24", { note: "Vacation" }),
    ];
    const groups = groupExceptions(rows);
    expect(groups.map((group) => [group.from, group.to, group.ids.length, group.kind])).toEqual([
      ["2026-10-12", "2026-10-18", 7, "off"],
      ["2026-10-20", "2026-10-20", 1, "off"],
      ["2026-10-21", "2026-10-22", 2, "block"],
      ["2026-10-22", "2026-10-22", 1, "block"],
      ["2026-10-23", "2026-10-23", 1, "off"],
      ["2026-10-24", "2026-10-24", 1, "off"],
    ]);
    expect(groups[0]!.ids.sort()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
    expect(describeExceptionGroup(groups[0]!)).toBe("Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days");
    expect(describeExceptionGroup(groups[2]!)).toBe("Wed, Oct 21 – Thu, Oct 22 · Blocked · 10:00 AM – 11:00 AM · 2 days");
  });

  it("groups holidays the same way, by label", () => {
    const groups = groupBlackouts([
      { id: "a", date: "2026-12-24", label: "Holidays" },
      { id: "b", date: "2026-12-25", label: "Holidays" },
      { id: "c", date: "2026-12-26", label: "Boxing Day" },
      { id: "d", date: "2026-11-26", label: null },
    ]);
    expect(groups.map((group) => [group.from, group.to, group.label, group.days])).toEqual([
      ["2026-11-26", "2026-11-26", null, 1],
      ["2026-12-24", "2026-12-25", "Holidays", 2],
      ["2026-12-26", "2026-12-26", "Boxing Day", 1],
    ]);
  });
});

describe("the week", () => {
  it("round-trips the server's rows and compares weeks whatever the order", () => {
    const weekly = [
      { dayOfWeek: 1, startMinute: 600, endMinute: 960 },
      { dayOfWeek: 3, startMinute: 780, endMinute: 900 },
      { dayOfWeek: 3, startMinute: 540, endMinute: 720 },
    ];
    const days = weekFrom(weekly);
    expect(days[3]).toEqual([
      { start: 540, end: 720 },
      { start: 780, end: 900 },
    ]);
    expect(sameWeekly(weekToWindows(days), weekly)).toBe(true);
    expect(sameWeekly(weekly, [...weekly].reverse())).toBe(true);
    expect(sameWeekly(weekly, weekly.slice(1))).toBe(false);
  });

  it("names the first problem in a week as typed", () => {
    expect(weekProblem(weekFrom([{ dayOfWeek: 2, startMinute: 600, endMinute: 600 }]))).toBe(
      "Tuesday: each window has to end after it starts.",
    );
    expect(
      weekProblem(
        weekFrom([
          { dayOfWeek: 5, startMinute: 600, endMinute: 720 },
          { dayOfWeek: 5, startMinute: 700, endMinute: 800 },
        ]),
      ),
    ).toBe("Friday: two windows overlap.");
    expect(weekProblem(weekFrom([{ dayOfWeek: 1, startMinute: 600, endMinute: 960 }]))).toBeNull();
  });
});

describe("Finish setting up", () => {
  it("is empty for a host that is all set — the negative control", () => {
    expect(setupChecklist({ host, types: [intro], emailsEnabled: true, hoursAreDefault: false })).toEqual([]);
  });

  it("names each unfinished thing, and where to fix it", () => {
    const bare: AdminHost = { ...host, meetingLink: null, busyIcsUrl: null, hasFeedToken: false };
    const items = setupChecklist({ host: bare, types: [intro], emailsEnabled: false, hoursAreDefault: true });
    expect(items.map((item) => item.key)).toEqual(["meeting-link", "calendar", "default-hours", "feed", "emails"]);
    expect(items.find((item) => item.key === "meeting-link")!.action).toEqual({
      label: "Add your meeting link",
      tab: "settings",
      target: "host",
    });
    expect(items.find((item) => item.key === "default-hours")!.action!.tab).toBe("availability");
    // Email is configured on the server, not on these screens: no button.
    expect(items.find((item) => item.key === "emails")!.action).toBeUndefined();
  });

  it("a missing meeting link only matters when video is offered by this host", () => {
    const noLink = { ...host, meetingLink: null };
    expect(setupChecklist({ host: noLink, types: [{ ...intro, media: ["phone"] }], emailsEnabled: true, hoursAreDefault: false })).toEqual([]);
    expect(setupChecklist({ host: noLink, types: [{ ...intro, isActive: false }], emailsEnabled: true, hoursAreDefault: false }).map((i) => i.key)).toEqual([
      "no-type",
    ]);
    expect(
      setupChecklist({ host: noLink, types: [{ ...intro, hostIds: ["someone-else"] }], emailsEnabled: true, hoursAreDefault: false }).map((i) => i.key),
    ).toEqual(["no-type"]);
  });
});

describe("settings copy the review asked for", () => {
  it("the host email hint tells the truth about where the address appears", () => {
    const out = html(<HostCard adapter={adapter(true)} host={host} onSaved={() => {}} />);
    expect(out).toContain(
      "Where notices go. Also shown to invitees as the organizer in calendar files, and as the invite address unless you set an invite mailbox below.",
    );
    // Negative control: the old hint was false.
    expect(out).not.toContain("Never shown publicly");
  });

  it("with no host yet, the same card creates one", () => {
    const out = html(<HostCard adapter={adapter(true)} host={null} onSaved={() => {}} />);
    expect(out).toContain("Set up who takes the calls");
    expect(buttons(out)).toContain("Create host");
  });

  it("the calendar card warns that all-day Google events only block when Busy", () => {
    const out = html(<CalendarCard adapter={adapter(true)} host={host} locale="en-US" onChanged={() => {}} />);
    expect(out).toContain("All-day events only block bookings when they&#x27;re set to <b>Busy</b> in Google");
    expect(out).toContain("use Time off in the Availability tab");
  });

  it("copy that would promise an email drops the promise when email is off", () => {
    const on = html(<FeedCard adapter={adapter(true)} host={host} onChanged={() => {}} />);
    expect(on).toContain("the email notice for each booking has a one-click add");
    const off = html(<FeedCard adapter={adapter(false)} host={host} onChanged={() => {}} />);
    expect(off).not.toContain("email notice");
    const hostOff = html(<HostCard adapter={adapter(false)} host={host} onSaved={() => {}} />);
    expect(hostOff).not.toContain("hears back by email");
    expect(hostOff).not.toContain("and in their emails");
  });

  it("a type card edits every field the server's upsertType takes that a host would change", () => {
    const out = html(<TypeCard adapter={adapter(true)} type={intro} onSaved={() => {}} />);
    for (const label of ["Name", "Length", "Description", "Clear time before", "Clear time after", "Start times every", "Minimum notice", "How far ahead", "Most per day"]) {
      expect(out).toContain(`>${label}`);
    }
    expect(out).toContain("Ways to meet on offer");
    const create = html(<TypeCard adapter={adapter(true)} type={null} onSaved={() => {}} />);
    expect(create).toContain(">Key<");
    expect(buttons(create)).toContain("Create call type");
  });
});

describe("time off and holidays, grouped", () => {
  it("lists a week off as one line with one remove", () => {
    const exceptions: AdminException[] = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      date: `2026-10-${String(12 + i).padStart(2, "0")}`,
      kind: "off" as const,
      startMinute: null,
      endMinute: null,
      note: "Vacation",
    }));
    const out = html(<TimeOff adapter={adapter(true)} host={host} exceptions={exceptions} locale="en-US" onChanged={() => {}} />);
    expect(out).toContain("Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days");
    expect(out.match(/data-aibk-exception=/g)).toHaveLength(1);
    expect(buttons(out)).toContain("Remove all 7");
    expect(out).toContain(">Until <");
  });

  it("holidays take a range too", () => {
    const out = html(
      <Holidays
        adapter={adapter(true)}
        hostZone="America/Denver"
        blackouts={[
          { id: "a", date: "2099-12-24", label: "Holidays" },
          { id: "b", date: "2099-12-25", label: "Holidays" },
        ]}
        locale="en-US"
        onChanged={() => {}}
      />,
    );
    expect(out).toContain("Thu, Dec 24 – Fri, Dec 25 · Holidays · 2 days");
    expect(out).toContain(">Until <");
  });
});

describe("<BookingAdmin> first paint", () => {
  it("renders self-styled, themed and loading — nothing fetched on the server", () => {
    const out = html(<BookingAdmin adapter={adapter(true)} theme="dark" bookingPageUrl="/book" className="mine" />);
    expect(out).toContain('class="aibk-root aibk-admin mine"');
    expect(out).toContain('data-theme="dark"');
    expect(out).toContain("Loading…");
    expect(out).toContain('href="/book"');
  });
});

describe("the admin stylesheet", () => {
  it("prefixes every class it styles", () => {
    const classes = bookingAdminCss().match(/\.[a-z][a-z0-9-]*/g) ?? [];
    const foreign = classes.filter((name) => !name.startsWith(".aibk-") && !/^\.\d/.test(name));
    expect(foreign).toEqual([]);
  });

  it("colours only through the widget's tokens, so light, dark and a buyer's theme all apply", () => {
    expect(bookingAdminCss()).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
