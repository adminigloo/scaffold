// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordFiles } from "../admin/RecordFiles.js";
import type { FileResponse } from "../types.js";
import { attachments, button, choose, click, fail, fakeTransport, fileWire, jpegFile, mount, ok, settle, text, viewport } from "./dom.js";

/**
 * <RecordFiles> (section 7): one record's photos and files. Thumbnails and
 * document rows (a HEIC as a row), the phone's two buttons, and NO LOST
 * PHOTO (review BO-05): a refused file keeps its card with Try again and
 * Save to phone while the others carry on, a network failure is retried once
 * by itself, and leaving the page asks first while anything is pending.
 */

const RECORD = { type: "scheduling.visit", id: "v1" };

beforeEach(() => {
  viewport(1280, false);
  if (typeof URL.createObjectURL !== "function") {
    let n = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  }
});
afterEach(() => {
  document.body.innerHTML = "";
});

const added = (name: string, id = `new-${name}`): FileResponse => ({ file: fileWire({ id, name }), usage: null });

describe("what is on the record", () => {
  it("photos as thumbnails, documents and a HEIC as rows, the record's label and the hint", async () => {
    const files = [
      fileWire({ id: "p1", name: "front porch.jpg" }),
      fileWire({ id: "d1", name: "quote.pdf", contentType: "application/pdf", kind: "document", url: "/c/d1", sizeBytes: 3.1 * 1024 * 1024 }),
      fileWire({ id: "h1", name: "IMG_0042.HEIC", contentType: "image/heic", kind: "document", url: "/c/h1" }),
    ];
    const { transport } = fakeTransport({ attachments: () => ok(attachments({ files })) });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} hint="Your team sees these; they aren't sent to the customer." backHref="/app/schedule" />);
    const card = m.container.querySelector("section");
    expect(text(card?.querySelector("h2"))).toBe("Photos and files");
    expect(text(card)).toContain("Visit · Pat Rivera · Tue, Nov 3, 9:00 AM");
    expect(text(card)).toContain("Your team sees these; they aren't sent to the customer.");
    const imgs = [...m.container.querySelectorAll("img")];
    expect(imgs.map((i) => [i.getAttribute("alt"), i.getAttribute("loading"), i.getAttribute("src")])).toEqual([
      ["front porch.jpg", "lazy", "/api/app/c1/files/v1/admin/files/f1/content"],
    ]);
    const rows = [...m.container.querySelectorAll(".aifw-doc")].map((r) => text(r));
    expect(rows[0]).toContain("quote.pdf");
    expect(rows[0]).toContain("PDF · 3.1 MB");
    expect(rows[1]).toContain("IMG_0042.HEIC");
    expect(rows[1]).toContain("iPhone photo (HEIC)");
    for (const a of m.container.querySelectorAll("a.aifw-thumb-link, a.aifw-doc-name")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(m.container.querySelector('a[href="/app/schedule"]')?.textContent).toBe("Back");
    await m.unmount();
  });

  it("a desktop gets one button and a drop zone; a phone gets 'Take a photo' with the camera too", async () => {
    const { transport } = fakeTransport({ attachments: () => ok(attachments()) });
    const desk = await mount(<RecordFiles transport={transport} record={RECORD} />);
    expect(button(desk.container, "Take a photo")).toBeNull();
    expect(button(desk.container, "Add photos or files")).not.toBeNull();
    expect(text(desk.container)).toContain("Or drop photos and files here.");
    expect(desk.container.querySelector('[data-aifw-input="camera"]')).toBeNull();
    await desk.unmount();

    viewport(390, true);
    const phone = await mount(<RecordFiles transport={transport} record={RECORD} />);
    expect(button(phone.container, "Take a photo")).not.toBeNull();
    expect(button(phone.container, "Add photos or files")).not.toBeNull();
    const camera = phone.container.querySelector('[data-aifw-input="camera"]');
    expect(camera?.getAttribute("capture")).toBe("environment");
    expect(camera?.getAttribute("accept")).toBe("image/*");
    const files = phone.container.querySelector('[data-aifw-input="files"]');
    expect(files?.hasAttribute("multiple")).toBe(true);
    expect(files?.getAttribute("accept")).toContain("application/pdf");
    await phone.unmount();
  });

  it("uploads off: the reason, and no buttons", async () => {
    const { transport } = fakeTransport({
      attachments: () => ok(attachments({ uploads: { available: false, offReason: "File storage isn't switched on yet, so files can't be kept.", maxBytes: 0, accept: [], rule: "" } })),
    });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} />);
    expect(text(m.container)).toContain("File storage isn't switched on yet, so files can't be kept.");
    expect(button(m.container, "Add photos or files")).toBeNull();
    await m.unmount();
  });

  it("not found: 'These files aren't available to you.'; a network failure has Retry", async () => {
    const missing = fakeTransport({ attachments: () => fail("not_found", "That isn't here.") });
    const m = await mount(<RecordFiles transport={missing.transport} record={RECORD} />);
    expect(text(m.container)).toContain("These files aren't available to you.");
    await m.unmount();

    let answers = 0;
    const flaky = fakeTransport({ attachments: () => ((answers += 1) === 1 ? fail("network", "Couldn't reach the server.") : ok(attachments())) });
    const n = await mount(<RecordFiles transport={flaky.transport} record={RECORD} />);
    expect(text(n.container)).toContain("Couldn't reach the server.");
    await click(button(n.container, "Retry"));
    expect(text(n.container)).toContain("Visit · Pat Rivera");
    expect(flaky.of("attachments")).toHaveLength(2);
    await n.unmount();
  });
});

