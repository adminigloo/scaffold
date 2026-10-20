// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminNotices, Switch } from "../admin/ui.js";
import { EstimatesQueue } from "../admin/EstimatesQueue.js";
import { button, click, fakeAdmin, mount, ok, text } from "./fakes.js";

/**
 * The showroom pass (create-app 0.36): one calm setup card instead of a
 * stack of banners, the operator's jobs in plain words for an owner, switch
 * help that describes the state the switch is in, and an empty list that
 * says what it's for.
 */

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});

const NOTICES = [
  { code: "tax_default", message: "Your sales tax rate isn't saved yet. Enter it in Estimate settings." },
  { code: "emails_off", message: "Customers won't get emails: email sending isn't set up (RESEND_API_KEY)." },
  { code: "reading_off", message: "Photo reading is off: no AI key is connected (ANTHROPIC_API_KEY). Ask your developer to add it." },
];

describe("the setup card", () => {
  it("is one collapsed card that counts what's left, and opens to the list", async () => {
    const { container, unmount } = await mount(<AdminNotices notices={NOTICES} />);
    const card = container.querySelector("[data-aiew-notices]")!;
    expect(container.querySelectorAll("[data-aiew-notices]")).toHaveLength(1);
    expect(text(card.querySelector("button[aria-expanded]"))).toContain("3 things to finish");
    expect(card.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".aiew-setup-body")!.hasAttribute("hidden")).toBe(true);
    await click(card.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    expect(card.querySelector(".aiew-setup-body")!.hasAttribute("hidden")).toBe(false);
    expect(container.querySelectorAll("[data-notice]")).toHaveLength(3);
    await unmount();
  });

  it("tells an owner the operator's jobs in one plain sentence — never a setting's name", async () => {
    const { container, unmount } = await mount(<AdminNotices notices={NOTICES} />);
    const all = text(container);
    expect(all).toContain("Email isn't switched on for this site yet, so your customers won't get emails from it.");
    expect(all).toContain("Photo reading isn't switched on for this site yet");
    expect(all).toContain("Your sales tax rate isn't saved yet.");
    expect(all).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    expect(all).not.toContain("developer");
    await unmount();
  });

  it("shows staff the technical detail as well", async () => {
    const { container, unmount } = await mount(<AdminNotices notices={NOTICES} showTechnical />);
    expect(text(container)).toContain("RESEND_API_KEY");
    expect(text(container)).toContain("ANTHROPIC_API_KEY");
    await unmount();
  });

  it("dismisses until the list changes", async () => {
    const first = await mount(<AdminNotices notices={NOTICES} />);
    await click(button(first.container, "Dismiss until something changes"));
    expect(first.container.querySelector("[data-aiew-notices]")).toBeNull();
    await first.unmount();
    const same = await mount(<AdminNotices notices={NOTICES} />);
    expect(same.container.querySelector("[data-aiew-notices]")).toBeNull();
    await same.unmount();
    const changed = await mount(<AdminNotices notices={NOTICES.slice(0, 2)} />);
    expect(text(changed.container)).toContain("2 things to finish");
    await changed.unmount();
  });
});

describe("<Switch> help", () => {
  it("describes the state the switch is in", async () => {
    const hint = { on: "On: customers can pick it on your website.", off: "Off: only staff can put it on an estimate." };
    const on = await mount(<Switch checked onChange={() => {}} label="Show on your website" hint={hint} />);
    expect(text(on.container)).toContain(hint.on);
    expect(text(on.container)).not.toContain(hint.off);
    await on.unmount();
    const off = await mount(<Switch checked={false} onChange={() => {}} label="Show on your website" hint={hint} />);
    expect(text(off.container)).toContain(hint.off);
    expect(text(off.container)).not.toContain(hint.on);
    await off.unmount();
  });
});

describe("<EstimatesQueue> empty", () => {
  it("a new company's empty list says what it's for, links the estimate page, and drops its own heading on request", async () => {
    const zero = { leads: 0, drafts: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0, all: 0, archived: 0 };
    const fake = fakeAdmin({ listEstimates: () => ok({ estimates: [], nextCursor: null, counts: zero }) });
    const { container, unmount } = await mount(
      <EstimatesQueue transport={fake.transport} title={false} estimatePageUrl="https://example.test/t/acme/estimate" />,
    );
    expect(container.querySelector(".aiew-admin-title")).toBeNull();
    const empty = container.querySelector("[data-aiew-empty]")!;
    expect(text(empty)).toContain("No estimate requests yet");
    expect(empty.querySelector("a")!.getAttribute("href")).toBe("https://example.test/t/acme/estimate");
    await unmount();
  });
});
