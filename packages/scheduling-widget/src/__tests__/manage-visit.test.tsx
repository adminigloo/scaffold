// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageVisit } from "../ManageVisit.js";
import type { PublicVisitStatus } from "../types.js";
import { button, click, CONFIG, fail, fakePublic, labelled, mount, ok, publicVisit, slotsResponse, text, type } from "./fakes.js";

/**
 * <ManageVisit>, the page behind the email link (contract 8.4): every status
 * in plain words, reschedule asked AS the visit (`manage: token`), cancel with
 * an in-page confirmation, and the cutoff — online changes stop and the
 * business's phone number is given instead.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const FAR = { changeDeadline: new Date(Date.now() + 5 * 86_400_000).toISOString() };

describe("<ManageVisit>", () => {
  it("shows the visit, and reschedules with slots asked as the visit", async () => {
    const onChange = vi.fn();
    const moved = publicVisit({ ...FAR, status: "confirmed", date: "2026-11-03", startTime: "10:00", endTime: "11:00", startsAt: "2026-11-03T17:00:00.000Z", endsAt: "2026-11-03T18:00:00.000Z" });
    const fake = fakePublic({
      visit: () => ok({ visit: publicVisit({ ...FAR, status: "confirmed" }) }),
      config: () => ok(CONFIG),
      slots: () => ok(slotsResponse()),
      reschedule: () => ok({ visit: moved }),
    });
    const { container, unmount } = await mount(<ManageVisit token="tok_1" transport={fake.transport} onChange={onChange} />);
    expect(text(container.querySelector("[data-aisw-status]"))).toBe("Confirmed");
    expect(text(container)).toContain("Your free estimate");
    expect(text(container)).toContain("Monday, November 2, 9:00 – 10:00 AM MST");
    expect(container.querySelector('a[href="https://acme.test/api/schedule/v1/visit/tok_1/ics"]')).not.toBeNull();

    await click(button(container, "Pick another time"));
    expect(fake.of("slots")[0]!.args[0]).toEqual({ manage: "tok_1", days: 14 });
    // The visit's own time isn't offered back to it.
    expect(container.querySelector('[data-slot="s-mon-0900"]')).toBeNull();
    await click(container.querySelector('.aisw-day[data-date="2026-11-03"]'));
    await click(container.querySelector('[data-slot="s-tue-1000"]'));
    expect(text(container.querySelector("[data-aisw-confirm-move] h3"))).toBe("Move to Tue, Nov 3, 10:00 AM?");
    await click(button(container, "Yes, move it"));
    expect(fake.of("reschedule")[0]!.args).toEqual(["tok_1", { slotId: "s-tue-1000" }]);
    expect(text(container)).toContain("Moved to Tuesday, November 3, 10:00 – 11:00 AM MST. We've emailed you the new time.");
    expect(onChange).toHaveBeenCalledWith(moved);
    await unmount();
  });

  it("a time taken while rescheduling: refetched, still in the picker", async () => {
    const fake = fakePublic({
      visit: () => ok({ visit: publicVisit({ ...FAR }) }),
      config: () => ok(CONFIG),
      slots: () => ok(slotsResponse()),
      reschedule: () => fail("slot_unavailable"),
    });
    const { container, unmount } = await mount(<ManageVisit token="tok_1" transport={fake.transport} />);
    await click(button(container, "Pick another time"));
    await click(container.querySelector('.aisw-day[data-date="2026-11-03"]'));
    await click(container.querySelector('[data-slot="s-tue-1000"]'));
    await click(button(container, "Yes, move it"));
    expect(text(container)).toContain("That time was just taken. Pick another.");
    expect(container.querySelector(".aisw-times")).not.toBeNull();
    expect(fake.of("slots")).toHaveLength(2);
    await unmount();
  });

  it("cancels after an in-page confirmation, with an optional reason", async () => {
    const fake = fakePublic({
      visit: () => ok({ visit: publicVisit({ ...FAR, status: "confirmed" }) }),
      config: () => ok(CONFIG),
      cancel: () => ok({ visit: publicVisit({ status: "cancelled", cancelledBy: "customer", canCancel: false, canReschedule: false, changeDeadline: null, googleCalendarUrl: null }) }),
    });
    const { container, unmount } = await mount(<ManageVisit token="tok_1" transport={fake.transport} bookHref="/book" />);
    await click(button(container, "Cancel visit"));
    expect(document.activeElement?.textContent).toBe("Cancel this visit?");
    await type(labelled(container, "Anything you'd like"), "Moving house");
    await click(button(container, "Yes, cancel it"));
    expect(fake.of("cancel")[0]!.args).toEqual(["tok_1", { reason: "Moving house" }]);
    expect(text(container)).toContain("Your visit is cancelled. We've emailed you to confirm.");
    expect(text(container)).toContain("You cancelled this visit.");
    expect(container.querySelector('a[href="/book"]')).not.toBeNull();
    expect(button(container, "Pick another time")).toBeNull();
    await unmount();
  });

  it("past the cutoff the actions give way to one sentence and the phone number", async () => {
    const fake = fakePublic({
      visit: () => ok({ visit: publicVisit({ status: "confirmed", canCancel: false, canReschedule: false, changeDeadline: new Date(Date.now() - 60_000).toISOString() }) }),
      config: () => ok(CONFIG),
    });
    const { container, unmount } = await mount(<ManageVisit token="tok_1" transport={fake.transport} />);
    expect(text(container.querySelector("[data-aisw-cutoff]"))).toBe(
      "This visit starts within 24 hours, so it can't be changed online. Call (801) 555-0143.",
    );
    expect(button(container, "Pick another time")).toBeNull();
    expect(button(container, "Cancel visit")).toBeNull();
    await unmount();
  });

  it("a too_late from the server shows the cutoff message and reloads the visit", async () => {
    let loads = 0;
    const fake = fakePublic({
      visit: () =>
        ok({
          visit:
            ++loads === 1
              ? publicVisit({ ...FAR, status: "confirmed" })
              : publicVisit({ status: "confirmed", canCancel: false, canReschedule: false, changeDeadline: new Date(Date.now() - 1000).toISOString() }),
        }),
      config: () => ok(CONFIG),
      cancel: () => fail("too_late", "This visit starts within 24 hours…"),
    });
    const { container, unmount } = await mount(<ManageVisit token="tok_1" transport={fake.transport} />);
    await click(button(container, "Cancel visit"));
    await click(button(container, "Yes, cancel it"));
    expect(fake.of("visit")).toHaveLength(2);
    expect(text(container)).toContain("This visit starts within 24 hours, so it can't be changed online. Call (801) 555-0143.");
    expect(button(container, "Yes, cancel it")).toBeNull();
    await unmount();
  });

  it("a link that opens nothing says so, with a way to book again", async () => {
    const fake = fakePublic({ visit: () => fail("not_found"), config: () => ok(CONFIG) });
    const { container, unmount } = await mount(<ManageVisit token="bogus" transport={fake.transport} bookHref="/book" />);
    expect(text(container)).toContain("This link doesn't open a visit.");
    expect(container.querySelector('a[href="/book"]')?.textContent).toBe("Book a new time");
    await unmount();
  });

  it("names every status in plain words", async () => {
    const cases: Array<[PublicVisitStatus, string]> = [
      ["requested", "Waiting for Acme Windows to confirm"],
      ["confirmed", "Confirmed"],
      ["in_progress", "In progress"],
      ["completed", "Done"],
      ["cancelled", "Cancelled"],
      ["declined", "Acme Windows couldn't make this time"],
      ["expired", "Not confirmed in time"],
      ["missed", "Didn't happen"],
    ];
    for (const [status, label] of cases) {
      const fake = fakePublic({ visit: () => ok({ visit: publicVisit({ ...FAR, status }) }), config: () => ok(CONFIG) });
      const { container, unmount } = await mount(<ManageVisit token="t" transport={fake.transport} />);
      expect(text(container.querySelector("[data-aisw-status]")), status).toBe(label);
      await unmount();
    }
  });

  it("a requested visit says who still has to confirm, and only promises email when there is email", async () => {
    for (const emailsEnabled of [true, false]) {
      const fake = fakePublic({ visit: () => ok({ visit: publicVisit({ ...FAR }) }), config: () => ok({ ...CONFIG, emailsEnabled }) });
      const { container, unmount } = await mount(<ManageVisit token="t" transport={fake.transport} />);
      const words = text(container);
      expect(words).toContain("Acme Windows still has to confirm this time.");
      if (emailsEnabled) expect(words).toContain("You'll get an email when they do.");
      else expect(words).toContain("This page shows it as soon as they do.");
      await unmount();
    }
  });
});
