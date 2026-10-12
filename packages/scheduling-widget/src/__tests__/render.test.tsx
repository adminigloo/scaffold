import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrewDay } from "../admin/CrewDay.js";
import { ScheduleCalendar } from "../admin/ScheduleCalendar.js";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import { ManageVisit } from "../ManageVisit.js";
import { ContactLinks, CopyField, DateStrip, Field, Notice, TimeGroups, WidgetRoot } from "../parts.js";
import { VisitPicker } from "../VisitPicker.js";
import { CalendarActions, clientCalendarUrl, VisitFacts } from "../VisitSummary.js";
import { fakeAdmin, fakePublic, publicVisit, SLOTS } from "./fakes.js";

/**
 * The components without a DOM (react-dom/server): what a server render — a
 * Next.js page, before hydration — puts on the page. No `data-theme` for
 * "auto" (the CSS's media query decides, so no flash), a pinned theme as
 * given, a loading state rather than a crash, and the presentational pieces'
 * words and links. The flows are in the happy-dom suites beside this one.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[   ]/g, " ");
const never = () => new Promise<never>(() => {});

describe("server render", () => {
  it("every component renders on the server: a loading state, no data-theme under 'auto'", () => {
    const pub = fakePublic({ config: never, visit: never }).transport;
    const admin = fakeAdmin({ calendar: never, crewDay: never, getSettings: never, listResources: never }).transport;
    const outputs = [
      html(<VisitPicker transport={pub} />),
      html(<ManageVisit transport={pub} token="t" />),
      html(<ScheduleCalendar transport={admin} />),
      html(<CrewDay transport={admin} />),
      html(<SchedulingSettings transport={admin} />),
    ];
    for (const out of outputs) {
      expect(out).toMatch(/^<div class="aisw-root/);
      expect(out).not.toContain("data-theme");
    }
    expect(outputs[0]).toContain('data-aisw-skeleton=""');
    expect(outputs[0]).toContain("Loading times…");
    expect(outputs[1]).toContain("Loading your visit…");
    expect(outputs[2]).toContain('class="aisw-root aisw-admin"');
    expect(outputs[2]).toContain("Loading the schedule…");
    expect(outputs[3]).toContain("Loading the route…");
    expect(outputs[4]).toContain("Loading settings…");
  });

  it("a pinned theme is on the root from the first byte, with the host's class and style", () => {
    const out = html(
      <WidgetRoot theme="dark" className="my-booking" style={{ maxWidth: 560 }}>
        x
      </WidgetRoot>,
    );
    expect(out).toBe('<div class="aisw-root my-booking" style="max-width:560px" data-theme="dark">x</div>');
  });
});

describe("the pieces", () => {
  it("the date strip: only days with times, each with its count for screen readers", () => {
    const out = html(
      <DateStrip
        days={[
          { date: "2026-11-02", count: 2 },
          { date: "2026-11-03", count: 1 },
        ]}
        selected="2026-11-02"
        onSelect={() => {}}
        locale="en-US"
        onEarlier={() => {}}
        onLater={() => {}}
        canEarlier={false}
        canLater
      />,
    );
    expect(out).toContain('aria-label="Earlier dates"');
    expect(out).toMatch(/aria-label="Earlier dates"[^>]*disabled=""/);
    expect(out).toContain("Monday, November 2, 2 times open");
    expect(out).toContain("Tuesday, November 3, 1 time open");
    expect(out).toMatch(/data-date="2026-11-02" aria-pressed="true"/);
  });

  it("times: grouped by part of day, read on the business's clock, labelled with their end", () => {
    const out = html(<TimeGroups slots={SLOTS.slice(0, 2)} locale="en-US" selectedSlotId="s-mon-1330" onPick={() => {}} />);
    expect(out).toContain('aria-label="Morning, Monday, November 2"');
    expect(out).toContain('aria-label="Afternoon, Monday, November 2"');
    expect(out).toContain('aria-label="9:00 AM to 10:00 AM, Monday, November 2"');
    expect(out).toMatch(/data-slot="s-mon-1330" aria-pressed="true"[^>]*>1:30 PM</);
  });

  it("a visit: when with the zone's name for that date, where, and what", () => {
    const out = html(<VisitFacts visit={publicVisit()} locale="en-US" />);
    expect(out).toContain("Monday, November 2, 9:00 – 10:00 AM MST");
    expect(out).toContain("123 Main St, Salt Lake City, UT 84101");
    expect(out).toContain("Free estimate with Acme Windows");
  });

  it("calendar exports: Google built from the instants, .ics from the server", () => {
    const visit = publicVisit();
    const google = clientCalendarUrl(visit, "https://acme.test/visit/t")!;
    const out = html(<CalendarActions google={google} icsHref="/api/schedule/v1/visit/t/ics" />);
    expect(out).toContain('download="visit.ics"');
    expect(out).toContain("Add to Google Calendar");
    const params = new URL(google).searchParams;
    expect(params.get("text")).toBe("Free estimate — Acme Windows");
    expect(params.get("details")).toBe("Change or cancel: https://acme.test/visit/t");
    expect(html(<CalendarActions google={null} icsHref={null} />)).toBe("");
  });

  it("contacts are links, in a sentence", () => {
    expect(html(<ContactLinks phone="(801) 555-0143" email="office@acme.test" />)).toBe(
      '<span class="aisw-contact">Call <a href="tel:8015550143">(801) 555-0143</a> or email <a href="mailto:office@acme.test">office@acme.test</a>.</span>',
    );
    expect(html(<ContactLinks phone={null} email={null} />)).toBe("");
  });

  it("a field's error is wired to it, and a notice that matters is an alert", () => {
    const out = html(
      <Field id="f" label="Email" error="Enter an email.">
        <input id="f" aria-describedby="f-error" />
      </Field>,
    );
    expect(out).toContain('<span class="aisw-field-error" id="f-error">Enter an email.</span>');
    expect(html(<Notice tone="error">x</Notice>)).toContain('role="alert"');
    expect(html(<Notice tone="info">x</Notice>)).toContain('role="status"');
  });

  it("the link to keep is a read-only field with a copy button", () => {
    const out = html(<CopyField label="Keep this link" value="https://acme.test/visit/t" buttonLabel="Copy link" />);
    expect(out).toContain('readOnly=""');
    expect(out).toContain('value="https://acme.test/visit/t"');
    expect(out).toContain(">Copy link</button>");
  });
});
