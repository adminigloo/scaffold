import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bookingEmailTemplate,
  bookingEmailTemplates,
  bookingEmailVars,
  renderBookingTemplate,
  type BookingEmailTemplateKey,
} from "../emails.js";
import type { AdminBooking, BookingEvent, EventHost } from "../services/context.js";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

const booking: AdminBooking = {
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  tenantId: "acme",
  typeId: "type-1",
  typeKey: "consult",
  typeName: "Consultation",
  hostId: "host-1",
  hostDisplayName: "Maya Lopez",
  status: "confirmed",
  start: new Date("2026-10-14T15:00:00Z"),
  end: new Date("2026-10-14T15:30:00Z"),
  hostTimezone: "America/Denver",
  inviteeTimezone: "Europe/London",
  inviteeName: "Ada Lovelace",
  inviteeEmail: "ada@example.com",
  inviteePhone: "+442079460958",
  inviteeCompany: "Analytical Engines",
  notes: "About the support console.",
  medium: "video",
  source: "newsletter",
  sequence: 0,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  outcome: null,
  createdAt: new Date("2026-10-02T12:00:00Z"),
  updatedAt: new Date("2026-10-02T12:00:00Z"),
};

const host: EventHost = {
  displayName: "Maya Lopez",
  email: "maya@acme.test",
  timezone: "America/Denver",
  meetingLink: "https://meet.example.com/maya",
  phone: null,
  inviteMailbox: null,
};

const base = { tenantId: "acme", booking, host, type: { id: "type-1", key: "consult", name: "Consultation", durationMinutes: 30 } };
const created: BookingEvent = { ...base, event: "booking.created", manageToken: TOKEN };
const OPTIONS = { baseUrl: "https://acme.test/", includeManageLink: true } as const;

/** Every {{name}} a template uses. */
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1] ?? "");

describe("bookingEmailTemplates", () => {
  it("is plain data: one template per key, product-neutral, with an audience each", () => {
    const keys: BookingEmailTemplateKey[] = [
      "booking_confirmation",
      "booking_requested",
      "booking_confirmed",
      "booking_rescheduled",
      "booking_cancelled",
      "booking_host_cancelled",
      "booking_reminder",
      "booking_host_notice",
    ];
    expect(bookingEmailTemplates.map((template) => template.key).sort()).toEqual([...keys].sort());
    for (const template of bookingEmailTemplates) {
      expect(Object.keys(template).sort()).toEqual(["audience", "body", "key", "subject"]);
      expect(`${template.subject}\n${template.body}`).not.toMatch(/Dallin|AdminIgloo|adminigloo/i);
      expect(template.audience).toBe(template.key === "booking_host_notice" ? "host" : "invitee");
    }
    expect(bookingEmailTemplate("booking_reminder").subject).toMatch(/^Reminder:/);
  });

  it("every placeholder is filled by bookingEmailVars for its audience", () => {
    const vars = bookingEmailVars({ ...base, event: "booking.rescheduled", previousStart: new Date("2026-10-13T15:00:00Z"), manageToken: TOKEN }, OPTIONS);
    for (const template of bookingEmailTemplates) {
      const side = template.audience === "host" ? vars.host : vars.invitee;
      for (const name of placeholders(`${template.subject}\n${template.body}`)) {
        expect(side, `${template.key}: {{${name}}}`).toHaveProperty(name);
      }
    }
  });

  it("never promises an email the package cannot see sent", () => {
    for (const template of bookingEmailTemplates) {
      expect(template.body).not.toMatch(/tomorrow|follows by email/i);
    }
  });

  it("the package stays independent of any mail vendor or comms package", () => {
    const source = readFileSync(new URL("../emails.ts", import.meta.url), "utf8");
    // No import of one (the doc comment may NAME vendors; it must not load them).
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*["'](?:@adminigloo\/comms|resend|nodemailer)/i);
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort()).toEqual([
      "./ics.js",
      "./schema.js",
      "./services/context.js",
    ]);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@adminigloo/comms");
  });
});

