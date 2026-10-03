import { describe, expect, it } from "vitest";
import {
  buildHostFeed,
  buildIcs,
  escapeIcsText,
  foldLine,
  formatIcsUtc,
  googleCalendarUrl,
  howWeMeet,
  icsParamValue,
  SANDBOX_EVENT_DESCRIPTION,
  SANDBOX_TITLE_PREFIX,
  sandboxEventDescription,
  type BuildIcsInput,
} from "../ics.js";
import { parseIcsComponents, unfoldLines } from "../ical.js";

const encoder = new TextEncoder();
const NOW = new Date("2026-10-02T12:00:00Z");

function input(overrides: Partial<BuildIcsInput> = {}): BuildIcsInput {
  return {
    booking: {
      id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      startUtc: new Date("2026-10-14T15:00:00Z"),
      endUtc: new Date("2026-10-14T15:30:00Z"),
      sequence: 0,
      medium: "video",
      inviteeName: "Ada Lovelace",
      inviteeEmail: "ada@example.com",
    },
    host: {
      displayName: "Dallin",
      email: "dallin@adminigloo.com",
      meetingLink: "https://meet.example.com/dallin",
      phone: "+18015550143",
      inviteMailbox: null,
    },
    type: { name: "Intro call" },
    method: "PUBLISH",
    uidDomain: "adminigloo.com",
    manageUrl: "https://adminigloo.com/book/manage/abc",
    now: NOW,
    ...overrides,
  };
}

function props(ics: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of unfoldLines(ics)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).split(";")[0] ?? "";
    if (!map.has(name)) map.set(name, line);
  }
  return map;
}

describe("text primitives", () => {
  it("formats UTC in the basic format", () => {
    expect(formatIcsUtc(new Date("2026-10-14T15:00:00.123Z"))).toBe("20261014T150000Z");
  });

  it("escapes backslash first, then separators and newlines", () => {
    expect(escapeIcsText("a\\b; c, d\ne\r\nf")).toBe("a\\\\b\\; c\\, d\\ne\\nf");
  });

  it("quotes a parameter value with separators and drops what cannot be represented", () => {
    expect(icsParamValue("Ada Lovelace")).toBe("Ada Lovelace");
    expect(icsParamValue("Lovelace, Ada")).toBe('"Lovelace, Ada"');
    expect(icsParamValue('Ada "the Countess"\nLovelace')).toBe("Ada the CountessLovelace");
  });

  it("folds at 75 octets, never splitting a multi-byte character", () => {
    const line = `DESCRIPTION:${"Café ☕ ".repeat(30)}`;
    const folded = foldLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const part of physical) expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    for (const part of physical.slice(1)) expect(part.startsWith(" ")).toBe(true);
    expect(unfoldLines(folded).join("")).toBe(line);
    expect(folded).not.toContain("�");
  });

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });
});

