// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { UsageMeter } from "../admin/UsageMeter.js";
import { formatBytes, usageNote, usageSentence } from "../admin/words.js";
import { mount, text } from "./dom.js";

/**
 * <UsageMeter> (section 7, review BO-07): each sentence, the platform's name
 * in the full one, and a real `role="meter"` in bytes.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("UsageMeter", () => {
  it("Using 120 MB of 5 GB, as a meter in bytes", async () => {
    const m = await mount(<UsageMeter usage={{ usedBytes: 120 * MB, fileCount: 40, allowanceBytes: 5 * GB }} locale="en-US" />);
    expect(text(m.container)).toBe("Using 120 MB of 5 GB");
    const meter = m.container.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe(String(120 * MB));
    expect(meter?.getAttribute("aria-valuemax")).toBe(String(5 * GB));
    expect(meter?.getAttribute("aria-valuemin")).toBe("0");
    expect(m.container.querySelector(".aifw-meter")?.getAttribute("data-tone")).toBe("ok");
    await m.unmount();
  });

  it("at 90 % or more: the warning tone and 'Almost full'", async () => {
    const m = await mount(<UsageMeter usage={{ usedBytes: 0.9 * GB, fileCount: 1, allowanceBytes: GB }} />);
    expect(m.container.querySelector(".aifw-meter")?.getAttribute("data-tone")).toBe("warn");
    expect(text(m.container)).toContain("Almost full: delete files you no longer need.");
    await m.unmount();
  });

  it("full: who to ask, with the platform's name; without it, just delete", () => {
    const full = { usedBytes: GB, fileCount: 1, allowanceBytes: GB };
    expect(usageNote(full, "Igloo Back Office")).toBe("Full: new files can't be added until you delete some, or ask Igloo Back Office for more room.");
    expect(usageNote(full)).toBe("Full: new files can't be added until you delete some.");
  });

  it("no allowance: 'Using 120 MB', no bar", async () => {
    const m = await mount(<UsageMeter usage={{ usedBytes: 120 * MB, fileCount: 3, allowanceBytes: null }} />);
    expect(text(m.container)).toBe("Using 120 MB");
    expect(m.container.querySelector('[role="meter"]')).toBeNull();
    await m.unmount();
    expect(usageSentence({ usedBytes: 0, fileCount: 0, allowanceBytes: null })).toBe("Using 0 bytes");
  });

  it("formatBytes matches the server's words", () => {
    expect(formatBytes(412 * 1024, "en-US")).toBe("412 KB");
    expect(formatBytes(Math.round(3.1 * MB), "en-US")).toBe("3.1 MB");
    expect(formatBytes(GB, "en-US")).toBe("1 GB");
  });
});