describe("bookingEmailVars", () => {
  it("booking.created (confirmed): the confirmation and the host notice, each in the reader's zone, with the manage link", () => {
    const mail = bookingEmailVars(created, OPTIONS);
    expect(mail.templateFor).toEqual({ invitee: "booking_confirmation", host: "booking_host_notice" });
    expect(mail.to).toEqual({ invitee: "ada@example.com", host: "maya@acme.test" });
    expect(mail.invitee.when).toMatch(/\(Europe\/London\)$/);
    expect(mail.invitee.when).toContain("4:00"); // 15:00Z is 4 PM in London (BST)
    expect(mail.host.when).toMatch(/\(America\/Denver\)$/);
    expect(mail.host.when).toContain("9:00"); // …and 9 AM in Denver
    expect(mail.invitee.manageUrl).toBe(`https://acme.test/book/manage/${TOKEN}`);
    expect(mail.invitee.icsUrl).toBe(`https://acme.test/api/booking/v1/manage/${TOKEN}/ics`);
    expect(new URL(mail.invitee.googleCalendarUrl ?? "").searchParams.get("details")).toContain(TOKEN);
    expect(mail.invitee.firstName).toBe("Ada");
    expect(mail.host.headline).toBe("Ada Lovelace (Analytical Engines) booked a call with you (Consultation).");
    expect(mail.host.subjectTag).toBe("New call");
    expect(mail.host.inviteeEmail).toBe("ada@example.com");
  });

  it("includeManageLink: false keeps every token-bearing link out — safe for a queued reminder or a delivery log", () => {
    const mail = bookingEmailVars(created, { ...OPTIONS, includeManageLink: false });
    expect(JSON.stringify(mail)).not.toContain(TOKEN);
    expect(mail.invitee.manageLine).toBe("Need to move it or cancel? Use the private link in your booking confirmation.");
    expect(mail.invitee.manageUrl).toBe("the private link in your booking confirmation");
    expect(mail.invitee.calendarLinks).toMatch(/^Add it to Google Calendar: https:\/\/calendar\.google\.com/);
    const reminder = renderBookingTemplate(bookingEmailTemplate("booking_reminder"), mail.invitee);
    expect(reminder.body).not.toContain(TOKEN);
    expect(reminder.body).toContain("Need to move it or cancel?");
    // Negative control: the same event with the link allowed does carry it.
    expect(JSON.stringify(bookingEmailVars(created, OPTIONS))).toContain(TOKEN);
  });

  it("custom manage and API paths, and a host zone override", () => {
    const mail = bookingEmailVars(created, {
      baseUrl: "https://acme.test",
      includeManageLink: true,
      manageUrl: (token) => `https://acme.test/calls/${token}`,
      apiBase: "/api/calls",
      hostZone: "Asia/Tokyo",
      bookUrl: "https://acme.test/meet",
      adminUrl: "https://acme.test/staff/calls",
    });
    expect(mail.invitee.manageUrl).toBe(`https://acme.test/calls/${TOKEN}`);
    expect(mail.invitee.icsUrl).toBe(`https://acme.test/api/calls/v1/manage/${TOKEN}/ics`);
    expect(mail.host.when).toMatch(/\(Asia\/Tokyo\)$/);
    expect(mail.invitee.bookUrl).toBe("https://acme.test/meet");
    expect(mail.host.adminUrl).toBe("https://acme.test/staff/calls");
  });

  it("a requested call, then the host's confirmation (which carries no token, so no link)", () => {
    const requested = bookingEmailVars({ ...created, booking: { ...booking, status: "requested" } }, OPTIONS);
    expect(requested.templateFor).toEqual({ invitee: "booking_requested", host: "booking_host_notice" });
    expect(requested.host.subjectTag).toBe("Call request");
    const confirmed = bookingEmailVars({ ...base, event: "booking.confirmed" }, OPTIONS);
    expect(confirmed.templateFor).toEqual({ invitee: "booking_confirmed", host: null });
    expect(confirmed.invitee.manageLine).toMatch(/Use the private link in your booking confirmation/);
  });

  it("rescheduled: by the invitee tells the host; by the host tells only the invitee, and says sorry", () => {
    const previousStart = new Date("2026-10-13T15:00:00Z");
    const byInvitee = bookingEmailVars({ ...base, event: "booking.rescheduled", previousStart, manageToken: TOKEN }, OPTIONS);
    expect(byInvitee.templateFor).toEqual({ invitee: "booking_rescheduled", host: "booking_host_notice" });
    expect(byInvitee.invitee.previousWhen).toContain("Tuesday, October 13");
    expect(byInvitee.invitee.rescheduleLine).toBe("Your Consultation with Maya Lopez has moved.");
    expect(byInvitee.host.calendarLine).toMatch(/delete the old event/);
    const byHost = bookingEmailVars({ ...base, event: "booking.rescheduled", previousStart, by: "host" }, OPTIONS);
    expect(byHost.templateFor).toEqual({ invitee: "booking_rescheduled", host: null });
    expect(byHost.invitee.rescheduleLine).toBe("Maya Lopez had to move your Consultation. Sorry for the change.");
    expect(byHost.invitee.manageLine).toMatch(/Use the private link/); // no token on a host move
  });

  it("cancelled: by the invitee, or by the host with their note", () => {
    const byInvitee = bookingEmailVars({ ...base, event: "booking.cancelled", by: "invitee" }, OPTIONS);
    expect(byInvitee.templateFor).toEqual({ invitee: "booking_cancelled", host: "booking_host_notice" });
    expect(byInvitee.host.calendarLine).toBe("If it's on your calendar, you can delete it.");
    const byHost = bookingEmailVars(
      { ...base, booking: { ...booking, status: "cancelled", cancelReason: "Out sick" }, event: "booking.cancelled", by: "host" },
      OPTIONS,
    );
    expect(byHost.templateFor).toEqual({ invitee: "booking_host_cancelled", host: null });
    expect(byHost.invitee.cancelNote).toBe('Note from Maya: "Out sick"');
    const rendered = renderBookingTemplate(bookingEmailTemplate("booking_host_cancelled"), byHost.invitee);
    expect(rendered.body).toContain('Note from Maya: "Out sick"');
    expect(rendered.body).toContain("https://acme.test/book");
  });

  it("how we meet, per medium — and a missing video link promises no email", () => {
    const noLink = bookingEmailVars({ ...created, host: { ...host, meetingLink: null } }, OPTIONS);
    expect(noLink.invitee.howWeMeet).toBe("Video call. Maya Lopez will send you the link before the call.");
    expect(noLink.host.howWeMeet).toMatch(/No meeting link is saved/);
    const phone = bookingEmailVars({ ...created, booking: { ...booking, medium: "phone" } }, OPTIONS);
    expect(phone.invitee.howWeMeet).toContain("+442079460958");
    expect(new URL(phone.host.hostGoogleCalendarUrl ?? "").searchParams.get("location")).toBe("Call +442079460958");
    const theirs = bookingEmailVars({ ...created, booking: { ...booking, medium: "prospect_hosted" } }, OPTIONS);
    expect(theirs.invitee.howWeMeet).toContain("maya@acme.test");
  });
});

describe("renderBookingTemplate", () => {
  it("fills placeholders, renders unknown ones empty, and folds the blank lines they leave", () => {
    const out = renderBookingTemplate(
      { subject: "Hi {{ name }}\n  there", body: "A {{name}}\n\n{{gone}}\n\n\n\nB {{missing}}" },
      { name: "Ada", gone: "" },
    );
    expect(out.subject).toBe("Hi Ada there");
    expect(out.body).toBe("A Ada\n\nB");
  });

  it("renders a whole confirmation that reads like an email", () => {
    const mail = bookingEmailVars(created, OPTIONS);
    const { subject, body } = renderBookingTemplate(bookingEmailTemplate("booking_confirmation"), mail.invitee);
    expect(subject).toMatch(/^Booked: Consultation with Maya Lopez, Wed, Oct 14/);
    expect(body.startsWith("Hi Ada,\n\nYou're booked for a 30-minute Consultation with Maya Lopez.")).toBe(true);
    expect(body).toContain(`Apple Calendar, Outlook and others (.ics file): https://acme.test/api/booking/v1/manage/${TOKEN}/ics`);
    expect(body).not.toMatch(/\{\{|\n{3,}/);
  });
});
