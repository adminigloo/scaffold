// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisitRequestBody, VisitRequestResponse } from "../types.js";
import { VisitPicker } from "../VisitPicker.js";
import { button, click, CONFIG, fail, fakePublic, labelled, mount, ok, publicVisit, settle, SLOTS, slotsResponse, submit, text, type } from "./fakes.js";

/**
 * <VisitPicker> driven like a customer: service, day, time, details, sent —
 * and every recovery the contract names (8.3): a time taken under them keeps
 * the form, a fast autofill waits out the fill-time floor instead of meeting
 * "spam", an address the map can't find lands on the address field.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const RESPONSE: VisitRequestResponse = {
  visit: publicVisit(),
  manageToken: "tok_abc",
  manageUrl: "https://acme.test/visit/tok_abc",
  repeated: false,
};

async function fillDetails(container: HTMLElement) {
  await type(labelled(container, "Your name"), "Jane Doe");
  await type(labelled(container, "Email"), "jane@example.com");
  await type(labelled(container, "Address for the visit"), "123 Main St, Salt Lake City");
  await type(labelled(container, "Anything we should know?"), "Side gate");
}

describe("<VisitPicker> booking flow", () => {
  it("books a visit end to end, in the business's time zone", async () => {
    const onRequested = vi.fn();
    const fake = fakePublic({
      config: () => ok(CONFIG),
      slots: () => ok(slotsResponse()),
      request: () => ok(RESPONSE),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} onRequested={onRequested} />);

    // Step 1: which service (there are two).
    expect(text(container)).toContain("What do you need?");
    await click(container.querySelector('[data-service="estimate"]'));
    expect(fake.of("slots")[0]!.args[0]).toEqual({ service: "estimate", days: 14 });

    // Step 2: day and time, with the zone said once.
    expect(text(container.querySelector("[data-aisw-zone]"))).toBe("Times are Mountain Time (MST)");
    expect([...container.querySelectorAll(".aisw-day")].map((d) => d.getAttribute("data-date"))).toEqual(["2026-11-02", "2026-11-03"]);
    expect([...container.querySelectorAll(".aisw-group-label")].map((g) => text(g))).toEqual(["Morning", "Afternoon"]);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));

    // Step 3: details. Focus moved to the step's heading.
    expect(document.activeElement?.textContent).toBe("Your details");
    expect(text(container.querySelector("[data-aisw-picked]"))).toContain("Monday, November 2, 9:00 – 10:00 AM MST");
    await fillDetails(container);
    await submit(container.querySelector("form[data-aisw-form]"));

    const body = fake.of("request")[0]!.args[0] as VisitRequestBody;
    expect(body).toMatchObject({
      slotId: "s-mon-0900",
      service: "estimate",
      name: "Jane Doe",
      email: "jane@example.com",
      address: "123 Main St, Salt Lake City",
      notes: "Side gate",
    });
    expect(body.website).toBeUndefined();
    expect(typeof body.fillMs).toBe("number");

    // Step 4: done, with plain-English next steps and the manage link.
    const done = text(container);
    expect(done).toContain("Request received");
    expect(done).toContain("Acme Windows will confirm it soon.");
    expect(done).toContain("What happens next");
    expect(done).toContain("You can change or cancel online up to 24 hours before the visit.");
    expect(done).toContain("We've emailed you a copy of your request with a link to change it.");
    expect(container.querySelector('a[href="https://acme.test/visit/tok_abc"]')).not.toBeNull();
    // BO-12: a REQUEST isn't on yet, so there's nothing to add to a calendar —
    // it may still be declined or lapse. The confirmation email carries them.
    expect(container.querySelector('a[href="https://acme.test/api/schedule/v1/visit/tok_abc/ics"]')).toBeNull();
    expect(container.querySelector('a[href^="https://calendar.google.com"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Request received");
    expect(onRequested).toHaveBeenCalledTimes(1);
    expect(onRequested).toHaveBeenCalledWith(RESPONSE);
    await unmount();
  });

  it("skips the service step for one service or a locked one, and never steals focus on load", async () => {
    const fake = fakePublic({ config: () => ok(CONFIG), slots: () => ok(slotsResponse()) });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} service="window-clean" lockService />);
    expect(text(container)).not.toContain("What do you need?");
    expect(button(container, "Change service")).toBeNull();
    expect(fake.of("slots")[0]!.args[0]).toEqual({ service: "window-clean", days: 14 });
    expect(document.activeElement).toBe(outside);
    await unmount();
  });

  it("'That time was just taken': back to the times, refetched, and the form kept", async () => {
    let first = true;
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }),
      slots: () => ok(slotsResponse()),
      request: () => {
        if (first) {
          first = false;
          return fail("slot_unavailable", "That time is taken.");
        }
        return ok(RESPONSE);
      },
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await fillDetails(container);
    await submit(container.querySelector("form[data-aisw-form]"));

    expect(text(container)).toContain("That time was just taken. Pick another.");
    expect(container.querySelector("form[data-aisw-form]")).toBeNull();
    expect(fake.of("slots")).toHaveLength(2);
    await click(container.querySelector('[data-slot="s-mon-1330"]'));
    expect((labelled(container, "Your name") as HTMLInputElement).value).toBe("Jane Doe");
    expect((labelled(container, "Address for the visit") as HTMLInputElement).value).toBe("123 Main St, Salt Lake City");
    await submit(container.querySelector("form[data-aisw-form]"));
    expect((fake.of("request")[1]!.args[0] as VisitRequestBody).slotId).toBe("s-mon-1330");
    expect(text(container)).toContain("Request received");
    await unmount();
  });

  it("waits out the server's fill-time floor instead of tripping the spam check", async () => {
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!], minFillMs: 400 }),
      slots: () => ok(slotsResponse()),
      request: () => ok(RESPONSE),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await fillDetails(container);
    const started = Date.now();
    await submit(container.querySelector("form[data-aisw-form]"));
    // Still inside the floor: nothing sent yet, and the button says so.
    expect(fake.of("request")).toHaveLength(0);
    expect(button(container, "Sending…")).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await settle();
    expect(fake.of("request")).toHaveLength(1);
    const body = fake.of("request")[0]!.args[0] as VisitRequestBody;
    expect(body.fillMs).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await unmount();
  });

  it("an address the map can't find lands on the address field", async () => {
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }),
      slots: () => ok(slotsResponse()),
      request: () => fail("address_unresolved", "We couldn't find that address."),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await fillDetails(container);
    await submit(container.querySelector("form[data-aisw-form]"));
    const address = labelled(container, "Address for the visit")!;
    expect(address.getAttribute("aria-invalid")).toBe("true");
    const errorId = address.getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!;
    expect(text(document.getElementById(errorId))).toBe(
      "We couldn't find that address on the map. Check the street, city and ZIP code. If it's right, send it anyway and we'll check it with you.",
    );
    expect(document.activeElement).toBe(address);
    expect(container.querySelector("form[data-aisw-form]")).not.toBeNull();
    await unmount();
  });

  it("checks the form before sending, and focuses the first problem", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }), slots: () => ok(slotsResponse()) });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await type(labelled(container, "Email"), "not-an-email");
    await submit(container.querySelector("form[data-aisw-form]"));
    expect(fake.of("request")).toHaveLength(0);
    expect(text(container)).toContain("Enter your name.");
    expect(text(container)).toContain("Enter an email address like you@example.com.");
    expect(text(container)).toContain("Enter the address where the visit is.");
    expect(document.activeElement).toBe(labelled(container, "Your name"));
    await unmount();
  });

  it("server issues map onto fields; spam, rate limits and network keep the form", async () => {
    const answers = [
      fail("invalid", "Check the form.", { status: 400, issues: [{ path: ["email"], message: "That email can't receive mail." }] }),
      fail("spam_suspected"),
      fail("too_many_requests"),
      fail("network"),
    ];
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }),
      slots: () => ok(slotsResponse()),
      request: () => answers.shift(),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await fillDetails(container);
    const form = () => container.querySelector("form[data-aisw-form]");
    await submit(form());
    expect(text(container)).toContain("That email can't receive mail.");
    expect(text(container)).toContain("Please check the highlighted fields.");
    await submit(form());
    expect(text(container)).toContain("That was quicker than a person can fill in the form.");
    await submit(form());
    expect(text(container)).toContain("You already have visits booked or waiting with us. Please call or email us to book another.");
    await submit(form());
    expect(text(container)).toContain("We couldn't connect.");
    expect((labelled(container, "Your name") as HTMLInputElement).value).toBe("Jane Doe");
    await unmount();
  });

  it("with email off, hands over the link to keep instead of promising an email", async () => {
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!], emailsEnabled: false, autoConfirm: true }),
      slots: () => ok(slotsResponse()),
      request: () => ok({ ...RESPONSE, visit: publicVisit({ status: "confirmed" }) }),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    expect(button(container, "Book this visit")).not.toBeNull();
    await fillDetails(container);
    await submit(container.querySelector("form[data-aisw-form]"));
    const done = text(container);
    expect(done).toContain("You're booked");
    expect(done).toContain("Keep this link to change or cancel your visit");
    expect(done).not.toMatch(/emailed/i);
    expect((container.querySelector("[data-aisw-copy] input") as HTMLInputElement).value).toBe("https://acme.test/visit/tok_abc");
    await unmount();
  });

  it("says online booking is closed, with the business's phone and email", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, publicBookingEnabled: false }) });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    expect(container.querySelector('[data-aisw-state="closed"]')).not.toBeNull();
    expect(text(container)).toContain("Online booking is closed right now.");
    expect(container.querySelector('a[href="tel:8015550143"]')).not.toBeNull();
    expect(container.querySelector('a[href="mailto:office@acme.test"]')).not.toBeNull();
    expect(fake.of("slots")).toHaveLength(0);
    await unmount();
  });

  it("no open times: says so for the window, with contacts, and offers to look further", async () => {
    const pages = [slotsResponse([], { from: "2026-10-30", to: "2026-11-12" }), slotsResponse([SLOTS[2]!], { from: "2026-11-13", to: "2026-11-26" })];
    const fake = fakePublic({
      // A year's horizon, so "later" exists whatever today's date is.
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!], horizonDays: 365 }),
      slots: () => ok(pages.shift()),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    expect(text(container)).toContain("No open times in the next 14 days.");
    expect(text(container)).toContain("Call (801) 555-0143");
    await click(button(container, "Look further ahead"));
    expect(fake.of("slots")[1]!.args[0]).toEqual({ service: "estimate", from: "2026-11-13", days: 14 });
    expect(container.querySelector('[data-slot="s-tue-1000"]')).not.toBeNull();
    await unmount();
  });

  it("the honeypot: named website, off-screen (not display:none), out of the tab order, hidden, never autofilled", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }), slots: () => ok(slotsResponse()) });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    const trap = container.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(trap.getAttribute("tabindex")).toBe("-1");
    expect(trap.getAttribute("autocomplete")).toBe("off");
    const wrapper = trap.closest(".aisw-hp")!;
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    // Hidden by the stylesheet's off-screen rule only: no inline display:none, no `hidden`.
    expect(wrapper.getAttribute("style")).toBeNull();
    expect(trap.getAttribute("style")).toBeNull();
    expect(trap.hasAttribute("hidden")).toBe(false);
    await unmount();
  });

  it("sends whatever filled the honeypot, so the server can refuse it", async () => {
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, services: [CONFIG.services[0]!] }),
      slots: () => ok(slotsResponse()),
      request: () => fail("spam_suspected"),
    });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    await click(container.querySelector('[data-slot="s-mon-0900"]'));
    await fillDetails(container);
    await type(container.querySelector('input[name="website"]'), "http://spam.example");
    await submit(container.querySelector("form[data-aisw-form]"));
    expect((fake.of("request")[0]!.args[0] as VisitRequestBody).website).toBe("http://spam.example");
    expect(text(container)).toContain("That was quicker than a person can fill in the form.");
    await unmount();
  });

  it("a config that fails offers to try again", async () => {
    let calls = 0;
    const fake = fakePublic({ config: () => (++calls === 1 ? fail("network") : ok(CONFIG)) });
    const { container, unmount } = await mount(<VisitPicker transport={fake.transport} />);
    expect(text(container)).toContain("We couldn't connect.");
    await click(button(container, "Try again"));
    expect(text(container)).toContain("What do you need?");
    await unmount();
  });
});