describe("adding: no lost photo (review BO-05)", () => {
  it("a refused file keeps its card (Try again, Save to phone) while the next one goes in; Try again succeeds", async () => {
    const answers = [fail("file_type", "That kind of file can't be kept here."), ok(added("second.jpg")), ok(added("first.jpg"))];
    const { transport, of } = fakeTransport({ attachments: () => ok(attachments()), attach: () => answers.shift() });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} />);
    const input = m.container.querySelector('[data-aifw-input="files"]');
    await choose(input, [jpegFile("first.jpg"), jpegFile("second.jpg")]);
    await settle();
    expect(of("attach").map((c) => c.args[2])).toEqual(["first.jpg", "second.jpg"]);
    expect(of("attach")[0]?.args[0]).toEqual(RECORD);
    const failed = m.container.querySelector('[data-aifw-pending="failed"]');
    expect(text(failed)).toContain("first.jpg");
    expect(text(failed)).toContain("That kind of file can't be kept here.");
    const save = [...(failed?.querySelectorAll("a") ?? [])].find((a) => text(a) === "Save to phone");
    expect(save?.getAttribute("download")).toBe("first.jpg");
    expect(save?.getAttribute("href")).toMatch(/^blob:/);
    // The other file carried on: the last outcome announced is its.
    expect(text(m.container.querySelector('[role="status"]'))).toBe("Added second.jpg.");
    // While a file has failed, leaving the page asks first.
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    await click(button(failed as Element, "Try again"));
    await settle();
    expect(of("attach")).toHaveLength(3);
    expect(m.container.querySelector("[data-aifw-pending]")).toBeNull();
    expect(text(m.container.querySelector('[role="status"]'))).toBe("Added first.jpg.");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    await m.unmount();
  });

  it("a network failure is sent again by itself once, after the delay", async () => {
    const answers = [fail("network", "Couldn't reach the server."), ok(added("porch.jpg"))];
    const { transport, of } = fakeTransport({ attachments: () => ok(attachments()), attach: () => answers.shift() });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} retryDelayMs={300} />);
    await choose(m.container.querySelector('[data-aifw-input="files"]'), [jpegFile("porch.jpg")]);
    // Still pending, no card yet: it is waiting to try again.
    expect(m.container.querySelector('[data-aifw-pending="failed"]')).toBeNull();
    expect(m.container.querySelector('[data-aifw-pending="working"]')).not.toBeNull();
    expect(of("attach")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect(of("attach")).toHaveLength(2);
    expect(m.container.querySelector("[data-aifw-pending]")).toBeNull();
    await m.unmount();
  });

  it("two network failures in a row: the card says to check the signal", async () => {
    const { transport, of } = fakeTransport({ attachments: () => ok(attachments()), attach: () => fail("network", "Couldn't reach the server.") });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} retryDelayMs={10} />);
    await choose(m.container.querySelector('[data-aifw-input="files"]'), [jpegFile("porch.jpg")]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();
    expect(of("attach")).toHaveLength(2);
    expect(text(m.container.querySelector('[data-aifw-pending="failed"]'))).toContain("It didn't send. Check your signal.");
    await m.unmount();
  });

  it("a refusal as too big is tried again smaller", async () => {
    const answers = [fail("file_too_big", "That file is too big. Files can be up to 4 MB."), ok(added("big.jpg"))];
    const drawn: number[] = [];
    const encoder = {
      measure: async () => ({ width: 4000, height: 3000 }),
      toJpeg: async (_f: Blob, width: number) => {
        drawn.push(width);
        return new Blob([new Uint8Array(10)], { type: "image/jpeg" });
      },
    };
    const { transport } = fakeTransport({ attachments: () => ok(attachments()), attach: () => answers.shift() });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} photoEncoder={encoder} />);
    await choose(m.container.querySelector('[data-aifw-input="files"]'), [jpegFile("big.jpg", 5_000_000)]);
    await click(button(m.container, "Try again"));
    await settle();
    expect(drawn).toEqual([2048, 1600]);
    await m.unmount();
  });
});

