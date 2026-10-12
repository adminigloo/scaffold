// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrewDay } from "../admin/CrewDay.js";
import { adminErrorText } from "../admin/helpers.js";
import { ScheduleCalendar } from "../admin/ScheduleCalendar.js";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import type { AdminStatus, SettingsPatch } from "../admin/types.js";
import { parseVisitRequestResponse } from "../client.js";
import { createRequester } from "../http.js";
import { ManageVisit } from "../ManageVisit.js";
import { resolveHostTheme } from "../theme.js";
import { VisitPicker } from "../VisitPicker.js";
import {
  availability,
  button,
  calendar,
  choose,
  click,
  CONFIG,
  crewDay,
  fail,
  fakeAdmin,
  fakePublic,
  labelled,
  mount,
  ok,
  publicVisit,
  resource,
  settingsWire,
  settle,
  slotsResponse,
  snapshot,
  submit,
  text,
  type,
} from "./fakes.js";

/**
 * The 0.4 review's findings on the SCREENS, each a test that failed before its
 * fix (run against the pre-fix source as a negative control):
 *
 *   BO-04  no "email the customer" offer when no email can leave; the banner says so
 *   BO-10  a request row shows where it is and what the customer said, the time once
 *   BO-15  Escape closes the Requests dialog after an answer; a fresh week isn't "unsaved"
 *   BO-11  today's route: undo, "couldn't do it" with a note, a crew switcher, remembered
 *   BO-02  a crew's login is a person picked from a list
 *   BO-08  correcting the zone with visits booked warns, and can email them
 *   BO-09  a service's link, not its "booking-page key"
 *   BO-12  no calendar entry for a visit that isn't on yet
 *   BO-07  "send it anyway" for an address the map can't find
 *   BO-13  a missed visit offers a new time
 *   F4     a repeat with no key is read, and said plainly
 *   RL-05  a light page with no theme class stays light on a dark OS
 *   RL-11  signed out reads "signed out"
 */

const OFF: AdminStatus = {
  customerEmails: false,
  reminders: false,
  upcomingVisits: 0,
  notices: [{ code: "emails_off", tone: "warn", message: "Customer emails are off: no email service is set up yet." }],
};

const REQUEST = snapshot({
  id: "p1",
  status: "pending",
  nextStatuses: ["confirmed", "declined", "cancelled"],
  startTime: "13:00",
  endTime: "14:00",
  startsAt: "2026-11-02T20:00:00.000Z",
  customerName: "Rita Ortiz",
  customerEmail: "rita@example.com",
  address: "77 Canyon Rd, Sandy",
  notes: "Side gate is unlocked\nDog is friendly",
  resourceId: "crew-b",
  resourceName: "Crew B",
  pendingExpiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
});

