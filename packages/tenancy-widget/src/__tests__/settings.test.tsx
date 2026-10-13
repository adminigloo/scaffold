// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandColorReport } from "../color.js";
import { CompanySettings, formatRatio } from "../CompanySettings.js";
import {
  button,
  click,
  company,
  companySection,
  fail,
  fakeTenancy,
  labelled,
  mount,
  ok,
  profile,
  settings,
  submit,
  text,
  type,
  wait,
  type Handlers,
} from "./fakes.js";

/**
 * <CompanySettings> (contract 8.7): three kinds of area, each saved on its
 * own: name and web address (checked live, with the warning that the public
 * address changes), logo and colour (the file checked before it's sent, the
 * colour previewed with a plain contrast sentence), and the registry's
 * sections rendered from their field specs, with the server's refusals on
 * the field they're about, a guard while anything is unsaved, and #details /
 * #branding deep links that land on the section's heading.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

const T = "t-summit";
const section = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`section[id="${id}"]`)!;

function fake(extra: Handlers = {}) {
  return fakeTenancy({
    checkSlug: (q) => ok({ slug: q.slug ?? "", available: true, problem: null, message: null, suggestion: q.slug ?? "" }),
    ...extra,
  });
}

async function render(handlers: Handlers = {}, can = ["tenant.view", "tenant.edit"], extra: Partial<ReturnType<typeof company>> = {}) {
  const f = fake(handlers);
  const mounted = await mount(
    <CompanySettings transport={f.transport} tenantId={T} initialCompany={profile(extra, can)} initialSettings={settings()} publicUrlPrefix="https://app.test/t/" />,
  );
  return { f, ...mounted };
}

function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  return act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("<CompanySettings>: name and web address", () => {
  it("warns that changing the address changes the public one, checks it live for THIS company, and saves only what changed", async () => {
    const { f, container, unmount } = await render({ updateProfile: (_t, body) => ok({ company: company({ slug: body.slug ?? "summit-window-co" }) }) });
    const profileSection = section(container, "profile");
    expect(text(profileSection)).toContain("Changing this changes your public web address. The old address keeps pointing here.");
    expect(text(profileSection)).toContain("https://app.test/t/");
    const slug = labelled(profileSection, "Web address") as HTMLInputElement;
    expect(slug.value).toBe("summit-window-co");
    await type(slug, "summit-windows");
    expect(text(profileSection)).toContain("Unsaved changes");
    await wait(400);
    expect(f.of("checkSlug").map((c) => c.args[0])).toEqual([{ slug: "summit-windows", tenantId: T }]);
    expect(text(profileSection)).toContain("Available");
    await submit(profileSection.querySelector("form"));
    expect(f.of("updateProfile").map((c) => c.args)).toEqual([[T, { slug: "summit-windows" }]]);
    expect(text(section(container, "profile"))).toContain("Saved");
    await unmount();
  });

  it("a taken address is refused on its field, with the free suggestion one click away", async () => {
    const { container, unmount } = await render({
      updateProfile: () => fail("slug_taken", "That web address is already used by another company.", { suggestion: "summit-windows-2" }),
    });
    const profileSection = section(container, "profile");
    await type(labelled(profileSection, "Web address"), "summit-windows");
    await submit(profileSection.querySelector("form"));
    const slug = labelled(profileSection, "Web address") as HTMLInputElement;
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(text(profileSection)).toContain("That web address is already used by another company.");
    await click(button(profileSection, "Use summit-windows-2"));
    expect((labelled(profileSection, "Web address") as HTMLInputElement).value).toBe("summit-windows-2");
    await unmount();
  });

  it("without tenant.edit, everything is read-only and says who can change it", async () => {
    const { container, unmount } = await render({}, ["tenant.view"]);
    expect(text(section(container, "profile"))).toContain("Only an owner or admin can change these.");
    expect((labelled(section(container, "profile"), "Company name") as HTMLInputElement).readOnly).toBe(true);
    expect(button(section(container, "profile"), "Save")).toBeNull();
    expect(section(container, "branding").querySelector('input[type="file"]')).toBeNull();
    await unmount();
  });

  it("a personal workspace keeps its address", async () => {
    const { container, unmount } = await render({}, undefined, { kind: "personal", slug: "ws-abc" });
    const slug = labelled(section(container, "profile"), "Web address") as HTMLInputElement;
    expect(slug.readOnly).toBe(true);
    expect(text(section(container, "profile"))).toContain("A personal workspace keeps the web address it was given.");
    await unmount();
  });
});

describe("<CompanySettings>: logo and colour", () => {
  it("checks the logo's type and size before sending; a good one uploads", async () => {
    const { f, container, unmount } = await render({ uploadLogo: () => ok({ company: company({ logoUrl: "https://cdn.test/logo.png" }) }) });
    const branding = section(container, "branding");
    const input = labelled(branding, "Upload logo") as HTMLInputElement;
    expect(input.type).toBe("file");
    // Any picture: a phone's photo is scaled down in the browser first
    // (review T1-11). happy-dom has no canvas, so here nothing shrinks and the
    // original must already fit.
    expect(input.accept).toBe("image/*");
    await pickFile(input, new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    await wait(0);
    expect(f.of("uploadLogo")).toHaveLength(0);
    expect(text(branding)).toContain("Use a PNG, JPG or WebP image under 1 MB.");
    await pickFile(input, new File([new Uint8Array(1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    await wait(0);
    expect(f.of("uploadLogo")).toHaveLength(0);
    await pickFile(input, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" }));
    await wait(0);
    expect(f.of("uploadLogo")).toHaveLength(1);
    expect(f.of("uploadLogo")[0]!.args[0]).toBe(T);
    expect(section(container, "branding").querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/logo.png");
    expect(text(section(container, "branding"))).toContain("Logo uploaded.");
    expect(button(section(container, "branding"), "Remove logo")).not.toBeNull();
    await unmount();
  });

  it("when the server says uploads are off, the control is disabled with the reason BEFORE any file is picked (review T1-11)", async () => {
    const f = fake({});
    const mounted = await mount(
      <CompanySettings transport={f.transport} tenantId={T} initialCompany={{ ...profile(), logoUploads: false }} initialSettings={settings()} />,
    );
    const branding = section(mounted.container, "branding");
    expect(text(branding)).toContain("Logo uploads aren't switched on for this site yet.");
    expect((labelled(branding, "Upload logo") as HTMLInputElement).disabled).toBe(true);
    expect(f.of("uploadLogo")).toHaveLength(0);
    await mounted.unmount();
  });

  it("shows the whole public address as text under the box, and suggests this device's time zone when none is saved (review T1-15)", async () => {
    const { container, unmount } = await render();
    expect(text(section(container, "profile").querySelector("[data-aitw-full-address]"))).toBe("https://app.test/t/summit-window-co");
    const details = section(container, "details");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone.includes("/")) {
      expect((labelled(details, "Time zone") as HTMLSelectElement).value).toBe(zone);
      expect(text(details)).toContain("Suggested from this device. Press Save to keep it.");
      // A suggestion isn't an unsaved change (no "leave site?" on every visit).
      expect(details.querySelector('[data-aitw-line="dirty"]')).toBeNull();
    }
    await unmount();
  });

  it("with logo storage switched off, it says so and disables the upload", async () => {
    const { container, unmount } = await render({ uploadLogo: () => fail("logo_storage_off", "Logo uploads aren't switched on for this site yet.") });
    const input = labelled(section(container, "branding"), "Upload logo") as HTMLInputElement;
    await pickFile(input, new File([new Uint8Array([1])], "logo.png", { type: "image/png" }));
    await wait(0);
    expect(text(section(container, "branding"))).toContain("Logo uploads aren't switched on for this site yet.");
    expect((labelled(section(container, "branding"), "Upload logo") as HTMLInputElement).disabled).toBe(true);
    await unmount();
  });

  it("the picker and the hex box stay in step, both named 'Brand colour'", async () => {
    const { container, unmount } = await render();
    const branding = section(container, "branding");
    const hex = labelled(branding, "Brand colour") as HTMLInputElement;
    const picker = branding.querySelector<HTMLInputElement>('input[type="color"]')!;
    const labelId = picker.getAttribute("aria-labelledby")!;
    expect(text(branding.querySelector(`[id="${labelId}"]`))).toBe("Brand colour");
    await type(hex, "#0F766E");
    expect(picker.value).toBe("#0f766e");
    await type(picker, "#22c55e");
    expect((labelled(section(container, "branding"), "Brand colour") as HTMLInputElement).value).toBe("#22c55e");
    await unmount();
  });

  it("previews the colour with a plain contrast sentence, and warns (never blocks) on a light one", async () => {
    const { f, container, unmount } = await render({
      updateBranding: (_t, body) => ok({ company: company({ brandColor: body.brandColor }), brand: brandColorReport(body.brandColor ?? "#000") }),
    });
    const branding = section(container, "branding");
    expect(text(branding)).toContain("No colour chosen.");
    await type(labelled(branding, "Brand colour"), "#0f766e");
    const teal = brandColorReport("#0f766e")!;
    expect(teal.textOnColor).toBe("#ffffff");
    // Words first; the number only behind "Contrast numbers" (review T1-15).
    expect(text(branding.querySelector("[data-aitw-ratio]"))).toBe("Text on this colour is easy to read.");
    expect(text(branding.querySelector("[data-aitw-ratio-details]"))).toContain(`Text on this colour: ${formatRatio(teal.ratioWithWhiteText)} to 1 (easy to read).`);
    const sample = branding.querySelector<HTMLElement>('[data-aitw-sample="button"]')!;
    expect(sample.style.color).toMatch(/#ffffff|rgb\(255, 255, 255\)/);
    await type(labelled(branding, "Brand colour"), "#22c55e");
    expect(text(branding)).toContain("This colour is light, so links and headings in it will be hard to read on a white page.");
    await submit(branding.querySelector("form"));
    expect(f.of("updateBranding").map((c) => c.args)).toEqual([[T, { brandColor: "#22c55e" }]]);
    expect(text(section(container, "branding"))).toContain("Saved");
    await click(button(section(container, "branding"), "Clear colour"));
    await submit(section(container, "branding").querySelector("form"));
    expect(f.of("updateBranding")[1]!.args).toEqual([T, { brandColor: null }]);
    await unmount();
  });

  it("a colour that isn't one is refused on the field, before anything is sent", async () => {
    const { f, container, unmount } = await render();
    const branding = section(container, "branding");
    await type(labelled(branding, "Brand colour"), "teal");
    await submit(branding.querySelector("form"));
    expect(f.of("updateBranding")).toHaveLength(0);
    expect(labelled(branding, "Brand colour")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(branding)).toContain("Use a colour like #0f766e.");
    await unmount();
  });
});

describe("<CompanySettings>: the registry's sections", () => {
  it("renders each field from its spec: time zones by name first, email and phone inputs, half-width pairs", async () => {
    const { container, unmount } = await render();
    const details = section(container, "details");
    expect(text(details.querySelector("h2"))).toBe("Business details");
    const zone = labelled(details, "Time zone") as HTMLSelectElement;
    expect(zone.tagName).toBe("SELECT");
    expect(zone.options[0]!.textContent).toBe("Choose a time zone");
    expect(zone.options[1]!.textContent).toBe("Eastern Time (New York)");
    expect([...zone.querySelectorAll("optgroup")].map((g) => g.getAttribute("label"))).toEqual(["United States", "Other time zones"]);
    expect(zone.getAttribute("aria-describedby")).toContain("-hint");
    const email = labelled(details, "Email customers can reach you at") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect((labelled(details, "Phone customers can call") as HTMLInputElement).type).toBe("tel");
    expect(details.querySelector('[data-field$="city"]')?.getAttribute("data-width") ?? labelled(details, "City")!.closest(".aitw-field")!.getAttribute("data-width")).toBe("half");
    await unmount();
  });

  it("an unknown stored zone stays an option, so opening the page never changes it", async () => {
    const f = fake();
    const { container, unmount } = await mount(
      <CompanySettings transport={f.transport} tenantId={T} initialCompany={profile()} initialSettings={settings([companySection({ values: { timeZone: "Mars/Olympus_Mons" } })])} />,
    );
    const zone = labelled(section(container, "details"), "Time zone") as HTMLSelectElement;
    expect(zone.value).toBe("Mars/Olympus_Mons");
    expect(text(section(container, "details"))).not.toContain("Unsaved changes");
    await unmount();
  });

  it("saves the whole section with empty boxes as null, and puts refusals on their fields", async () => {
    const saved = companySection({ values: { timeZone: "America/Denver", contactEmail: "office@summitwindows.test", contactPhone: null, addressLine1: null, city: null, region: null } });
    let attempt = 0;
    const { f, container, unmount } = await render({
      updateSettings: () =>
        ++attempt === 1
          ? fail("invalid", "Check the highlighted fields.", { status: 400, issues: [{ path: ["contactEmail"], message: "Enter an email like office@example.com." }] })
          : ok({ section: saved }),
    });
    const details = section(container, "details");
    await act(async () => {
      const zone = labelled(details, "Time zone") as HTMLSelectElement;
      zone.value = "America/Denver";
      zone.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type(labelled(details, "Email customers can reach you at"), "office@");
    expect(text(details)).toContain("Unsaved changes");
    await submit(details.querySelector("form"));
    expect(f.of("updateSettings")[0]!.args).toEqual([
      T,
      "company",
      { values: { timeZone: "America/Denver", contactEmail: "office@", contactPhone: null, addressLine1: null, city: null, region: null } },
    ]);
    const email = labelled(section(container, "details"), "Email customers can reach you at")!;
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toContain("-error");
    expect(text(section(container, "details"))).toContain("Enter an email like office@example.com.");
    await type(email, "office@summitwindows.test");
    await submit(section(container, "details").querySelector("form"));
    expect(text(section(container, "details"))).toContain("Saved");
    expect(text(section(container, "details"))).not.toContain("Unsaved changes");
    await unmount();
  });

  it("a section the person can't edit is read-only and says so", async () => {
    const f = fake();
    const { container, unmount } = await mount(
      <CompanySettings transport={f.transport} tenantId={T} initialCompany={profile()} initialSettings={settings([companySection({ canEdit: false })])} />,
    );
    const details = section(container, "details");
    expect(text(details)).toContain("You can see these but not change them.");
    expect((labelled(details, "Email customers can reach you at") as HTMLInputElement).readOnly).toBe(true);
    expect(button(details, "Save")).toBeNull();
    await unmount();
  });
});

describe("<CompanySettings>: the page", () => {
  it("guards against leaving only while something is unsaved", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { container, unmount } = await render();
    expect(add.mock.calls.filter(([name]) => name === "beforeunload")).toHaveLength(0);
    const name = labelled(section(container, "profile"), "Company name") as HTMLInputElement;
    await type(name, "Summit Windows");
    expect(add.mock.calls.filter(([n]) => n === "beforeunload")).toHaveLength(1);
    await type(name, "Summit Window Co.");
    expect(remove.mock.calls.filter(([n]) => n === "beforeunload")).toHaveLength(1);
    await unmount();
  });

  it("#details and #branding land on that section's heading (the checklist's links)", async () => {
    window.history.replaceState(null, "", "/settings/company#details");
    const a = await render();
    expect(document.activeElement).toBe(section(a.container, "details").querySelector("h2"));
    await a.unmount();
    window.history.replaceState(null, "", "/settings/company#branding");
    const b = await render();
    expect(document.activeElement).toBe(section(b.container, "branding").querySelector("h2"));
    await b.unmount();
  });

  it("loads what it wasn't given", async () => {
    const f = fake({ company: () => ok(profile()), settings: () => ok(settings()) });
    const { container, unmount } = await mount(<CompanySettings transport={f.transport} tenantId={T} />);
    expect(f.of("company").map((c) => c.args)).toEqual([[T]]);
    expect(f.of("settings").map((c) => c.args)).toEqual([[T]]);
    expect(section(container, "details")).not.toBeNull();
    await unmount();
  });
});
