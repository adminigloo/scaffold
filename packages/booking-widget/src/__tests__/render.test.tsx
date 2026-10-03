import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingWidget } from "../BookingWidget.js";
import { BookingClient } from "../client.js";
import { Confirmation } from "../Confirmation.js";
import { ManageBooking } from "../ManageBooking.js";
import {
  BookingFacts,
  CalendarActions,
  DateStrip,
  defaultRealBookingLabel,
  defaultSandboxNotice,
  HowWeMeet,
  SandboxBanner,
  StatusTag,
  TimeGroups,
  ZoneSelect,
} from "../parts.js";
import { bookingWidgetCss } from "../styles.js";
import { localizeSlot, US_TIME_ZONES } from "../time.js";
import type { BookResponse, PublicBooking } from "../types.js";

/**
 * Component checks without a DOM: the presentational pieces render to a string
 * (react-dom/server), and the assertions are on what a visitor reads and what
 * a link points at. The interactive flows — holds, countdown, slot_taken
 * recovery, reschedule — are exercised in a real browser by
 * e2e/tests/booking-widget.spec.ts.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[\u202f\u00a0]/g, " ");

const booking: PublicBooking = {
  status: "confirmed",
  start: "2026-10-06T15:30:00Z",
  end: "2026-10-06T16:00:00Z",
  typeName: "Intro call",
  durationMinutes: 30,
  hostDisplayName: "Dallin",
  hostTimezone: "America/Denver",
  inviteeName: "Ada",
  inviteeTimezone: "America/Denver",
  medium: "video",
  meetingLink: "https://meet.example.com/abc",
  hostPhone: null,
  inviteMailbox: null,
  googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Intro",
  canCancel: true,
  canReschedule: true,
  sandbox: false,
};

const result: BookResponse = {
  booking,
  manageToken: "mt_123",
  manageUrl: "https://site.test/booking/manage/mt_123",
};

const client = new BookingClient({ baseUrl: "https://site.test/api/booking" });

describe("the confirmation", () => {
  it("lets the host replace or drop the email promise", () => {
    const base = { result, zone: "America/Denver", locale: "en-US", client, sandbox: false, inviteeEmail: "ada@example.com", realBookingLabel: "x" };
    const replaced = html(<Confirmation {...base} confirmationNote="Dallin sees your booking right away." />);
    expect(replaced).toContain("Dallin sees your booking right away.");
    expect(replaced).not.toContain("on its way");
    const dropped = html(<Confirmation {...base} confirmationNote={null} />);
    expect(dropped).not.toContain("on its way");
    expect(dropped).toContain("You&#x27;re booked");
  });

  it("shows when, how we meet, both calendar links and the manage link", () => {
    const out = html(
      <Confirmation
        result={result}
        zone="America/Denver"
        locale="en-US"
        client={client}
        sandbox={false}
        inviteeEmail="ada@example.com"
        realBookingLabel="x"
      />,
    );
    expect(out).toContain("You&#x27;re booked");
    expect(out).toContain("A confirmation is on its way to ada@example.com.");
    expect(out).toContain("Tuesday, October 6 at 9:30 AM MDT");
    expect(out).toContain("<span>Video call. </span>");
    expect(out).toContain('href="https://meet.example.com/abc"');
    expect(out).toContain('href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Intro"');
    expect(out).toContain("Add to Google Calendar");
    expect(out).toContain('href="https://site.test/api/booking/v1/manage/mt_123/ics"');
    expect(out).toContain("Download .ics");
    expect(out).toContain('href="https://site.test/booking/manage/mt_123"');
    expect(out).not.toContain("What happens on a real booking");
    expect(out).not.toContain("sandbox");
  });

  it("is honest about a request that still needs the host", () => {
    const out = html(
      <Confirmation
        result={{ ...result, booking: { ...booking, status: "requested" } }}
        zone="America/Denver"
        locale="en-US"
        client={client}
        sandbox={false}
        inviteeEmail="ada@example.com"
        realBookingLabel="x"
      />,
    );
    expect(out).toContain("Request sent");
    expect(out).toContain("Dallin will confirm by email at ada@example.com.");
    expect(out).not.toContain("You&#x27;re booked");
  });

  it("in the sandbox, is a labelled preview with what a real booking does and the real CTA", () => {
    const out = html(
      <Confirmation
        result={{ ...result, booking: { ...booking, sandbox: true } }}
        zone="America/Denver"
        locale="en-US"
        client={client}
        sandbox
        inviteeEmail="ada@example.com"
        realBookingHref="/book"
        realBookingLabel={defaultRealBookingLabel("Dallin")}
        onReset={() => {}}
      />,
    );
    expect(out).toContain("This is what your customer would see");
    expect(out).toContain("Preview · your customer&#x27;s confirmation");
    expect(out).toContain("What happens on a real booking");
    expect(out.match(/<li>/g)).toHaveLength(4);
    expect(out).toContain("calendar invite");
    expect(out).toContain("day before");
    expect(out).toContain("reschedule or cancel");
    expect(out).toMatch(/<a class="aibk-btn aibk-btn-primary aibk-btn-cta" href="\/book" data-aibk-real-cta="">Book a real call with Dallin →<\/a>/);
    expect(out).toContain("Try another time in the sandbox");
  });

  it("lets a buyer replace the real-booking list", () => {
    const out = html(
      <Confirmation
        result={result}
        zone="UTC"
        locale="en-US"
        client={client}
        sandbox
        inviteeEmail=""
        realBookingLabel="Go"
        realBookingSteps={["One thing happens."]}
      />,
    );
    expect(out.match(/<li>/g)).toHaveLength(1);
    expect(out).toContain("One thing happens.");
    expect(out).not.toContain("data-aibk-real-cta");
  });
});

describe("the confirmation when the server sends no email", () => {
  const base = {
    result: { ...result, booking: { ...booking, meetingLink: null } },
    zone: "America/Denver",
    locale: "en-US",
    client,
    sandbox: false,
    inviteeEmail: "ada@example.com",
    realBookingLabel: "x",
  };

  it("hands over the private link as a copyable field and promises no inbox", () => {
    const out = html(<Confirmation {...base} emails={{ emailsEnabled: false }} />);
    expect(out).toContain("data-aibk-copy");
    expect(out).toMatch(/<input[^>]*readOnly=""[^>]*value="https:\/\/site.test\/booking\/manage\/mt_123"|<input[^>]*value="https:\/\/site.test\/booking\/manage\/mt_123"[^>]*readOnly=""/);
    expect(out).toContain("Copy your private link");
    expect(out).toContain(
      "This is the only way to move or cancel. Bookmark it, or add the call to your calendar (the link is inside).",
    );
    expect(out).toContain("Dallin will send you the link before the call.");
    expect(out).not.toContain("on its way");
    expect(out).not.toMatch(/confirmation email|by email|your inbox/);
  });

  it("negative control: with email on (or not said), the old copy and no copy field", () => {
    for (const emails of [undefined, { emailsEnabled: true }]) {
      const out = html(<Confirmation {...base} emails={emails} />);
      expect(out).toContain("A confirmation is on its way to ada@example.com.");
      expect(out).not.toContain("data-aibk-copy");
      expect(out).not.toContain("Copy your private link");
      expect(out).toContain('href="https://site.test/booking/manage/mt_123"');
    }
  });

  it("a request says where to see the answer, not that an email will come", () => {
    const out = html(
      <Confirmation {...base} result={{ ...base.result, booking: { ...base.result.booking, status: "requested" } }} emails={{ emailsEnabled: false }} />,
    );
    expect(out).toContain("Dallin still has to confirm this time. Your private link below shows when they do.");
    expect(out).not.toContain("confirm by email");
  });

  it("with no manage page either, points at the contact address the host app chose", () => {
    const out = html(
      <Confirmation
        {...base}
        result={{ ...base.result, manageUrl: "" }}
        emails={{ emailsEnabled: false, contactEmail: "hello@site.test" }}
      />,
    );
    expect(out).toContain('To move or cancel, email <a href="mailto:hello@site.test">hello@site.test</a>.');
    expect(out).not.toContain("data-aibk-copy");
  });

  it("an explicit confirmationNote still wins", () => {
    const out = html(<Confirmation {...base} emails={{ emailsEnabled: false }} confirmationNote="Saved on our side." />);
    expect(out).toContain("Saved on our side.");
  });
});

describe("the sandbox confirmation", () => {
  const sandboxResult = { ...result, booking: { ...booking, sandbox: true } };

  it("the preview card says what a real booking would send, not that it was sent", () => {
    const out = html(
      <Confirmation result={sandboxResult} zone="America/Denver" locale="en-US" client={client} sandbox inviteeEmail="ada@example.com" realBookingLabel="x" />,
    );
    expect(out).toContain("In a real booking, a confirmation goes to ada@example.com.");
    // Negative control: the preview's most prominent line used to claim delivery.
    expect(out).not.toContain("A confirmation is on its way");
  });

  it("labels both calendar exports as sandbox ones", () => {
    const out = html(
      <Confirmation result={sandboxResult} zone="America/Denver" locale="en-US" client={client} sandbox inviteeEmail="" realBookingLabel="x" />,
    );
    expect(out).toContain("Add sandbox event to Google Calendar");
    expect(out).toContain("Download sandbox .ics");
    expect(out).toContain('download="sandbox-booking.ics"');
    expect(out).not.toMatch(/>Add to Google Calendar</);
    expect(out).not.toMatch(/>Download \.ics</);
  });

  it("negative control: a real booking keeps the plain labels", () => {
    const out = html(<CalendarActions booking={booking} icsHref="/x.ics" />);
    expect(out).toContain("Add to Google Calendar");
    expect(out).toContain(">Download .ics<");
    expect(out).not.toContain("sandbox");
  });
});

describe("how we meet", () => {
  it("phone: who calls whom, and from which number", () => {
    const out = html(
      <HowWeMeet booking={{ ...booking, medium: "phone", meetingLink: null, hostPhone: "+18015550100" }} inviteePhone="+1 801 555 0143" />,
    );
    expect(out).toContain("<span>Phone call. </span>");
    // The radio's title says "we call you"; the line after it says it again.
    expect(out).not.toContain("we call you");
    expect(out).toContain("Dallin will call you at +1 801 555 0143");
    expect(out).toContain("The call will come from +18015550100.");
  });

  it("prospect-hosted: which mailbox to invite, as a mailto with a subject", () => {
    const out = html(
      <HowWeMeet booking={{ ...booking, medium: "prospect_hosted", meetingLink: null, inviteMailbox: "meet@adminigloo.test" }} />,
    );
    expect(out).toContain("<span>Your meeting link. </span>");
    expect(out).not.toContain("you send the invite");
    expect(out).toContain('href="mailto:meet@adminigloo.test?subject=Intro%20call%20with%20Dallin"');
  });

  it("video without a link yet: says WHO sends it, never that it is in an email", () => {
    const out = html(<HowWeMeet booking={{ ...booking, meetingLink: null }} />);
    expect(out).toContain("<span>Video call. </span><span>Dallin will send you the link before the call.</span>");
    // Said once: the radio's "we send the link" is not repeated in front of it.
    expect(out).not.toContain("we send the link");
    // Negative control: the old copy promised an email that may not exist.
    expect(out).not.toContain("email");
    expect(html(<HowWeMeet booking={{ ...booking, meetingLink: null, hostDisplayName: "" }} />)).toContain(
      "We will send you the link before the call.",
    );
  });

  it("video with a link: the link itself, not a promise", () => {
    const out = html(<HowWeMeet booking={booking} />);
    expect(out).toContain('href="https://meet.example.com/abc"');
    expect(out).not.toContain("will send you the link");
  });
});

describe("sandbox banner and status", () => {
  it("uses the spec's copy with the host's name, and links to the real thing", () => {
    expect(defaultSandboxNotice("Dallin")).toBe(
      "Demo — this is a sandbox. Nothing is booked, nobody is emailed, and Dallin doesn't see it.",
    );
    expect(defaultSandboxNotice("  ")).toContain("the host doesn't see it");
    const out = html(<SandboxBanner notice={defaultSandboxNotice("Dallin")} realBookingHref="/book" realBookingLabel="Book a real call with Dallin →" />);
    expect(out).toContain('role="note"');
    expect(out).toContain('href="/book"');
  });

  it("labels every booking state", () => {
    expect(html(<StatusTag status="confirmed" past={false} />)).toContain("Confirmed");
    expect(html(<StatusTag status="requested" past={false} />)).toContain("Awaiting confirmation");
    expect(html(<StatusTag status="cancelled" past={false} />)).toContain("Cancelled");
    expect(html(<StatusTag status="confirmed" past />)).toContain("Past");
    expect(html(<StatusTag status="no_show" past />)).toContain("Missed");
  });
});

describe("the picker pieces", () => {
  it("renders times as pressed-state buttons grouped by part of day", () => {
    const slots = ["2026-10-06T15:00:00Z", "2026-10-06T15:30:00Z", "2026-10-06T20:00:00Z"].map((start) =>
      localizeSlot({ start, end: start }, "America/Denver"),
    );
    const out = html(
      <TimeGroups
        slots={slots}
        zone="America/Denver"
        locale="en-US"
        selectedStart="2026-10-06T15:30:00.000Z"
        pendingStart={null}
        onPick={() => {}}
      />,
    );
    expect(out).toContain('aria-label="Morning, Tuesday, October 6"');
    expect(out).toContain('aria-label="Afternoon, Tuesday, October 6"');
    expect(out.match(/<button/g)).toHaveLength(3);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>9:30 AM</);
    expect(out).toContain(">2:00 PM<");
  });

  it("renders days without times as disabled tiles, with their count for screen readers", () => {
    const out = html(
      <DateStrip
        strip={[
          { date: "2026-10-06", count: 3 },
          { date: "2026-10-07", count: 0 },
        ]}
        selected="2026-10-06"
        onSelect={() => {}}
        locale="en-US"
      />,
    );
    expect(out.match(/class="aibk-day"[^>]*disabled=""/g)).toHaveLength(1);
    expect(out).toContain("3 times open");
    expect(out).toContain("no times open");
    expect(out).toContain(">Tue<");
  });

  it("has earlier/later buttons that control the strip, disabled until there is somewhere to go", () => {
    const out = html(
      <DateStrip strip={[{ date: "2026-10-06", count: 3 }]} selected="2026-10-06" onSelect={() => {}} locale="en-US" />,
    );
    const listId = out.match(/<ul class="aibk-days" id="([^"]+)"/)?.[1];
    expect(listId).toBeTruthy();
    for (const label of ["Earlier days", "Later days"]) {
      const button = out.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
      expect(button).toContain(`aria-controls="${listId}"`);
      // Server render: nothing measured yet, so nothing to scroll to.
      expect(button).toContain('disabled=""');
    }
    // No overflow measured: the wrap does not claim one (the CSS hides the buttons).
    expect(out).not.toContain("data-overflow");
  });

  it("tells the two 1:30 AMs of a fall-back night apart by zone name", () => {
    // America/Denver falls back at 2:00 MDT on 2026-11-01: 07:30Z is 1:30 MDT, 08:30Z is 1:30 MST.
    const slots = ["2026-11-01T07:30:00Z", "2026-11-01T08:30:00Z", "2026-11-01T16:00:00Z"].map((start) =>
      localizeSlot({ start, end: start }, "America/Denver"),
    );
    const out = html(
      <TimeGroups slots={slots} zone="America/Denver" locale="en-US" selectedStart={null} pendingStart={null} onPick={() => {}} />,
    );
    expect(out).toContain(">1:30 AM MDT<");
    expect(out).toContain(">1:30 AM MST<");
    // A label that does not repeat stays plain.
    expect(out).toContain(">9:00 AM<");
  });
});

describe("first paint (server render)", () => {
  it("BookingWidget shows the sandbox banner immediately and a loading state", () => {
    const out = html(<BookingWidget baseUrl="/api/booking" sandbox realBookingHref="/book" theme="dark" />);
    expect(out).toContain('class="aibk-root"');
    expect(out).toContain('data-theme="dark"');
    expect(out).toContain("Demo — this is a sandbox.");
    expect(out).toContain("Loading…");
  });

  it("BookingWidget without sandbox shows no banner", () => {
    const out = html(<BookingWidget baseUrl="/api/booking" className="mine" />);
    expect(out).toContain('class="aibk-root mine"');
    expect(out).not.toContain("aibk-sandbox");
  });

  it("ManageBooking starts by loading the booking", () => {
    const out = html(<ManageBooking baseUrl="/api/booking" token="t" />);
    expect(out).toContain("Loading your booking…");
    expect(out).not.toContain("aibk-sandbox");
  });

  it("ManageBooking with the sandbox prop shows the banner before anything loads", () => {
    const out = html(<ManageBooking baseUrl="/api/demo" token="t" sandbox realBookingHref="/book" sandboxHref="/demo" />);
    expect(out).toContain("data-aibk-sandbox");
    expect(out).toContain("Demo — this is a sandbox.");
    expect(out).toContain("Loading your booking…");
  });
});

describe("the stylesheet", () => {
  it("declares the Ink & Snow palette at zero specificity so one buyer rule re-themes it", () => {
    const css = bookingWidgetCss();
    expect(css).toContain(":where(.aibk-root) {");
    expect(css).toContain("--aibk-accent: #0d6b64;");
    expect(css).toContain("--aibk-ink: #0a1520;");
    expect(css).toContain("--aibk-muted: #3e4b57;");
    expect(css).toContain("--aibk-line: #d2dbe3;");
    expect(css).toContain("--aibk-on-accent: #ffffff;");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("--aibk-ground: #0b0f13;");
    expect(css).toContain("--aibk-surface: #141b22;");
    expect(css).toContain("--aibk-accent: #45c4ad;");
    expect(css).toContain("--aibk-on-accent: #0b0f13;");
    expect(css).toContain(':where(.aibk-root[data-theme="dark"])');
  });

  it("prefixes every class it styles", () => {
    const classes = bookingWidgetCss().match(/\.[a-z][a-z0-9-]*/g) ?? [];
    const foreign = classes.filter((name) => !name.startsWith(".aibk-") && !/^\.\d/.test(name));
    expect(foreign).toEqual([]);
  });

  it("keeps a focused step heading clear of a sticky header, through an overridable token", () => {
    expect(bookingWidgetCss()).toContain(
      '.aibk-root [tabindex="-1"] { scroll-margin-top: var(--aibk-scroll-margin, 96px); }',
    );
    // Not declared on the root, so a host's `:root { --aibk-scroll-margin }` reaches it.
    expect(bookingWidgetCss()).not.toMatch(/--aibk-scroll-margin:/);
  });
});