function calendarAdmin(status: AdminStatus | null, extra: Parameters<typeof fakeAdmin>[0] = {}) {
  return fakeAdmin({
    calendar: () => ok(calendar({ visits: [snapshot(), REQUEST], pending: [REQUEST] })),
    getSettings: () => ok({ settings: settingsWire() }),
    status: () => (status ? ok(status) : fail("not_found", "Not found.", { status: 404 })),
    accept: (id) => ok({ visit: { ...REQUEST, id, status: "confirmed" as const, nextStatuses: ["in_progress" as const] } }),
    ...extra,
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("BO-04: the staff screens never offer an email that won't be sent", () => {
  it("emails off: the banner says so; the Requests inbox, the visit panel and New visit offer no email", async () => {
    const fake = calendarAdmin(OFF);
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" initialDate="2026-11-02" pollMs={0} />);
    expect(text(container.querySelector("[data-aisw-notices]"))).toContain("Customer emails are off");

    await click(container.querySelector("[data-aisw-requests-button]"));
    const inbox = container.querySelector("[data-aisw-requests]")!;
    expect(text(inbox)).not.toContain("Email customers about my answers");
    expect(text(inbox)).toContain("Customer emails are off, so customers won't hear your answers from here.");
    await click(button(inbox, "Accept Rita Ortiz"));
    expect(fake.of("accept")[0]!.args).toEqual(["p1", { notify: false }]);
    await click(button(container, "Close"));

    await click(container.querySelector('[data-visit-id="v1"]'));
    const panel = container.querySelector("[data-aisw-panel]")!;
    expect(text(panel)).not.toContain("Email Jane about this");
    expect(text(panel)).toContain("Customer emails are off, so Jane won't be told about changes.");
    await click(button(panel, "Close"));

    await click(button(container, "New visit"));
    const dialog = container.querySelector("[data-aisw-new-visit]")!;
    await type(labelled(dialog, "Email"), "new@example.com");
    expect(text(dialog)).not.toContain("a confirmation");
    expect(text(dialog)).toContain("Customer emails are off, so no confirmation is sent.");
    await unmount();
  });

  it("an older server with no status route: the email choices stay, as before", async () => {
    const fake = calendarAdmin(null);
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" initialDate="2026-11-02" pollMs={0} />);
    await click(container.querySelector("[data-aisw-requests-button]"));
    expect(text(container.querySelector("[data-aisw-requests]"))).toContain("Email customers about my answers");
    await unmount();
  });
});

describe("BO-10 and BO-15: the Requests inbox", () => {
  it("each row: the time once, where it is, the note's first line", async () => {
    const fake = calendarAdmin(null);
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" initialDate="2026-11-02" pollMs={0} />);
    await click(container.querySelector("[data-aisw-requests-button]"));
    const row = container.querySelector('[data-request-id="p1"]')!;
    expect(text(row.querySelector(".aisw-request-when"))).toBe("Mon, Nov 2, 1:00 – 2:00 PM");
    expect(text(row.querySelector("[data-aisw-request-address]"))).toBe("77 Canyon Rd, Sandy");
    expect(text(row.querySelector("[data-aisw-request-note]"))).toBe("“Side gate is unlocked”");
    await unmount();
  });

  it("Escape still closes it after the focused Accept button went away", async () => {
    const fake = calendarAdmin(null);
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" initialDate="2026-11-02" pollMs={0} />);
    await click(container.querySelector("[data-aisw-requests-button]"));
    const accept = button(container.querySelector("[data-aisw-requests]")!, "Accept Rita Ortiz")!;
    accept.focus();
    await click(accept);
    await settle();
    // The button is gone; Escape pressed wherever focus ended up.
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(container.querySelector("[data-aisw-requests]")).toBeNull();
    await unmount();
  });
});

describe("BO-15: a crew whose hours were never saved", () => {
  it("isn't 'Unsaved changes' — it says it's using the usual hours, and can be saved as it is", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire() }),
      listResources: () => ok({ resources: [resource()] }),
      getAvailability: () => ok(availability()),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["hours"]} />);
    const week = container.querySelector("[data-aisw-week]")!;
    expect(text(week)).not.toContain("Unsaved changes");
    expect(text(week)).toContain("Using the crew's usual hours — save to keep them.");
    expect(button(week, "Save the week")!.disabled).toBe(false);
    await unmount();
  });
});

describe("BO-11: today's route, from the truck", () => {
  function routeAdmin(extra: Parameters<typeof fakeAdmin>[0] = {}) {
    let current = snapshot({ id: "v1" });
    return fakeAdmin({
      crewDay: (q) => ok(crewDay(q.resource ? { resource: { id: q.resource, name: q.resource === "crew-b" ? "Crew B" : "Crew A", homeBaseAddress: null } } : {})),
      listResources: () => fail("forbidden", "You don't have permission to do that.", { status: 403 }),
      progress: (_id, body) => {
        current = {
          ...current,
          status: body.status,
          updatedAt: new Date().toISOString(),
          ...(body.status === "completed" ? { completedAt: new Date().toISOString() } : {}),
          ...(body.note ? { cancelReason: body.note } : {}),
        };
        return ok({ visit: current });
      },
      ...extra,
    });
  }

  it("Complete has an Undo; Couldn't do it takes a note and has an Undo", async () => {
    const fake = routeAdmin();
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} pollMs={0} />);
    const stop = () => container.querySelector('[data-stop-id="v1"]')!;
    await click(button(stop(), "Start"));
    await click(button(stop(), "Complete"));
    await click(button(stop(), "Undo completing"));
    expect(fake.of("progress").map((c) => (c.args[1] as { status: string }).status)).toEqual(["in_progress", "completed", "in_progress"]);
    await click(button(stop(), "Couldn't do"));
    await type(stop().querySelector("textarea"), "Gate locked, nobody home");
    await submit(stop().querySelector("form[data-aisw-couldnt]"));
    expect(fake.of("progress").at(-1)!.args).toEqual(["v1", { status: "no_show", note: "Gate locked, nobody home" }]);
    expect(text(stop())).toContain("“Gate locked, nobody home”");
    await click(button(stop(), "Undo couldn't do"));
    expect(fake.of("progress").at(-1)!.args).toEqual(["v1", { status: "confirmed" }]);
    await unmount();
  });

  it("a login linked to no crew is told to ask the office — not shown a picker it may not use", async () => {
    const fake = routeAdmin({ crewDay: () => fail("invalid", "Pick a crew.", { status: 400 }) });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} pollMs={0} />);
    expect(text(container.querySelector("[data-aisw-crew-unlinked]"))).toContain("Your sign-in isn't linked to a crew yet.");
    expect(container.querySelector("[data-aisw-crew-pick]")).toBeNull();
    await unmount();
  });

  it("somebody who sees every crew can switch crews from the header, and the pick is remembered on this device", async () => {
    const fake = routeAdmin({ listResources: () => ok({ resources: [resource(), resource({ id: "crew-b", name: "Crew B" })] }) });
    const first = await mount(<CrewDay transport={fake.transport} pollMs={0} />);
    const switcher = first.container.querySelector("[data-aisw-crew-switch] select")!;
    await choose(switcher, "crew-b");
    expect(fake.of("crewDay").at(-1)!.args[0]).toEqual({ resource: "crew-b" });
    await first.unmount();
    // Next time on this phone: Crew B straight away.
    const again = fakeAdmin({ crewDay: (q) => ok(crewDay(q.resource ? { resource: { id: q.resource, name: "Crew B", homeBaseAddress: null } } : {})), listResources: () => ok({ resources: [] }) });
    const second = await mount(<CrewDay transport={again.transport} pollMs={0} />);
    expect(again.of("crewDay").some((c) => (c.args[0] as { resource?: string }).resource === "crew-b")).toBe(true);
    await second.unmount();
  });
});