describe("buildIcs", () => {
  it("is CRLF throughout, ends with CRLF, and every line fits in 75 octets", () => {
    const ics = buildIcs(input({ booking: { ...input().booking, inviteeName: "A very long name ".repeat(8) } }));
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of ics.split("\r\n")) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
  });

  it("carries the contract fields", () => {
    const ics = buildIcs(input({ booking: { ...input().booking, sequence: 3 } }));
    const p = props(ics);
    expect(p.get("METHOD")).toBe("METHOD:PUBLISH");
    expect(p.get("UID")).toBe("UID:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@adminigloo.com");
    expect(p.get("SEQUENCE")).toBe("SEQUENCE:3");
    expect(p.get("DTSTART")).toBe("DTSTART:20261014T150000Z");
    expect(p.get("DTEND")).toBe("DTEND:20261014T153000Z");
    expect(p.get("DTSTAMP")).toBe("DTSTAMP:20261002T120000Z");
    expect(p.get("SUMMARY")).toBe("SUMMARY:Intro call with Dallin");
    expect(p.get("STATUS")).toBe("STATUS:CONFIRMED");
    expect(p.get("LOCATION")).toBe("LOCATION:https://meet.example.com/dallin");
    expect(p.get("ORGANIZER")).toBe("ORGANIZER;CN=Dallin:mailto:dallin@adminigloo.com");
    expect(p.get("ATTENDEE")).toBe("ATTENDEE;CN=Ada Lovelace;ROLE=REQ-PARTICIPANT:mailto:ada@example.com");
    expect(p.get("DESCRIPTION")).toContain("https://adminigloo.com/book/manage/abc");
    expect(p.get("DESCRIPTION")).toContain("Video call: https://meet.example.com/dallin");
  });

  it("parses back as one well-formed VEVENT inside one VCALENDAR", () => {
    const [calendar] = parseIcsComponents(buildIcs(input()));
    expect(calendar?.name).toBe("VCALENDAR");
    expect(calendar?.components.map((component) => component.name)).toEqual(["VEVENT"]);
  });

  it("escapes a company-style name in SUMMARY and quotes it in CN", () => {
    const ics = buildIcs(
      input({
        host: { ...input().host, displayName: "Acme, Inc.; Sales" },
        booking: { ...input().booking, inviteeName: "Lovelace, Ada" },
      }),
    );
    const p = props(ics);
    expect(p.get("SUMMARY")).toBe("SUMMARY:Intro call with Acme\\, Inc.\\; Sales");
    expect(p.get("ORGANIZER")).toBe('ORGANIZER;CN="Acme, Inc.; Sales":mailto:dallin@adminigloo.com');
    expect(p.get("ATTENDEE")).toContain('CN="Lovelace, Ada"');
  });

  it("CANCEL keeps the UID, says CANCELLED, and carries the row's sequence", () => {
    const published = props(buildIcs(input()));
    const cancelled = props(buildIcs(input({ method: "CANCEL", booking: { ...input().booking, sequence: 2 } })));
    expect(cancelled.get("METHOD")).toBe("METHOD:CANCEL");
    expect(cancelled.get("STATUS")).toBe("STATUS:CANCELLED");
    expect(cancelled.get("UID")).toBe(published.get("UID"));
    expect(cancelled.get("SEQUENCE")).toBe("SEQUENCE:2");
  });

  it("a rescheduled booking keeps its UID and only moves forward in SEQUENCE", () => {
    const before = props(buildIcs(input()));
    const after = props(
      buildIcs(
        input({
          booking: { ...input().booking, startUtc: new Date("2026-10-15T16:00:00Z"), endUtc: new Date("2026-10-15T16:30:00Z"), sequence: 1 },
        }),
      ),
    );
    expect(after.get("UID")).toBe(before.get("UID"));
    expect(after.get("SEQUENCE")).toBe("SEQUENCE:1");
    expect(after.get("DTSTART")).toBe("DTSTART:20261015T160000Z");
  });

  it("describes each medium", () => {
    const phone = props(buildIcs(input({ booking: { ...input().booking, medium: "phone" } })));
    expect(phone.get("LOCATION")).toBe("LOCATION:Phone call");
    expect(phone.get("DESCRIPTION")).toContain("+18015550143");

    const theirs = props(buildIcs(input({ booking: { ...input().booking, medium: "prospect_hosted" } })));
    expect(theirs.get("LOCATION")).toBe("LOCATION:Their meeting link (they send the invite)");

    const yours = props(buildIcs(input({ audience: "invitee", booking: { ...input().booking, medium: "prospect_hosted" } })));
    expect(yours.get("LOCATION")).toBe("LOCATION:Your meeting link (you send the invite)");
    expect(yours.get("DESCRIPTION")).toContain("dallin@adminigloo.com");

    const noLink = props(buildIcs(input({ host: { ...input().host, meetingLink: null } })));
    expect(noLink.get("LOCATION")).toBe("LOCATION:Video call");
  });

  it("a video call without a link says who sends it, and promises no email", () => {
    const host = { ...input().host, meetingLink: null };
    expect(howWeMeet({ medium: "video", host, audience: "invitee" })).toBe("Video call — Dallin will send you the link before the call.");
    expect(howWeMeet({ medium: "video", host, audience: "host" })).toMatch(/no meeting link is saved/);
    const invitee = props(buildIcs(input({ audience: "invitee", host })));
    expect(invitee.get("DESCRIPTION")).toContain("Dallin will send you the link before the call.");
    expect(invitee.get("DESCRIPTION")).not.toMatch(/email/i);
  });
});