describe("curated time zones", () => {
  const at = new Date("2026-10-14T18:00:00Z");

  it("the selector offers only the choices, by name — no cities, no offsets, no optgroups", () => {
    const out = html(
      <ZoneSelect zone="America/Denver" onChange={() => {}} at={at} suggested={["America/Denver"]} locale="en-US" choices={US_TIME_ZONES} />,
    );
    // One sentence, said once: the select carries the name and is labelled by the words before it.
    expect(out).toMatch(/^<label class="aibk-zone"><span>Times shown in<\/span><select/);
    expect(out).toContain('<option value="America/Denver" selected="">Mountain Time</option>');
    expect(out.match(/Mountain Time/g)).toHaveLength(1);
    const options = [...out.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(["Eastern Time", "Central Time", "Mountain Time", "Arizona Time", "Pacific Time", "Alaska Time", "Hawaii Time"]);
    // What a person reads (the option values stay IANA ids).
    const visible = out.replace(/<[^>]*>/g, " ");
    expect(visible).not.toContain("Denver");
    expect(visible).not.toContain("UTC");
    expect(out).not.toContain("<optgroup");
  });

  it("without choices, the full list as before (negative control)", () => {
    const out = html(<ZoneSelect zone="America/Denver" onChange={() => {}} at={at} suggested={["America/Denver"]} locale="en-US" />);
    expect(out).toContain("Denver (UTC−6)");
    expect(out).toContain("<optgroup");
  });

  it("the confirmation names the zone the way the selector did", () => {
    const out = html(<BookingFacts booking={booking} zone="America/Phoenix" locale="en-US" zoneChoices={US_TIME_ZONES} />);
    expect(out).toContain("times in Arizona Time");
    expect(out).not.toContain("Phoenix");
  });
});