describe("BO-02: a crew's login is a person, picked from a list", () => {
  it("the picker lists people by name and email, and saving sends their id", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire() }),
      listResources: () => ok({ resources: [resource()] }),
      people: () => ok({ people: [{ userId: "u_42", name: "Casey Crew", email: "casey@acme.test" }] }),
      updateResource: (id, patch) => ok({ resource: resource({ id, ...patch }) }),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["crews"]} signInUrl="https://acme.test/sign-in" />);
    await click(button(container, "Edit"));
    const picker = labelled(container, "Who opens this crew's route") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(["Nobody yet", "Casey Crew (casey@acme.test)"]);
    expect(text(container)).toContain("Ask them to sign in once at https://acme.test/sign-in, then pick them here.");
    expect(text(container)).not.toContain("The user id they sign in with");
    await choose(picker, "u_42");
    await submit(container.querySelector("form[data-aisw-crew-form]"));
    expect((fake.of("updateResource")[0]!.args[1] as { userId: string }).userId).toBe("u_42");
    await unmount();
  });
});

describe("BO-08: correcting the time zone with visits booked", () => {
  it("warns how many visits move, and can email those customers", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire() }),
      listResources: () => ok({ resources: [resource()] }),
      status: () => ok({ customerEmails: true, reminders: true, upcomingVisits: 3, notices: [] }),
      updateSettings: () => ok({ settings: settingsWire({ timeZone: "America/Chicago" }) }),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    await choose(labelled(container, "Time zone"), "America/Chicago");
    const warning = container.querySelector("[data-aisw-zone-warning]")!;
    expect(text(warning)).toContain("You have 3 upcoming visits. Each keeps its clock time");
    await click(warning.querySelector('input[type="checkbox"]'));
    await submit(container.querySelector('[data-aisw-card="business"] form'));
    expect(fake.of("updateSettings")[0]!.args[0] as SettingsPatch).toMatchObject({ timeZone: "America/Chicago", notifyCustomers: true });
    await unmount();
  });
});

describe("BO-09: a service shows the owner a link, not a key", () => {
  it("'Link straight to it: …/book?service=estimate', and no 'Booking-page key'", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire() }), listResources: () => ok({ resources: [] }) });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["booking"]} bookingPageUrl="https://acme.test/book" />);
    expect(text(container)).toContain("Link straight to it: https://acme.test/book?service=estimate");
    expect(text(container)).not.toContain("Booking-page key");
    await unmount();
  });
});

