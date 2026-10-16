// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesManager } from "../admin/FilesManager.js";
import { RecordFiles } from "../admin/RecordFiles.js";
import { UsageMeter } from "../admin/UsageMeter.js";
import { usageNote } from "../admin/words.js";
import { createFilesClient } from "../client.js";
import { attachments, choose, fail, fakeTransport, fileWire, jpegFile, list, mount, ok, settle, text, usage, viewport } from "./dom.js";

/**
 * What a business owner and their crew read (the founder's plain-words rule),
 * from the owner review of Tenancy 2b-1:
 *
 *   BO-4  a crash or a timeout reads "Unexpected answer from the server (500)."
 *   BO-6  "ask Igloo Back Office for more room" gave no way to ask
 *   BO-9  a member who can't delete files was told to delete some
 *   BO-10 the meter said "Almost full" right under "Your storage is full"
 *   BO-11 the Files page showed its title twice
 *   FH-11 the logo hint named the template's "company settings" page
 */

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

const GB = 1024 ** 3;
const NO_SERVER_WORDS = /server|\b\d{3}\b/i;

describe("a platform crash or timeout, in plain words (review BO-4)", () => {
  it("a 500 HTML page is 'Something went wrong. Try again in a minute.', the status kept for the host", async () => {
    const client = createFilesClient({
      baseUrl: "/files",
      fetch: (async () => new Response("<html>FUNCTION_INVOCATION_TIMEOUT</html>", { status: 500, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    const res = await client.usage();
    expect(res).toEqual({ ok: false, error: { code: "bad_response", message: "Something went wrong. Try again in a minute.", status: 500 } });
    const dead = createFilesClient({
      baseUrl: "/files",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const offline = await dead.usage();
    expect(offline.ok === false && offline.error.message).not.toMatch(NO_SERVER_WORDS);
  });

  it("Cam's photo card at the job: it didn't send, try again in a minute, the photo is still here", async () => {
    const { transport } = fakeTransport({
      attachments: () => ok(attachments()),
      attach: () => fail("bad_response", "Something went wrong. Try again in a minute.", { status: 500 }),
    });
    const m = await mount(<RecordFiles transport={transport} record={{ type: "scheduling.visit", id: "v1" }} />);
    await choose(m.container.querySelector('[data-aifw-input="files"]'), [jpegFile("second.jpg")]);
    await settle();
    const card = m.container.querySelector('[data-aifw-pending="failed"]');
    expect(text(card)).toContain("It didn't send. Try again in a minute; the photo is still here.");
    expect(text(card)).not.toMatch(NO_SERVER_WORDS);
    expect(text(card)).toContain("Try again");
    expect(text(card)).toContain("Save to phone");
    await m.unmount();
  });
});

describe("who to ask for more room, with a way to ask (review BO-6)", () => {
  it("with the platform's address, the full meter says where to write, as a link", async () => {
    const full = { usedBytes: GB, fileCount: 1, allowanceBytes: GB };
    expect(usageNote(full, "Igloo Back Office", { supportEmail: "help@igloo.test" })).toBe(
      "Full: new files can't be added until you delete some, or write to Igloo Back Office at help@igloo.test for more room.",
    );
    const m = await mount(<UsageMeter usage={full} platformName="Igloo Back Office" supportEmail="help@igloo.test" />);
    expect(m.container.querySelector('a[href="mailto:help@igloo.test"]')?.textContent).toBe("help@igloo.test");
    await m.unmount();
  });

  it("FilesManager passes it on", async () => {
    const { transport } = fakeTransport({ files: () => ok(list({ usage: usage({ usedBytes: GB, allowanceBytes: GB }) })) });
    const m = await mount(<FilesManager transport={transport} platformName="Igloo Back Office" supportEmail="help@igloo.test" />);
    expect(text(m.container)).toContain("or write to Igloo Back Office at help@igloo.test for more room.");
    await m.unmount();
  });
});

describe("someone who can't remove files is told to ask the owner (review BO-9, D11)", () => {
  it("full: 'Full: ask the owner to make room.'; almost full: 'Almost full. The owner can make room.'", async () => {
    const full = { usedBytes: GB, fileCount: 1, allowanceBytes: GB };
    const warn = { usedBytes: 0.95 * GB, fileCount: 1, allowanceBytes: GB };
    expect(usageNote(full, "Igloo Back Office", { canMakeRoom: false })).toBe("Full: ask the owner to make room.");
    expect(usageNote(warn, "Igloo Back Office", { canMakeRoom: false })).toBe("Almost full. The owner can make room.");
    const m = await mount(<UsageMeter usage={full} platformName="Igloo Back Office" canMakeRoom={false} />);
    expect(text(m.container)).not.toMatch(/delete/i);
    await m.unmount();
  });

  it("FilesManager reads it from canUpload: Mia (can see, can't add or remove) is told to ask the owner", async () => {
    const { transport } = fakeTransport({ files: () => ok(list({ canUpload: false, usage: usage({ usedBytes: GB, allowanceBytes: GB }) })) });
    const m = await mount(<FilesManager transport={transport} platformName="Igloo Back Office" />);
    expect(text(m.container)).toContain("Full: ask the owner to make room.");
    expect(text(m.container)).not.toMatch(/until you delete some/);
    await m.unmount();
  });
});

describe("after a file is refused because storage is full, the meter says full too (review BO-10)", () => {
  it("665 of 675 bytes: 'Almost full' before; after the refusal, the full tone and the full note", async () => {
    const nearly = usage({ usedBytes: 665, allowanceBytes: 675 });
    const { transport } = fakeTransport({
      files: () => ok(list({ usage: nearly })),
      upload: () => fail("storage_full", "Your storage is full: 665 bytes of 675 bytes used. Delete files you no longer need to make room.", { status: 409 }),
    });
    const m = await mount(<FilesManager transport={transport} platformName="Igloo Back Office" />);
    const meter = () => m.container.querySelector(".aifw-meter");
    expect(meter()?.getAttribute("data-tone")).toBe("warn");
    await choose(m.container.querySelector('[data-aifw-input="files"]'), [jpegFile("price list.jpg")]);
    await settle();
    expect(text(m.container.querySelector('[data-aifw-pending="failed"]'))).toContain("Your storage is full");
    expect(meter()?.getAttribute("data-tone")).toBe("full");
    expect(text(meter())).toContain("Full: new files can't be added until you delete some");
    expect(text(meter())).not.toContain("Almost full");
    await m.unmount();
  });
});

describe("the Files page's own title (review BO-11)", () => {
  it("title={false}: no heading of its own (the page has one), the section still named for a screen reader", async () => {
    const { transport } = fakeTransport({ files: () => ok(list({ files: [fileWire()] })) });
    const m = await mount(<FilesManager transport={transport} title={false} />);
    expect(m.container.querySelector("h2")).toBeNull();
    expect(m.container.querySelector('section[aria-label="Files"]')).not.toBeNull();
    await m.unmount();
    const titled = await mount(<FilesManager transport={transport} />);
    expect(text(titled.container.querySelector("h2"))).toBe("Files");
    await titled.unmount();
  });
});

describe("the logo's hint names no page of the template's (review FH-11)", () => {
  const LOGO = fileWire({ id: "logo", name: "Company logo.png", purpose: "company.logo", purposeLabel: "Company logo", record: null, canRemove: false, canLink: false });

  it("by default: 'Change it where you set your logo.'; with logoSettings, that page", async () => {
    const { transport } = fakeTransport({ files: () => ok(list({ files: [LOGO] })) });
    const m = await mount(<FilesManager transport={transport} />);
    expect(text(m.container.querySelector('tr[data-aifw-file="logo"]'))).toContain("Change it where you set your logo.");
    expect(text(m.container)).not.toContain("company settings");
    await m.unmount();
    const named = await mount(<FilesManager transport={transport} logoSettings="company settings" />);
    expect(text(named.container.querySelector('tr[data-aifw-file="logo"]'))).toContain("Change it in company settings.");
    await named.unmount();
  });
});