describe("remove and copy a link", () => {
  it("Remove asks first, then removes", async () => {
    const { transport, of } = fakeTransport({
      attachments: () => ok(attachments({ files: [fileWire({ id: "p1", name: "front porch.jpg" })] })),
      remove: () => ok({ removed: true, usage: null }),
    });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} />);
    await click(button(m.container, "Remove front porch.jpg"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(text(dialog)).toContain("Remove front porch.jpg? It's deleted for good.");
    expect(of("remove")).toHaveLength(0);
    await click(button(dialog as Element, "Remove"));
    expect(of("remove").map((c) => c.args[0])).toEqual(["p1"]);
    expect(m.container.querySelector("img")).toBeNull();
    expect(text(m.container.querySelector('[role="status"]'))).toBe("Removed front porch.jpg.");
    await m.unmount();
  });

  it("Copy a link puts a one-hour link on the clipboard (or shows it to copy by hand)", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    const { transport } = fakeTransport({
      attachments: () => ok(attachments({ files: [fileWire({ id: "p1" }), fileWire({ id: "p2", name: "no-link.jpg", canLink: false, canRemove: false })] })),
      link: () => ok({ url: "https://app.test/api/files/v1/f/v1.abc.def", expiresAt: "2026-10-15T13:00:00.000Z" }),
    });
    const m = await mount(<RecordFiles transport={transport} record={RECORD} />);
    const links = [...m.container.querySelectorAll("button")].filter((b) => text(b) === "Copy a link (works for 1 hour)");
    expect(links).toHaveLength(1);
    await click(links[0]);
    expect(copied).toEqual(["https://app.test/api/files/v1/f/v1.abc.def"]);
    expect(text(m.container.querySelector('[role="status"]'))).toBe("Link copied. It works for 1 hour.");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await click(links[0]);
    expect((document.querySelector("#aifw-link-box") as HTMLInputElement | null)?.value).toBe("https://app.test/api/files/v1/f/v1.abc.def");
    await m.unmount();
  });
});