describe("the customer's side", () => {
  const RESPONSE = { visit: publicVisit(), manageToken: "tok_abc", manageUrl: "https://acme.test/visit/tok_abc", repeated: false };

  async function book(fake: ReturnType<typeof fakePublic>) {
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-service="estimate"]'));
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await type(labelled(container, "Your name"), "Jane Doe");
    await type(labelled(container, "Email"), "jane@example.com");
    await type(labelled(container, "Address for the visit"), "9 New Subdivision Rd, Eagle Mountain");
    await submit(container.querySelector("form[data-aisw-form]"));
    return { container, unmount };
  }

  it("BO-07: an address the map can't find can be sent anyway, with the business's phone", async () => {
    let calls = 0;
    const fake = fakePublic({
      config: () => ok(CONFIG),
      slots: () => ok(slotsResponse()),
      request: () => (++calls === 1 ? fail("address_unresolved", "We couldn't find that address.") : ok(RESPONSE)),
    });
    const { container, unmount } = await book(fake);
    const anyway = container.querySelector("[data-aisw-address-anyway]")!;
    expect(text(anyway)).toContain("Or call (801) 555-0143.");
    await click(button(anyway, "Send it anyway"));
    expect((fake.of("request")[1]!.args[0] as { addressAsTyped?: boolean }).addressAsTyped).toBe(true);
    expect(text(container)).toContain("Request received");
    await unmount();
  });

  it("BO-12: a confirmed booking offers the calendar; a request doesn't", async () => {
    const confirmed = fakePublic({
      config: () => ok({ ...CONFIG, autoConfirm: true }),
      slots: () => ok(slotsResponse()),
      request: () => ok({ ...RESPONSE, visit: publicVisit({ status: "confirmed" }) }),
    });
    const a = await book(confirmed);
    expect(a.container.querySelector('a[href^="https://calendar.google.com"]')).not.toBeNull();
    await a.unmount();
    const requested = fakePublic({ config: () => ok(CONFIG), slots: () => ok(slotsResponse()), request: () => ok(RESPONSE) });
    const b = await book(requested);
    expect(b.container.querySelector('a[href^="https://calendar.google.com"]')).toBeNull();
    await b.unmount();
  });

  it("F4: a repeat comes back with no key, and the page says the request was already in", async () => {
    expect(parseVisitRequestResponse({ visit: publicVisit(), manageToken: null, manageUrl: null, repeated: true })).toMatchObject({ repeated: true, manageToken: null });
    const fake = fakePublic({
      config: () => ok(CONFIG),
      slots: () => ok(slotsResponse()),
      request: () => ok({ visit: publicVisit(), manageToken: null, manageUrl: null, repeated: true }),
    });
    const { container, unmount } = await book(fake);
    expect(text(container.querySelector('[data-aisw-manage="repeat"]'))).toBe(
      "We already had this request from you, so nothing new was booked. The email we sent you has the link to change or cancel it.",
    );
    await unmount();
  });

  it("BO-13: a missed visit says it didn't go ahead and offers a new time", async () => {
    const fake = fakePublic({ visit: () => ok({ visit: publicVisit({ status: "missed", canCancel: false, canReschedule: false, changeDeadline: null }) }), config: () => ok(CONFIG) });
    const { container, unmount } = await mount(<ManageVisit token="t" transport={fake.transport} bookHref="/book-visit" />);
    expect(text(container)).toContain("Your free estimate didn't go ahead");
    expect(container.querySelector('a[href="/book-visit"]')).not.toBeNull();
    await unmount();
  });
});

describe("RL-05: the host page's own background decides, before the OS", () => {
  const osDark = () => ({ matches: true });
  const osLight = () => ({ matches: false });

  it("a light page with no theme class (Tailwind's light) stays light on a dark OS; a dark backdrop is dark", () => {
    const root = document.createElement("div");
    const wrapper = document.createElement("section");
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    expect(resolveHostTheme(root, osDark)).toBe("light");
    wrapper.style.backgroundColor = "rgb(17, 24, 39)";
    expect(resolveHostTheme(root, osLight)).toBe("dark");
  });
});

describe("RL-11: a dispatcher whose session ended reads 'signed out'", () => {
  it("a 401, or a sign-in page a redirect led to, is signed out", async () => {
    expect(adminErrorText({ code: "forbidden", message: "Sign in to see the schedule.", status: 401 })).toBe(
      "You've been signed out. Sign in again to keep working.",
    );
    const loginPage = {
      ok: true,
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<!doctype html><title>Sign in</title>",
    } as unknown as Response;
    const http = createRequester({ baseUrl: "/x", fetch: async () => loginPage });
    const result = await http.get("/v1/admin/calendar", () => ({}));
    expect(!result.ok && result.error).toEqual({ code: "forbidden", message: "You've been signed out. Sign in again to keep working.", status: 401 });
  });
});
