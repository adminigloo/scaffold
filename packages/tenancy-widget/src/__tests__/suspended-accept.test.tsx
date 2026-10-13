// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptInvitation, ACCEPT_REDIRECT_MS } from "../AcceptInvitation.js";
import { CompanySuspended } from "../CompanySuspended.js";
import type { AcceptWire } from "../types.js";
import { button, click, company, fail, fakeTenancy, link, mount, ok, text, wait } from "./fakes.js";

/**
 * <CompanySuspended> and <AcceptInvitation> (contract 8.8): the suspended
 * screen says only what a member can act on (contact support, or switch to
 * another company), never the operator's reason; the invitation page does
 * nothing until "Accept invitation" is pressed, and every outcome reads as a
 * plain sentence.
 */

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("<CompanySuspended>", () => {
  it("says it's suspended and where to ask, with a mailto when support has an address, and nothing about why", async () => {
    const { container, unmount } = await mount(<CompanySuspended companyName="Side Gig" supportEmail="help@igloo.test" />);
    expect(text(container.querySelector("h2"))).toBe("Side Gig is suspended");
    expect(text(container)).toContain("You can't use it right now. Contact support to restore it.");
    expect(link(container, "Contact support")!.getAttribute("href")).toBe("mailto:help@igloo.test");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await unmount();
    const plain = await mount(<CompanySuspended companyName="Side Gig" supportEmail={null} />);
    expect(link(plain.container, "Contact support")).toBeNull();
    expect(text(plain.container)).toContain("Contact support to restore it.");
    await plain.unmount();
  });

  it("offers the person's other ACTIVE companies, and switching reloads", async () => {
    const f = fakeTenancy({ setActive: (id) => ok({ company: company({ id }) }) });
    const { container, unmount } = await mount(
      <CompanySuspended
        companyName="Side Gig"
        transport={f.transport}
        reloadHref="/home"
        noun={{ singular: "shop", plural: "shops" }}
        companies={[
          { id: "t-gig", name: "Side Gig", slug: "side-gig", logoUrl: null, role: "owner", status: "suspended", active: true },
          { id: "t-summit", name: "Summit Window Co.", slug: "summit-window-co", logoUrl: null, role: "admin", status: "active", active: false },
          { id: "t-other", name: "Other Suspended", slug: "other", logoUrl: null, role: "member", status: "suspended", active: false },
        ]}
      />,
    );
    expect(text(container)).toContain("Switch to another shop:");
    expect(button(container, "Other Suspended")).toBeNull();
    await click(button(container, "Summit Window Co."));
    expect(f.of("setActive").map((c) => c.args[0])).toEqual(["t-summit"]);
    expect(assign).toHaveBeenCalledWith("/home");
    await unmount();
  });
});

