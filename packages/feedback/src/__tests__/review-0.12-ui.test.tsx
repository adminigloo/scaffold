// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FeedbackAdminError } from "../board-client.js";
import { EpicDialog, FeedbackEpic, FeedbackEpics, type FeedbackEpicDetailWire, type FeedbackEpicsTransport } from "../epics.js";
import { button, choose, click, fake, field, mount, submit, text, type } from "./dom.js";

/**
 * The 0.12 review's screen findings:
 *
 *   M1  the edit dialog always sent the leader, so an epic led by someone who
 *       had left could never be saved — and showed them as a bare name
 *   L3  a refused status change left the page showing a status that was no
 *       longer true (the epic had changed under it)
 *   L6  after Delete, the list said nothing of what happened
 */

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

const PROGRESS = { total: 0, done: 0, inProgress: 0, waiting: 0, open: 0, percent: 0, allDone: false };

function detail(extra: Partial<FeedbackEpicDetailWire> = {}): FeedbackEpicDetailWire {
  return {
    id: "e1",
    name: "Checkout",
    description: null,
    status: "in_progress",
    ownerId: "u-cy",
    ownerName: "Cy",
    targetDate: null,
    color: "teal",
    completedAt: null,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    progress: PROGRESS,
    tickets: [],
    truncated: false,
    ...extra,
  };
}

describe("M1: editing an epic led by someone who has left", () => {
  it("shows them as no longer on the team, and saves the rest without sending the leader", async () => {
    const saved: unknown[] = [];
    const { container } = await mount(
      <EpicDialog
        epic={detail()}
        people={[
          { id: "u-ada", name: "Ada" },
          { id: "u-ben", name: "Ben" },
        ]}
        me="u-ada"
        onClose={() => undefined}
        onSave={async (input) => void saved.push(input)}
      />,
    );
    const owner = field<HTMLSelectElement>(container, "Who leads it")!;
    expect(owner.value).toBe("u-cy");
    expect([...owner.options].map((o) => o.textContent)).toEqual(["Nobody yet", "Cy (no longer on the team)", "Ada (you)", "Ben"]);
    await type(field(container, "Name"), "Checkout, phase two");
    await submit(container.querySelector("form"));
    expect(saved).toEqual([{ name: "Checkout, phase two", description: null, targetDate: null, color: "teal" }]);
  });

  it("sends the leader when it was changed (another person, or nobody)", async () => {
    const saved: Array<{ ownerId?: string | null }> = [];
    const { container } = await mount(
      <EpicDialog epic={detail()} people={[{ id: "u-ben", name: "Ben" }]} onClose={() => undefined} onSave={async (input) => void saved.push(input)} />,
    );
    await choose(field(container, "Who leads it"), "u-ben");
    await submit(container.querySelector("form"));
    await choose(field(container, "Who leads it"), "");
    await submit(container.querySelector("form"));
    expect(saved.map((input) => input.ownerId)).toEqual(["u-ben", null]);
  });
});

describe("L3: a refused change shows the epic as it is now", () => {
  it("reads the epic again after a refusal, so the status on screen is the true one", async () => {
    let current = detail({ status: "open", ownerId: null, ownerName: null });
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => current,
      setEpicStatus: () => {
        // Someone else archived it a moment ago.
        current = { ...current, status: "archived" };
        throw new FeedbackAdminError("Someone else just changed this epic. Refresh to see it as it is.", 409, "conflict");
      },
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" />);
    await choose(field(container, "Status"), "completed");
    expect(text(container.querySelector(".aib-notice"))).toContain("Someone else just changed this epic.");
    expect(text(container.querySelector(".aib-epic-title"))).toContain("Archived");
    expect(field<HTMLSelectElement>(container, "Status")!.value).toBe("archived");
    expect(transport.of("epic").length).toBeGreaterThanOrEqual(2);
  });
});

describe("L6: after Delete, the list says what happened", () => {
  it("Delete hands on how many tickets left the epic, and the list says they're still on the board", async () => {
    const left: number[] = [];
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => detail({ progress: { ...PROGRESS, total: 3 } }),
      deleteEpic: () => ({ deleted: true, detached: 3 }),
    });
    const page = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" onDeleted={(n) => void left.push(n)} />);
    await click(button(page.container, "Delete"));
    await click(button(page.container, "Delete it"));
    expect(left).toEqual([3]);
    await page.unmount();

    window.history.replaceState(null, "", "/app/feedback/epics?deleted=3");
    const list = fake<FeedbackEpicsTransport>({ epics: () => [] });
    const { container } = await mount(<FeedbackEpics transport={list.target} epicsHref="/app/feedback/epics" />);
    expect(text(container.querySelector(".aib-notice"))).toContain("Deleted. Its 3 tickets are still on the board.");
    // Said once: the address no longer carries it.
    expect(window.location.search).toBe("");
  });
});
