// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../http.js";
import { Onboarding } from "../Onboarding.js";
import type { CreateCompanyWire, SlugCheckWire } from "../types.js";
import { button, click, company, fail, fakeTenancy, labelled, mount, ok, onboardingSession, settle, submit, text, type, wait } from "./fakes.js";

/**
 * <Onboarding> (contract 8.3): one question, the web address suggested from
 * the name until the owner edits it, availability checked after 350 ms of
 * quiet, reserved words refused with a one-click alternative, ONE company per
 * mount however often the button is pressed, and invitations offered first.
 */

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const free = (slug: string): SlugCheckWire => ({ slug, available: true, problem: null, message: null, suggestion: slug });

function fake(extra: Parameters<typeof fakeTenancy>[0] = {}) {
  return fakeTenancy({
    checkSlug: (q) => ok(free(q.slug ?? "summit-window-co")),
    createCompany: () => ok({ status: "created", company: company() }),
    ...extra,
  });
}

const nameInput = (root: ParentNode) => labelled(root, "What's your company called?") as HTMLInputElement;
const address = (root: ParentNode) => text(root.querySelector("[data-aitw-address]"));

describe("<Onboarding>", () => {
  it("asks one question, autofocused, and suggests the web address from the name as it's typed", async () => {
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    const input = nameInput(container);
    expect(input).not.toBeNull();
    expect(input.getAttribute("autocomplete")).toBe("organization");
    expect(input.maxLength).toBe(80);
    expect(document.activeElement).toBe(input);
    await type(input, "Summit Window Co.");
    expect(address(container)).toBe("/t/summit-window-co");
    await type(input, "Café & Co.");
    expect(address(container)).toBe("/t/cafe-and-co");
    expect(f.of("session")).toHaveLength(0); // server-rendered session: no fetch
    await unmount();
  });

  it("the address follows the name until it's edited, then never again", async () => {
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} publicUrlPrefix="https://app.test/t/" />);
    await type(nameInput(container), "Summit Window Co.");
    expect(address(container)).toBe("https://app.test/t/summit-window-co");
    await click(button(container, "Change"));
    const slug = labelled(container, "Web address") as HTMLInputElement;
    expect(slug.value).toBe("summit-window-co");
    await type(slug, "summit");
    await type(nameInput(container), "Something Else Entirely");
    expect((labelled(container, "Web address") as HTMLInputElement).value).toBe("summit");
    await unmount();
  });

  it("checks availability only after 350 ms of quiet", async () => {
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    const input = nameInput(container);
    await type(input, "Sum");
    await type(input, "Summit");
    await type(input, "Summit Window Co.");
    await wait(150);
    expect(f.of("checkSlug")).toHaveLength(0);
    expect(text(container.querySelector("[data-aitw-availability]"))).toBe("Checking…");
    await wait(300);
    expect(f.of("checkSlug").map((c) => c.args[0])).toEqual([{ name: "Summit Window Co." }]);
    expect(text(container.querySelector("[data-aitw-availability]"))).toBe("Available");
    await unmount();
  });

  it("until edited, shows the free address the server will really use when the plain one is taken", async () => {
    const f = fake({
      checkSlug: () => ok({ slug: "summit-window-co", available: false, problem: "taken", message: "That web address is already used by another company.", suggestion: "summit-window-co-2" }),
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(nameInput(container), "Summit Window Co.");
    await wait(400);
    expect(address(container)).toBe("/t/summit-window-co-2");
    expect(text(container)).not.toContain("already used");
    await unmount();
  });

  it("a reserved address is refused in plain words, with a one-click alternative", async () => {
    const f = fake({
      checkSlug: (q) =>
        q.slug === "admin"
          ? ok({ slug: "admin", available: false, problem: "reserved", message: "That web address is kept for the site itself. Try another, like acme-plumbing.", suggestion: "admin-co" })
          : ok(free(q.slug ?? "x")),
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(nameInput(container), "Summit Window Co.");
    await click(button(container, "Change"));
    const slug = labelled(container, "Web address") as HTMLInputElement;
    await type(slug, "admin");
    await wait(400);
    expect(text(container)).toContain("That web address is kept for the site itself.");
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(slug.getAttribute("aria-describedby")).toContain("-error");
    await click(button(container, "Use admin-co"));
    expect((labelled(container, "Web address") as HTMLInputElement).value).toBe("admin-co");
    await unmount();
  });

  it("a double click sends ONE request, and a retry after a failure re-sends the SAME key", async () => {
    let release: (value: Result<CreateCompanyWire>) => void = () => {};
    let attempt = 0;
    const f = fake({
      createCompany: () => {
        attempt += 1;
        if (attempt === 1) return new Promise<Result<CreateCompanyWire>>((resolve) => (release = resolve));
        return ok({ status: "replayed", company: company() });
      },
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} purpose="onboarding" />);
    await type(nameInput(container), "Summit Window Co.");
    const form = container.querySelector("form")!;
    await submit(form);
    await submit(form);
    await click(button(container, "Creating your company"));
    expect(f.of("createCompany")).toHaveLength(1);
    release(fail("network", "We couldn't reach the server. Check your connection and try again.", { status: 0 }));
    await settle();
    expect(text(container)).toContain("We couldn't reach the server.");
    expect(assign).not.toHaveBeenCalled();
    await submit(form);
    const calls = f.of("createCompany").map((c) => c.args[0] as { requestKey: string; name: string; purpose: string; slug?: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.requestKey).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(calls[1]!.requestKey).toBe(calls[0]!.requestKey);
    expect(calls[0]).toMatchObject({ name: "Summit Window Co.", purpose: "onboarding" });
    expect(calls[0]!.slug).toBeUndefined(); // not edited: the server suggests (and suffixes)
    expect(assign).toHaveBeenCalledWith("/dashboard");
    await unmount();
  });

  it("sends an edited address and the purpose; a refused address lands on its field with the free suggestion", async () => {
    const f = fake({
      createCompany: () => fail("slug_taken", "That web address is already used by another company.", { suggestion: "summit-2" }),
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} purpose="additional" />);
    expect(text(container)).toContain("Create another company");
    await type(nameInput(container) ?? labelled(container, "Create another company"), "Summit");
    await click(button(container, "Change"));
    await type(labelled(container, "Web address"), "summit");
    await submit(container.querySelector("form"));
    expect(f.of("createCompany")[0]!.args[0]).toMatchObject({ name: "Summit", slug: "summit", purpose: "additional" });
    const slug = labelled(container, "Web address") as HTMLInputElement;
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(text(container)).toContain("That web address is already used by another company.");
    await click(button(container, "Use summit-2"));
    expect((labelled(container, "Web address") as HTMLInputElement).value).toBe("summit-2");
    await unmount();
  });

  it("a name that can't be used is refused on its field before anything is sent", async () => {
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(nameInput(container), "🙂");
    await submit(container.querySelector("form"));
    expect(f.of("createCompany")).toHaveLength(0);
    expect(nameInput(container).getAttribute("aria-invalid")).toBe("true");
    expect(text(container)).toContain("Use letters or numbers in the name.");
    await unmount();
  });

  it("onDone replaces navigation", async () => {
    const onDone = vi.fn();
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} onDone={onDone} />);
    await type(nameInput(container), "Summit Window Co.");
    await submit(container.querySelector("form"));
    expect(onDone).toHaveBeenCalledWith({ status: "created", company: { id: "t-summit", name: "Summit Window Co." } });
    expect(assign).not.toHaveBeenCalled();
    await unmount();
  });

  it("invitations come first; joining is a click (never automatic) and lands in the company", async () => {
    const f = fake({
      joinInvitation: (id) =>
        id === "inv-ok"
          ? ok({ status: "accepted", company: { id: "t-acme", name: "Acme Plumbing" }, message: null })
          : ok({ status: "expired", company: null, message: null }),
    });
    const initial = onboardingSession({
      invitations: [
        { id: "inv-ok", companyName: "Acme Plumbing", roleKey: "member", roleName: "Member", invitedBy: "Pat", expiresAt: "2026-10-19T00:00:00.000Z" },
        { id: "inv-old", companyName: "Old Co", roleKey: "viewer", roleName: "Viewer", invitedBy: null, expiresAt: null },
      ],
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={initial} afterHref="/home" />);
    expect(text(container)).toContain("Acme Plumbing invited you to join as a Member.");
    expect(text(container)).toContain("Or create your own company");
    expect(f.of("joinInvitation")).toHaveLength(0);
    await click(button(container, "Join Old Co"));
    expect(text(container.querySelector('[data-invitation="inv-old"]'))).toContain("This invitation has expired.");
    expect(assign).not.toHaveBeenCalled();
    await click(button(container, "Join Acme Plumbing"));
    expect(f.of("joinInvitation").map((c) => c.args[0])).toEqual(["inv-old", "inv-ok"]);
    expect(assign).toHaveBeenCalledWith("/home");
    await unmount();
  });

  it("in single-business mode it says so and shows no form", async () => {
    const f = fake();
    const { container, unmount } = await mount(
      <Onboarding transport={f.transport} initialSession={{ ...onboardingSession(), mode: "personal" }} noun={{ singular: "shop", plural: "shops" }} />,
    );
    expect(text(container)).toBe("This site doesn't use shops.");
    expect(container.querySelector("form")).toBeNull();
    await unmount();
  });

  it("without a server-rendered session it asks for one; with no server at all it says so plainly", async () => {
    const f = fake({ session: () => ok(onboardingSession()) });
    const a = await mount(<Onboarding transport={f.transport} />);
    expect(f.of("session")).toHaveLength(1);
    expect(nameInput(a.container)).not.toBeNull();
    await a.unmount();
    const b = await mount(<Onboarding />);
    expect(text(b.container)).toBe("This page isn't connected to its server yet.");
    await b.unmount();
  });
});

describe("<Onboarding>: review fixes", () => {
  it("someone removed from a company is told so, above the form (T1-09)", async () => {
    const f = fake();
    const { container, unmount } = await mount(
      <Onboarding transport={f.transport} initialSession={onboardingSession({ formerCompany: "Green Acres" })} />,
    );
    expect(text(container.querySelector("[data-aitw-former]"))).toBe(
      "You're no longer part of Green Acres. If that's a mistake, ask its owner to invite you again. Or set up your own company below.",
    );
    await unmount();
  });

  it("platform staff are pointed at the admin console instead of being nudged into a company (T1-09)", async () => {
    const f = fake();
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} staffConsoleHref="/admin" />);
    const staff = container.querySelector("[data-aitw-staff]")!;
    expect(text(staff)).toContain("You run this site, so you don't need a company of your own.");
    expect(staff.querySelector("a")!.getAttribute("href")).toBe("/admin");
    await unmount();
  });

  it("says what the web address is for (T1-15)", async () => {
    const { container, unmount } = await mount(<Onboarding transport={fake().transport} initialSession={onboardingSession()} />);
    expect(text(container.querySelector("[data-aitw-address-hint]"))).toBe(
      "Your page's address on this site, where customers will find you. You can change it later.",
    );
    await unmount();
  });

  it("a corrected name after a failure gets a NEW request key; the same name keeps the old one (T1-17)", async () => {
    let n = 0;
    const f = fake({ createCompany: () => (++n < 3 ? fail("network", "We couldn't reach the server.", { status: 0 }) : ok({ status: "created", company: company() })) });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(nameInput(container), "Sumit Window Co.");
    await submit(container.querySelector("form"));
    await submit(container.querySelector("form"));
    await type(nameInput(container), "Summit Window Co.");
    await submit(container.querySelector("form"));
    const keys = f.of("createCompany").map((c) => (c.args[0] as { requestKey: string }).requestKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    await unmount();
  });

  it("an earlier attempt that already made the company under another name is said, not skipped past (T1-17)", async () => {
    const f = fake({ createCompany: () => ok({ status: "replayed", company: company({ name: "Sumit Window Co." }) }) });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(nameInput(container), "Summit Window Co.");
    await submit(container.querySelector("form"));
    expect(assign).not.toHaveBeenCalled();
    expect(text(container)).toContain('Your company was already set up as "Sumit Window Co.". You can change its name in company settings.');
    await click(button(container, "Continue to Sumit Window Co."));
    expect(assign).toHaveBeenCalledWith("/dashboard");
    await unmount();
  });
});
