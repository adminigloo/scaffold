// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parseVisitSnapshot } from "../admin/client.js";
import { VisitPanel } from "../admin/VisitPanel.js";
import { fakeAdmin, mount, snapshot, text } from "./fakes.js";

/**
 * scheduling 0.7, past records: a visit typed in later from the business's
 * records says so in its panel ("Entered from past records on …"), the way an
 * estimate's timeline does. Review: only created_at knew.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function panel(visit: ReturnType<typeof snapshot>) {
  return (
    <VisitPanel
      visit={visit}
      transport={fakeAdmin({}).transport}
      resources={[]}
      services={null}
      slotStepMinutes={30}
      canManage
      locale="en-US"
      nowMs={Date.parse("2026-10-20T15:00:00.000Z")}
      onClose={() => {}}
      onChanged={() => {}}
      returnFocus={() => null}
    />
  );
}

describe("entered from past records", () => {
  it("a visit entered later says so, on the company's calendar day", async () => {
    // 01:00Z on the 21st is still the 20th in Denver.
    const { container, unmount } = await mount(panel(snapshot({ status: "completed", enteredLater: { at: "2026-10-21T01:00:00.000Z", by: "u-sam" } })));
    expect(text(container.querySelector("[data-aisw-entered-later]"))).toMatch(/^Entered from past records on .*Oct 20/);
    await unmount();
  });

  it("NEGATIVE CONTROL: a visit booked the day it was says nothing of it", async () => {
    const { container, unmount } = await mount(panel(snapshot({ status: "confirmed" })));
    expect(text(container)).toContain("Booked online");
    expect(container.querySelector("[data-aisw-entered-later]")).toBeNull();
    await unmount();
  });

  it("the parser keeps enteredLater and drops a malformed one", () => {
    const wire = JSON.parse(JSON.stringify(snapshot({ enteredLater: { at: "2026-10-20T15:00:00.000Z", by: "u-sam" } })));
    expect(parseVisitSnapshot(wire)!.enteredLater).toEqual({ at: "2026-10-20T15:00:00.000Z", by: "u-sam" });
    expect(parseVisitSnapshot({ ...wire, enteredLater: { at: 5 } })!.enteredLater).toBeNull();
  });
});
