// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesManager } from "../admin/FilesManager.js";
import { button, choose, click, fakeTransport, fileWire, jpegFile, list, mount, ok, settle, text, usage, viewport } from "./dom.js";

/**
 * <FilesManager> (section 7): the company Files screen. The usage at the
 * top, filters as an owner thinks (review BO-22), Largest first, a table and
 * cards, Load more, the not-removable hint, and the empty state.
 */

beforeEach(() => viewport(1280, false));
afterEach(() => {
  document.body.innerHTML = "";
});

const FILES = [
  fileWire({ id: "f1", name: "front porch.jpg" }),
  fileWire({
    id: "logo",
    name: "Company logo 2026-10-15.png",
    contentType: "image/png",
    purpose: "company.logo",
    purposeLabel: "Company logo",
    record: null,
    canRemove: false,
    canLink: false,
    url: "https://app.test/api/files/v1/p/abc.png",
  }),
  fileWire({
    id: "photo",
    name: "estimate-photo.jpg",
    purpose: "estimator.photo",
    purposeLabel: "Estimate photo",
    record: { type: "estimator.estimate", label: "Estimate 1042 · Pat Rivera", href: "/app/estimates/e1" },
    canRemove: false,
  }),
];

const FULL = list({
  files: FILES,
  recordTypes: [
    { type: "scheduling.visit", label: "Visits" },
    { type: "invoicing.invoice", label: "Invoices" },
  ],
  purposes: [
    { key: "attachment", label: "Photo or file" },
    { key: "company.logo", label: "Company logo" },
    { key: "library", label: "Company file" },
  ],
});

describe("FilesManager", () => {
  it("shows the usage, the files in a table and as cards, attached-to as a link", async () => {
    const { transport } = fakeTransport({ files: () => ok(FULL) });
    const m = await mount(<FilesManager transport={transport} platformName="Igloo Back Office" />);
    expect(text(m.container)).toContain("Using 120 MB of 5 GB");
    expect(m.container.querySelector('[role="meter"]')).not.toBeNull();
    expect([...m.container.querySelectorAll("tr[data-aifw-file]")].map((r) => r.getAttribute("data-aifw-file"))).toEqual(["f1", "logo", "photo"]);
    expect([...m.container.querySelectorAll("[data-aifw-card]")]).toHaveLength(3);
    const row = m.container.querySelector('tr[data-aifw-file="f1"]');
    expect(text(row)).toContain("Visit · Pat Rivera · Tue, Nov 3, 9:00 AM");
    expect(row?.querySelector('a[href="/app/schedule?visit=v1"]')).not.toBeNull();
    expect(text(row)).toContain("412 KB");
    expect(text(row)).toContain("Ana");
    await m.unmount();
  });

  it("filters: All, each record type, Not attached, and Logo; a sort by size", async () => {
    const { transport, of } = fakeTransport({ files: () => ok(FULL) });
    const m = await mount(<FilesManager transport={transport} />);
    const chips = [...m.container.querySelectorAll(".aifw-chip")].map((c) => text(c));
    expect(chips).toEqual(["All", "Visits", "Invoices", "Not attached", "Logo"]);
    expect(m.container.querySelector('.aifw-chip[aria-pressed="true"]')?.textContent).toBe("All");
    await click(button(m.container, "Visits"));
    await click(button(m.container, "Not attached"));
    await click(button(m.container, "Logo"));
    const select = m.container.querySelector("select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "size");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(of("files").map((c) => c.args[0])).toEqual([
      { sort: "newest" },
      { record: "scheduling.visit", sort: "newest" },
      { record: "none", sort: "newest" },
      { purpose: "company.logo", sort: "newest" },
      { purpose: "company.logo", sort: "size" },
    ]);
    expect(text(m.container.querySelector('.aifw-chip[aria-pressed="true"]'))).toBe("Logo");
    await m.unmount();
  });

  it("a file removed where it's used says where, instead of a Remove button", async () => {
    const { transport } = fakeTransport({ files: () => ok(FULL) });
    // The template names its page (review FH-11: without logoSettings the hint names none).
    const m = await mount(<FilesManager transport={transport} logoSettings="company settings" />);
    const logo = m.container.querySelector('tr[data-aifw-file="logo"]');
    expect(text(logo)).toContain("Change it in company settings.");
    expect(button(logo as Element, "Remove")).toBeNull();
    expect(text(m.container.querySelector('tr[data-aifw-file="photo"]'))).toContain("Remove it on Estimate 1042 · Pat Rivera.");
    expect(button(m.container.querySelector('tr[data-aifw-file="f1"]') as Element, "Remove front porch.jpg")).not.toBeNull();
    await m.unmount();
  });

  it("someone who can't manage files sees no Upload and no where-to-remove hints", async () => {
    const { transport } = fakeTransport({ files: () => ok({ ...FULL, canUpload: false }) });
    const m = await mount(<FilesManager transport={transport} logoSettings="company settings" />);
    expect(button(m.container, "Upload a file")).toBeNull();
    expect(text(m.container)).not.toContain("Change it in company settings.");
    await m.unmount();
  });

  it("Load more adds the next page", async () => {
    const pages = [ok(list({ files: [fileWire({ id: "a" })], nextCursor: "c1" })), ok(list({ files: [fileWire({ id: "b" })], nextCursor: null }))];
    const { transport, of } = fakeTransport({ files: () => pages.shift() });
    const m = await mount(<FilesManager transport={transport} />);
    await click(button(m.container, "Load more"));
    expect(of("files")[1]?.args[0]).toEqual({ sort: "newest", cursor: "c1" });
    expect([...m.container.querySelectorAll("tr[data-aifw-file]")].map((r) => r.getAttribute("data-aifw-file"))).toEqual(["a", "b"]);
    expect(button(m.container, "Load more")).toBeNull();
    await m.unmount();
  });

  it("Upload a file sends it to the company's files and reloads", async () => {
    const { transport, of } = fakeTransport({
      files: () => ok(list()),
      upload: () => ok({ file: fileWire({ id: "u1", name: "price list.pdf" }), usage: usage() }),
    });
    const m = await mount(<FilesManager transport={transport} />);
    expect(button(m.container, "Upload a file")).not.toBeNull();
    const input = m.container.querySelector('[data-aifw-input="files"]');
    expect(input?.hasAttribute("multiple")).toBe(false);
    await choose(input, [jpegFile("price list.jpg")]);
    await settle();
    expect(of("upload").map((c) => c.args[1])).toEqual(["price list.jpg"]);
    expect(of("files")).toHaveLength(2);
    expect(text(m.container.querySelector('[role="status"]'))).toBe("Added price list.pdf.");
    await m.unmount();
  });

  it("empty: says where files come from", async () => {
    const { transport } = fakeTransport({ files: () => ok(list()) });
    const m = await mount(<FilesManager transport={transport} />);
    expect(text(m.container)).toContain("No files yet. Photos and files added to visits, estimates and invoices show up here.");
    await m.unmount();
  });
});
