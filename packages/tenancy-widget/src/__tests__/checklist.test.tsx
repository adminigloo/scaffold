// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupChecklist } from "../SetupChecklist.js";
import { button, checklist, click, fail, fakeTenancy, mount, ok, settle, text } from "./fakes.js";

/**
 * <SetupChecklist> (contract 8.5): "{done} of {total} done" on a native
 * progress bar, each item with its action link until done, "Not needed" to
 * skip one, "Hide this list" only up front once everything is done or
 * skipped, nothing at all when hidden or empty, and a fresh copy whenever the
 * tab comes back into view.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const T = "t-summit";

describe("<SetupChecklist>", () => {
  it("shows progress as words and a native bar, and each to-do with its link", async () => {
    const f = fakeTenancy({});
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={checklist({ done: 1, items: checklist().items.map((i, n) => (n === 0 ? { ...i, done: true } : i)) })} />);
    expect(f.calls).toHaveLength(0);
    expect(text(container.querySelector("h2"))).toBe("Finish setting up");
    const progress = container.querySelector("progress")!;
    expect(progress.getAttribute("value")).toBe("1");
    expect(progress.getAttribute("max")).toBe("3");
    expect(text(container.querySelector(`label[for="${progress.id}"]`))).toBe("1 of 3 done");
    const details = container.querySelector('[data-item="company.details"]')!;
    expect(details.hasAttribute("data-done")).toBe(true);
    expect(details.querySelector("a")).toBeNull(); // done: no link
    const team = container.querySelector('[data-item="team.invite"]')!;
    expect(team.querySelector("a")!.getAttribute("href")).toBe("/settings/team");
    expect(text(team.querySelector("a"))).toBe("Invite people");
    await unmount();
  });

  it("'Not needed' skips an item and refreshes from the answer", async () => {
    const skipped = checklist({ items: checklist().items.map((i) => (i.key === "company.branding" ? { ...i, dismissed: true } : i)) });
    const f = fakeTenancy({ dismissChecklistItem: () => ok(skipped) });
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={checklist()} />);
    const item = container.querySelector('[data-item="company.branding"]')!;
    await click(button(item, "Not needed"));
    expect(f.of("dismissChecklistItem").map((c) => c.args)).toEqual([[T, "company.branding"]]);
    const after = container.querySelector('[data-item="company.branding"]')!;
    expect(after.hasAttribute("data-dismissed")).toBe(true);
    expect(text(after)).toContain("Skipped");
    expect(button(after, "Not needed")).toBeNull();
    expect(text(container.querySelector('[role="status"]'))).toContain("marked as not needed");
    await unmount();
  });

  it("'Hide this list' waits behind 'More' until complete, then sits beside 'You're all set.'", async () => {
    const open = await mount(<SetupChecklist transport={fakeTenancy({}).transport} tenantId={T} initial={checklist()} />);
    const details = open.container.querySelector("details")!;
    expect(text(details.querySelector("summary"))).toBe("More");
    expect(details.contains(button(open.container, "Hide this list"))).toBe(true);
    expect(text(open.container)).not.toContain("You're all set.");
    await open.unmount();

    const complete = checklist({ done: 3, complete: true, items: checklist().items.map((i) => ({ ...i, done: true })) });
    const f = fakeTenancy({ hideChecklist: () => ok({ ...complete, hidden: true }) });
    const done = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={complete} />);
    expect(text(done.container)).toContain("You're all set.");
    expect(done.container.querySelector("details")).toBeNull();
    await click(button(done.container, "Hide this list"));
    expect(f.of("hideChecklist")).toHaveLength(1);
    // Hidden leaves only the quiet way back (review T1-13), no list.
    expect(done.container.querySelector("section")).toBeNull();
    expect(button(done.container, "Show the setup list")).not.toBeNull();
    await done.unmount();
  });

  it("when hidden shows only 'Show the setup list' (review T1-13); renders nothing when this person can do none of the items", async () => {
    const f = fakeTenancy({ showChecklist: () => ok(checklist()) });
    const hidden = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={checklist({ hidden: true })} />);
    expect(hidden.container.querySelector("section")).toBeNull();
    await click(button(hidden.container, "Show the setup list"));
    expect(f.of("showChecklist").map((c) => c.args)).toEqual([[T]]);
    expect(hidden.container.querySelector("section")).not.toBeNull();
    await hidden.unmount();
    const empty = await mount(<SetupChecklist transport={fakeTenancy({}).transport} tenantId={T} initial={checklist({ items: [], total: 0 })} />);
    expect(empty.container.innerHTML).toBe("");
    await empty.unmount();
  });

  it("a skipped item can be brought back with Undo (review T1-13)", async () => {
    const skipped = checklist({ items: checklist().items.map((i) => (i.key === "team.invite" ? { ...i, dismissed: true } : i)) });
    const f = fakeTenancy({ restoreChecklistItem: () => ok(checklist()) });
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={skipped} />);
    const row = container.querySelector('[data-item="team.invite"]')!;
    expect(text(row)).toContain("Skipped");
    await click(button(row, "Undo"));
    expect(f.of("restoreChecklistItem").map((c) => c.args)).toEqual([[T, "team.invite"]]);
    expect(text(container.querySelector('[data-item="team.invite"]'))).not.toContain("Skipped");
    expect(text(container.querySelector('[role="status"]'))).toContain("is back on the list");
    await unmount();
  });

  it("asks again when the tab comes back into view", async () => {
    let done = 0;
    const f = fakeTenancy({ checklist: () => ok(checklist({ done: ++done })) });
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} />);
    expect(f.of("checklist")).toHaveLength(1);
    expect(text(container)).toContain("1 of 3 done");
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(f.of("checklist")).toHaveLength(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(f.of("checklist")).toHaveLength(2);
    expect(text(container)).toContain("2 of 3 done");
    await unmount();
  });

  it("a failed skip is an alert, in plain words", async () => {
    const f = fakeTenancy({ dismissChecklistItem: () => fail("forbidden", "You don't have access to do that here. Ask the owner of this company to change your role.") });
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={checklist()} />);
    await click(button(container.querySelector('[data-item="team.invite"]')!, "Not needed"));
    expect(text(container.querySelector('[role="alert"]'))).toContain("Ask the owner of this company");
    await unmount();
  });
});

describe("<SetupChecklist compact> (the dashboard's, create-app 0.36)", () => {
  it("lists what's left in full and folds what's done into one line", async () => {
    const f = fakeTenancy({});
    const initial = checklist({ done: 1, items: checklist().items.map((i, n) => (n === 0 ? { ...i, done: true } : i)) });
    const { container, unmount } = await mount(<SetupChecklist transport={f.transport} tenantId={T} initial={initial} compact />);
    const open = container.querySelectorAll(".aitw-items > [data-item]");
    expect(open).toHaveLength(2);
    expect(container.querySelector('.aitw-items > [data-item="company.details"]')).toBeNull();
    const folded = container.querySelector("[data-aitw-folded]")!;
    expect(text(folded.querySelector("summary"))).toBe("1 done or skipped");
    expect(folded.querySelector('[data-item="company.details"]')).not.toBeNull();
    await unmount();
  });
});

describe("helpForState", () => {
  it("shows only the half of an On/Off help that is true now", async () => {
    const { helpForState } = await import("../CompanySettings.js");
    const help = "Off: they pay the deposit, then the whole balance. On: they can choose how much to pay each time.";
    expect(helpForState(help, true)).toBe("On: they can choose how much to pay each time.");
    expect(helpForState(help, false)).toBe("Off: they pay the deposit, then the whole balance.");
    // Negative control: help without both halves is shown as written.
    expect(helpForState("Shown on every invoice.", true)).toBe("Shown on every invoice.");
  });
});