describe("buildIcs for a sandbox booking", () => {
  it("is an unmistakable non-event: prefixed, tentative, transparent, no organizer, attendee, location or URL", () => {
    const ics = buildIcs(input({ sandbox: true, audience: "invitee", realBookingUrl: "https://adminigloo.com/book" }));
    const map = props(ics);
    expect(map.get("SUMMARY")).toBe("SUMMARY:[Sandbox — not a real booking] Intro call with Dallin");
    expect(map.get("DESCRIPTION")).toBe(
      `DESCRIPTION:${escapeIcsText(`${SANDBOX_EVENT_DESCRIPTION}\n\nBook a real call: https://adminigloo.com/book`)}`,
    );
    expect(map.get("STATUS")).toBe("STATUS:TENTATIVE");
    expect(map.get("TRANSP")).toBe("TRANSP:TRANSPARENT");
    for (const name of ["ORGANIZER", "ATTENDEE", "LOCATION", "URL"]) expect(map.has(name), name).toBe(false);
    expect(ics).not.toContain("adminigloo.com/book/manage");
    expect(ics).not.toContain("ada@example.com");
    // Still a well-formed file with the stable UID, so a later CANCEL finds it.
    expect(map.get("UID")).toBe("UID:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@adminigloo.com");
    expect(parseIcsComponents(ics)[0]?.components.filter((component) => component.name === "VEVENT")).toHaveLength(1);
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("CANCEL still says CANCELLED (so a client removes it), and no realBookingUrl means no extra line", () => {
    const map = props(buildIcs(input({ sandbox: true, method: "CANCEL" })));
    expect(map.get("STATUS")).toBe("STATUS:CANCELLED");
    expect(map.get("METHOD")).toBe("METHOD:CANCEL");
    expect(map.get("DESCRIPTION")).toBe(`DESCRIPTION:${escapeIcsText(SANDBOX_EVENT_DESCRIPTION)}`);
    expect(sandboxEventDescription(null)).toBe(SANDBOX_EVENT_DESCRIPTION);
    expect(SANDBOX_TITLE_PREFIX).toBe("[Sandbox — not a real booking] ");
  });

  it("negative control: without sandbox the same input is a confirmed event with an organizer", () => {
    const map = props(buildIcs(input()));
    expect(map.get("STATUS")).toBe("STATUS:CONFIRMED");
    expect(map.has("ORGANIZER")).toBe(true);
    expect(map.get("SUMMARY")).toBe("SUMMARY:Intro call with Dallin");
  });
});

describe("buildHostFeed", () => {
  const feed = buildHostFeed({
    host: { displayName: "Dallin" },
    uidDomain: "adminigloo.com",
    now: NOW,
    bookings: [
      {
        id: "b1",
        startUtc: new Date("2026-10-14T15:00:00Z"),
        endUtc: new Date("2026-10-14T15:30:00Z"),
        sequence: 1,
        medium: "phone",
        typeName: "Intro call",
        inviteeName: "Ada King Lovelace",
        inviteeCompany: "Analytical Engines",
      },
      {
        id: "b2",
        startUtc: new Date("2026-10-15T15:00:00Z"),
        endUtc: new Date("2026-10-15T15:30:00Z"),
        sequence: 0,
        medium: "video",
        typeName: "Intro call",
        inviteeName: "Grace",
        inviteeCompany: null,
      },
    ],
  });

  it("is a PUBLISH calendar of the bookings with stable UIDs", () => {
    expect(feed).toContain("METHOD:PUBLISH");
    expect(feed).toContain("UID:b1@adminigloo.com");
    expect(feed).toContain("SUMMARY:Intro call: Ada (Analytical Engines)");
    expect(feed).toContain("SUMMARY:Intro call: Grace");
    expect(feed).toContain("X-WR-CALNAME:Calls — Dallin");
  });

  it("carries first name and company only (F7)", () => {
    expect(feed).not.toContain("Lovelace");
    expect(feed).not.toContain("King");
    expect(feed).not.toMatch(/mailto:|ATTENDEE|ORGANIZER|@example/);
  });
});

describe("googleCalendarUrl", () => {
  it("builds a TEMPLATE link with UTC dates", () => {
    const url = new URL(
      googleCalendarUrl({
        title: "Intro call with Dallin",
        start: new Date("2026-10-14T15:00:00Z"),
        end: new Date("2026-10-14T15:30:00Z"),
        details: "Video call: https://meet.example.com/x",
        location: "https://meet.example.com/x",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Intro call with Dallin");
    expect(url.searchParams.get("dates")).toBe("20261014T150000Z/20261014T153000Z");
    expect(url.searchParams.get("location")).toBe("https://meet.example.com/x");
  });
});
