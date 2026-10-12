// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { CrewDay } from "../admin/CrewDay.js";
import { button, choose, click, crewDay, fail, fakeAdmin, mount, ok, resource, snapshot, submit, text } from "./fakes.js";

/**
 * <CrewDay>, today's route on a phone (contract 8.6): stops in order with
 * directions and Call, drive times from the stop before, Start then Complete
 * (shown at once, put back with a message if the server says no), and a crew
 * picker when the server can't tell whose route it is.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<CrewDay>", () => {
  it("lists the stops in order with directions, Call, drive times and the route link", async () => {
    const fake = fakeAdmin({ crewDay: () => ok(crewDay()) });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} />);
    expect(fake.of("crewDay")[0]!.args[0]).toEqual({});
    expect(text(container)).toContain("Crew A");
    expect(text(container.querySelector("[data-aisw-totals]"))).toBe("2 stops · 30 min driving · times in MST");
    const stops = [...container.querySelectorAll("[data-stop-id]")];
    expect(stops.map((s) => s.getAttribute("data-stop-id"))).toEqual(["v1", "v2"]);
    expect(text(stops[0])).toContain("18 min drive · 9.2 mi from home base");
    expect(text(stops[1])).toContain("12 min drive · 4 mi from previous stop");
    expect(stops[0]!.querySelector('a[href^="https://www.google.com/maps/dir/"]')).not.toBeNull();
    expect(stops[0]!.querySelector('a[href="tel:+18015550100"]')).not.toBeNull();
    expect(stops[1]!.querySelector('a[href^="tel:"]')).toBeNull();
    expect(text(container.querySelector('a[href^="https://www.google.com/maps/dir/?api=1&origin"]'))).toContain("Open route in Maps");
    await unmount();
  });

  it("Start, then Complete, then 'Done' with the time", async () => {
    let current = snapshot({ id: "v1" });
    const fake = fakeAdmin({
      crewDay: () => ok(crewDay()),
      progress: (id, body) => {
        current = { ...current, status: body.status, ...(body.status === "completed" ? { completedAt: "2026-11-02T17:42:00.000Z" } : { startedAt: "2026-11-02T16:05:00.000Z" }) };
        return ok({ visit: current });
      },
    });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} />);
    const stop = () => container.querySelector('[data-stop-id="v1"]')!;
    await click(button(stop(), "Start"));
    expect(fake.of("progress")[0]!.args).toEqual(["v1", { status: "in_progress" }]);
    expect(stop().getAttribute("data-status")).toBe("in_progress");
    await click(button(stop(), "Complete"));
    expect(fake.of("progress")[1]!.args).toEqual(["v1", { status: "completed" }]);
    expect(text(stop().querySelector("[data-aisw-done]"))).toBe("Done 10:42 AM");
    expect(button(stop(), "Complete")).toBeNull();
    await unmount();
  });

  it("puts a stop back, with a message, when the server says no", async () => {
    const fake = fakeAdmin({
      crewDay: () => ok(crewDay()),
      progress: () => fail("transition_not_allowed", "This visit was cancelled by the office."),
    });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} />);
    const stop = () => container.querySelector('[data-stop-id="v1"]')!;
    await click(button(stop(), "Start"));
    expect(stop().getAttribute("data-status")).toBe("confirmed");
    expect(text(stop().querySelector('[role="alert"]'))).toBe("Not saved. This visit was cancelled by the office.");
    await unmount();
  });

  it("asks which crew when the server can't tell, then shows that crew's route", async () => {
    const fake = fakeAdmin({
      crewDay: (q) => (q.resource ? ok(crewDay({ resource: { id: q.resource, name: "Crew B", homeBaseAddress: null } })) : fail("invalid", "Pick a crew.", { status: 400 })),
      listResources: () => ok({ resources: [resource(), resource({ id: "crew-b", name: "Crew B" }), resource({ id: "old", name: "Old van", isActive: false })] }),
    });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} />);
    const picker = container.querySelector("[data-aisw-crew-pick]")!;
    expect(text(picker)).toContain("Pick a crew");
    const select = picker.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Crew A", "Crew B"]);
    await choose(select, "crew-b");
    await submit(picker);
    expect(fake.of("crewDay")[1]!.args[0]).toEqual({ resource: "crew-b" });
    expect(text(container)).toContain("Crew B");
    await unmount();
  });

  it("estimates are labelled as estimates; previous and next day move the date", async () => {
    const day = crewDay({
      totals: { visits: 1, driveMinutes: 100, distanceMiles: 40, estimated: true },
      stops: [{ ...crewDay().stops[0]!, driveFromPrevious: { minutes: 18, miles: 9.2, from: "home_base", estimated: true } }],
    });
    const fake = fakeAdmin({ crewDay: (q) => ok({ ...day, date: q.date ?? day.date }) });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} resourceId="crew-a" date="2026-11-02" />);
    expect(text(container.querySelector("[data-aisw-totals]"))).toContain("1 stop · 1 h 40 min driving (estimates)");
    expect(text(container)).toContain("about 18 min drive (estimate) · 9.2 mi from home base");
    await click(button(container, "Next day"));
    expect(fake.of("crewDay")[1]!.args[0]).toEqual({ date: "2026-11-03", resource: "crew-a" });
    await unmount();
  });
});