describe("<AcceptInvitation>", () => {
  it("nothing happens until the button is pressed; it says who you're signed in as", async () => {
    const f = fakeTenancy({ acceptInvitation: () => ok({ status: "accepted", company: { id: "t-summit", name: "Summit Window Co." }, message: null }) });
    const { container, unmount } = await mount(<AcceptInvitation transport={f.transport} token="tok-1" signedInAs="sam@summitwindows.test" />);
    await wait(50);
    // Nothing is ACCEPTED until the button: the only call is the read that
    // says what the link is for (review T1-07).
    expect(f.calls.map((c) => c.method)).toEqual(["previewInvitation"]);
    expect(text(container)).toContain("You're signed in as sam@summitwindows.test.");
    await click(button(container, "Accept invitation"));
    expect(f.of("acceptInvitation").map((c) => c.args[0])).toEqual(["tok-1"]);
    expect(text(container)).toContain("You're in Summit Window Co.");
    expect(link(container, "Go to Summit Window Co.")!.getAttribute("href")).toBe("/dashboard");
    expect(assign).not.toHaveBeenCalled();
    await wait(ACCEPT_REDIRECT_MS + 50);
    expect(assign).toHaveBeenCalledWith("/dashboard");
    await unmount();
  });

  const OUTCOMES: [AcceptWire, string][] = [
    [{ status: "already-a-member", company: { id: "t", name: "Summit Window Co." }, message: null }, "You were already in Summit Window Co."],
    [{ status: "expired", company: null, message: null }, "This invitation has expired. Ask whoever invited you to send a new one."],
    [{ status: "revoked", company: null, message: null }, "This invitation was withdrawn."],
    [{ status: "wrong-email", company: null, message: null }, "This invitation is for a different email address. Sign out and sign in with the address it was sent to."],
    [{ status: "unknown", company: null, message: null }, "This link isn't working. It may have been used already or replaced by a newer invitation. Ask whoever invited you to send it again."],
    [{ status: "company-unavailable", company: null, message: null }, "This company isn't available right now."],
    [{ status: "seats-full", company: null, message: "Your plan includes 3 people and 3 are on the team or invited. Remove someone or upgrade to add more." }, "Your plan includes 3 people and 3 are on the team or invited."],
  ];
  for (const [outcome, words] of OUTCOMES) {
    it(`${outcome.status}: "${words.slice(0, 40)}…"`, async () => {
      const f = fakeTenancy({ acceptInvitation: () => ok(outcome) });
      const { container, unmount } = await mount(<AcceptInvitation transport={f.transport} token="tok" signedInAs={null} />);
      expect(text(container)).not.toContain("signed in as");
      await click(button(container, "Accept invitation"));
      expect(text(container.querySelector("[data-aitw-outcome]"))).toContain(words);
      expect(button(container, "Accept invitation")).toBeNull();
      await unmount();
    });
  }

  it("says which company, role and inviter before Accept (review T1-07), from the server or the transport", async () => {
    const f = fakeTenancy({ previewInvitation: () => ok({ found: true, companyName: "Summit Window Co.", roleName: "Member", invitedBy: "Olivia" }) });
    const fetched = await mount(<AcceptInvitation transport={f.transport} token="tok" signedInAs="sam@summitwindows.test" />);
    const about = text(fetched.container.querySelector("[data-aitw-preview]"));
    expect(about).toContain("Summit Window Co. invited you to join as a Member.");
    expect(about).toContain("Sent by Olivia.");
    expect(f.of("acceptInvitation")).toHaveLength(0);
    await fetched.unmount();
    const g = fakeTenancy({});
    const given = await mount(
      <AcceptInvitation transport={g.transport} token="tok" signedInAs={null} preview={{ found: true, companyName: "Green Acres", roleName: "Admin", invitedBy: null, addressMatches: null, sentTo: null, signedInAs: null }} />,
    );
    expect(g.calls).toHaveLength(0);
    expect(text(given.container.querySelector("[data-aitw-preview]"))).toBe("Green Acres invited you to join as an Admin.");
    await given.unmount();
  });

  it("the wrong account gets a Sign out button when the host gives one (review T1-07)", async () => {
    const f = fakeTenancy({ acceptInvitation: () => ok({ status: "wrong-email", company: null, message: null }) });
    const { container, unmount } = await mount(<AcceptInvitation transport={f.transport} token="tok" signedInAs="me@else.test" signOutHref="/sign-out?redirect_url=/invite/tok" />);
    await click(button(container, "Accept invitation"));
    expect(link(container, "Sign out")!.getAttribute("href")).toBe("/sign-out?redirect_url=/invite/tok");
    await unmount();
  });

  it("a failed request says so and leaves the button to try again", async () => {
    const f = fakeTenancy({ acceptInvitation: () => fail("network", "We couldn't reach the server. Check your connection and try again.", { status: 0 }) });
    const { container, unmount } = await mount(<AcceptInvitation transport={f.transport} token="tok" signedInAs="sam@summitwindows.test" />);
    await click(button(container, "Accept invitation"));
    expect(text(container.querySelector('[role="alert"]'))).toContain("We couldn't reach the server.");
    expect(button(container, "Accept invitation")).not.toBeNull();
    await unmount();
  });
});
