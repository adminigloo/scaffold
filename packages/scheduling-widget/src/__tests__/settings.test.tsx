// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import type { SettingsPatch, SetWeeklyBody } from "../admin/types.js";
import { availability, button, choose, click, fail, fakeAdmin, labelled, mount, ok, resource, settingsWire, snapshot, submit, text, type } from "./fakes.js";
import type { AdminHandlers } from "./fakes.js";

/**
 * <SchedulingSettings> (contract 8.7): each card saves on its own, says
 * "Saved", marks unsaved changes, and puts the server's refusals on the
 * field they're about. The hours editor starts from the crew's real hours
 * (never a made-up 8–5), allows split shifts, and saves the week only; adding
 * days off warns about visits already booked on them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function admin(extra: AdminHandlers = {}) {
  return fakeAdmin({
    getSettings: () => ok({ settings: settingsWire() }),
    listResources: () => ok({ resources: [resource(), resource({ id: "old", name: "Old van", isActive: false })] }),
    getAvailability: () => ok(availability()),
    ...extra,
  });
}

const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-aisw-card="${id}"]`)!;

describe("<SchedulingSettings>", () => {
  it("saves a card on its own: unsaved changes marked, then 'Saved'", async () => {
    const fake = admin({ updateSettings: (patch) => ok({ settings: settingsWire({ ...(patch as Partial<ReturnType<typeof settingsWire>>) }) }) });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} />);
    const business = card(container, "business");
    await type(labelled(business, "Business name"), "Acme Window Co.");
    expect(text(business)).toContain("Unsaved changes");
    await submit(business.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toEqual({
      businessName: "Acme Window Co.",
      timeZone: "America/Denver",
      contactPhone: "(801) 555-0143",
      contactEmail: "office@acme.test",
      staffNotifyEmails: ["office@acme.test"],
    });
    expect(text(business)).toContain("Saved");
    expect(text(business)).not.toContain("Unsaved changes");
    await unmount();
  });

  it("puts the server's refusals on the fields they're about", async () => {
    const fake = admin({
      updateSettings: () =>
        fail("invalid", "Check the form.", {
          status: 400,
          issues: [
            { path: ["services", 0, "name"], message: "Give the service a name a customer understands." },
            { path: ["horizonDays"], message: "Pick between 1 and 365 days." },
          ],
        }),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} />);
    const booking = card(container, "booking");
    await type(labelled(booking, "How far ahead"), "400");
    await submit(booking.querySelector("form"));
    const horizon = labelled(booking, "How far ahead")!;
    expect(horizon.getAttribute("aria-describedby")).toContain("-error");
    expect(text(booking)).toContain("Pick between 1 and 365 days.");
    const name = labelled(booking, "Name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(text(booking)).toContain("Give the service a name a customer understands.");
    expect(text(booking)).toContain("Check the highlighted fields.");
    await unmount();
  });

  it("offers US time zones by name first, then every zone under Other…", async () => {
    const fake = admin({ updateSettings: () => ok({ settings: settingsWire({ timeZone: "Europe/London" }) }) });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    const zone = labelled(container, "Time zone") as HTMLSelectElement;
    expect([...zone.options].slice(0, 3).map((o) => o.textContent)).toEqual(["Eastern Time (New York)", "Central Time (Chicago)", "Mountain Time (Denver)"]);
    expect(zone.value).toBe("America/Denver");
    expect(text(container)).toContain("Where your crews work. Every time customers and crews see is in it.");
    await choose(zone, "__other");
    await choose(labelled(container, "Other time zone"), "Europe/London");
    await submit(container.querySelector('[data-aisw-card="business"] form'));
    expect((fake.of("updateSettings")[0]!.args[0] as SettingsPatch).timeZone).toBe("Europe/London");
    await unmount();
  });

  it("the services editor adds, reorders and removes, and auto-confirm says what it does", async () => {
    const fake = admin({ updateSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["booking"]} />);
    const booking = card(container, "booking");
    expect(text(booking)).toContain("Off: you accept or decline each request.");
    await click(button(booking, "+ Add a service"));
    const names = booking.querySelectorAll<HTMLInputElement>("[data-service-row] input");
    await type([...names].filter((i) => i.id.endsWith("-name"))[1], "Gutter clean");
    await click(button(booking, "Move Gutter clean up"));
    await submit(booking.querySelector("form"));
    const patch = fake.of("updateSettings")[0]!.args[0] as SettingsPatch;
    expect(patch.services!.map((s) => [s.key, s.name])).toEqual([
      ["new-service", "Gutter clean"],
      ["estimate", "Free estimate"],
    ]);
    expect(patch.minNoticeMinutes).toBe(1440);
    await unmount();
  });

  it("the week starts from the crew's real hours, takes a split shift, and saves the week only", async () => {
    const fake = admin({
      setWeekly: (_id, body) => ok(availability({ hoursConfigured: true, weekly: body.weekly, effectiveWeekly: body.weekly })),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["hours"]} />);
    const week = container.querySelector<HTMLElement>("[data-aisw-week]")!;
    const monday = () => week.querySelector<HTMLElement>('[data-day="1"]')!;
    // Never configured: it shows what applies now (Mon–Fri 8–5), not a guess.
    expect(text(week)).toContain("These are the hours this crew has now");
    expect(monday().querySelectorAll("select")).toHaveLength(2);
    expect(text(week.querySelector('[data-day="6"]'))).toContain("Off");
    await choose(monday().querySelectorAll("select")[1], "12:00");
    await click(button(monday(), "Add hours on Monday"));
    const selects = monday().querySelectorAll<HTMLSelectElement>("select");
    expect([selects[2]!.value, selects[3]!.value]).toEqual(["13:00", "17:00"]);
    await submit(week);
    const body = fake.of("setWeekly")[0]!.args[1] as SetWeeklyBody;
    expect(fake.of("setWeekly")[0]!.args[0]).toBe("crew-a");
    expect(body.weekly.filter((w) => w.dayOfWeek === 1)).toEqual([
      { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
      { dayOfWeek: 1, startTime: "13:00", endTime: "17:00" },
    ]);
    expect(body.weekly).toHaveLength(6);
    expect(text(container)).toContain("Saved");
    await unmount();
  });

  it("warns when days off land on booked visits, and lists days off as ranges", async () => {
    const fake = admin({
      addTimeOff: (_id, body) =>
        ok({
          ...availability({
            timeOff: [
              { id: "x1", date: body.from, note: body.note ?? null },
              { id: "x2", date: body.to, note: body.note ?? null },
            ],
          }),
          visitsOnThoseDays: [snapshot({ id: "a" }), snapshot({ id: "b" }), snapshot({ id: "c" })],
        }),
      removeTimeOff: () => ok(availability()),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["hours"]} />);
    const off = container.querySelector<HTMLElement>("[data-aisw-time-off]")!;
    await type(labelled(off, "First day off"), "2030-11-02");
    await type(labelled(off, "Last day off"), "2030-11-03");
    await type(labelled(off, "Note"), "Vacation");
    await submit(off.querySelector("form"));
    expect(fake.of("addTimeOff")[0]!.args).toEqual(["crew-a", { from: "2030-11-02", to: "2030-11-03", note: "Vacation" }]);
    expect(text(off)).toContain("3 visits are booked on those days. Move them from the calendar.");
    expect(text(off.querySelector('[data-time-off="2030-11-02"]'))).toContain("Sat, Nov 2 – Sun, Nov 3 · 2 days · Vacation");
    await click(button(off.querySelector('[data-time-off="2030-11-02"]')!, "Remove"));
    expect(fake.of("removeTimeOff").map((c) => c.args)).toEqual([
      ["crew-a", "x1"],
      ["crew-a", "x2"],
    ]);
    await unmount();
  });

  it("crews: pause online booking, and removed crews sit collapsed with Restore", async () => {
    const fake = admin({
      updateResource: (id, patch) => ok({ resource: resource({ id, ...(patch as object) }) }),
      reactivateResource: (id) => ok({ resource: resource({ id, name: "Old van", isActive: true }) }),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["crews"]} />);
    const crews = card(container, "crews");
    const pause = crews.querySelector<HTMLInputElement>('[data-crew="crew-a"] input[role="switch"]')!;
    expect(pause.checked).toBe(true);
    await click(pause);
    expect(fake.of("updateResource")[0]!.args).toEqual(["crew-a", { acceptsPublicBookings: false }]);
    expect(text(crews)).toContain("Online booking paused");
    const removed = crews.querySelector("details[data-aisw-removed]")!;
    expect(removed.hasAttribute("open")).toBe(false);
    expect(text(removed.querySelector("summary"))).toBe("Removed crews (1)");
    await click(button(removed, "Restore"));
    expect(fake.of("reactivateResource")[0]!.args).toEqual(["old"]);
    expect(crews.querySelector("details[data-aisw-removed]")).toBeNull();
    await unmount();
  });

  it("read-only: fields disabled and no save buttons", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} canManage={false} sections={["business", "messages"]} />);
    expect(text(container)).toContain("You can look, but not change these settings.");
    expect(button(container, "Save")).toBeNull();
    expect((labelled(container, "Business name") as HTMLInputElement).closest("fieldset")!.disabled).toBe(true);
    await unmount();
  });

  it("shows the booking page link with a copy button", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} bookingPageUrl="https://acme.test/book" sections={["messages"]} />);
    expect((container.querySelector("[data-aisw-copy] input") as HTMLInputElement).value).toBe("https://acme.test/book");
    expect(text(card(container, "messages"))).toContain("Release unanswered requests after (hours)");
    await unmount();
  });
});
