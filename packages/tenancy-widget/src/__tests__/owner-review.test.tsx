// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptInvitation } from "../AcceptInvitation.js";
import { CompanyDetail } from "../admin/CompanyDetail.js";
import { StaffPeople } from "../admin/StaffPeople.js";
import { CompanySettings } from "../CompanySettings.js";
import { Onboarding } from "../Onboarding.js";
import { TeamManager } from "../TeamManager.js";
import { zoneOptionLabel } from "../timezones.js";
import { acceptOutcomeText, ONBOARDING, TEAM } from "../words.js";
import {
  adminDetail,
  button,
  click,
  company,
  dialog,
  fail,
  fakeAdmin,
  fakeTenancy,
  invitation,
  labelled,
  link,
  mount,
  ok,
  onboardingSession,
  people,
  person,
  profile,
  session,
  settings,
  submit,
  team,
  text,
  type,
  wait,
} from "./fakes.js";

/**
 * The business-owner review, round 2 (T1BO-01 … T1BO-10): what an owner, an
 * office manager and a crew lead actually see on a phone. Each test is one
 * finding, written to fail against the screens as they were.
 */

beforeEach(() => {
  vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

/** Visible to a person looking at the screen: not inside the screen-reader-only class. */
function visible(el: Element | null): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) if (e.classList.contains("aitw-sr")) return false;
  return el !== null;
}

describe("T1BO-03: the address shown before Create is the one the company gets", () => {
  it("name mode, with the real server's answer (available, at -2): shows /t/…-2", async () => {
    const f = fakeTenancy({
      // What checkSlug really answers for a NAME whose plain address is taken.
      checkSlug: () => ok({ slug: "green-acres-lawn-care-2", available: true, problem: null, message: null, suggestion: "green-acres-lawn-care-2" }),
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} initialSession={onboardingSession()} />);
    await type(labelled(container, "What's your company called?"), "Green Acres Lawn Care");
    await wait(400);
    expect(text(container.querySelector("[data-aitw-address]"))).toBe("/t/green-acres-lawn-care-2");
    await unmount();
  });
});

describe("T1BO-01: a lost answer never invites a second company", () => {
  it("after a failed create, the page checks whether it was made, and offers to open it instead of a retry", async () => {
    let made = false;
    const f = fakeTenancy({
      checkSlug: (q) => ok({ slug: q.slug ?? "cals-snow-removal", available: true, problem: null, message: null, suggestion: q.slug ?? "cals-snow-removal" }),
      createCompany: () => {
        made = true;
        return fail("network", "We couldn't reach the server. Check your connection and try again.", { status: 0 });
      },
      session: () =>
        ok(
          made
            ? session({
                company: company({ id: "t-snow", name: "Cal's Snow Removal", slug: "cals-snow-removal" }),
                companies: [
                  { id: "t-lawn", name: "Cal Lawn", slug: "cal-lawn", logoUrl: null, role: "owner", status: "active", active: false },
                  { id: "t-snow", name: "Cal's Snow Removal", slug: "cals-snow-removal", logoUrl: null, role: "owner", status: "active", active: true },
                ],
              })
            : session({
                companies: [{ id: "t-lawn", name: "Cal Lawn", slug: "cal-lawn", logoUrl: null, role: "owner", status: "active", active: true }],
              }),
        ),
    });
    const { container, unmount } = await mount(<Onboarding transport={f.transport} purpose="additional" />);
    await type(labelled(container, "Create another company"), "Cal's Snow Removal");
    await submit(container.querySelector("form"));
    await wait(20);
    expect(text(container)).toContain("Cal's Snow Removal was created");
    expect(button(container, "Continue to Cal's Snow Removal")).not.toBeNull();
    expect(f.of("createCompany")).toHaveLength(1);
    await unmount();
  });
});

describe("T1BO-04: removing, changing a role, withdrawing and handing over say so ON SCREEN", () => {
  it("remove: a visible confirmation, not only a screen-reader line", async () => {
    let removed = false;
    const f = fakeTenancy({
      team: () => ok(removed ? team({ members: [team().members[0]!] }) : team()),
      invitations: () => ok({ invitations: [] }),
      removeMember: () => {
        removed = true;
        return ok({ removed: "u-sam" });
      },
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId="t-summit" initial={team()} />);
    await click(button(container.querySelector('[data-member="u-sam"]')!, "Remove Sam Lee"));
    await click(button(dialog()!, "Remove Sam Lee"));
    const done = container.querySelector("[data-aitw-done]");
    expect(text(done)).toContain("Sam Lee was removed.");
    expect(visible(done)).toBe(true);
    await unmount();
  });

  it("transfer: 'Sam Lee is now the owner' is visible", async () => {
    const after = team({
      you: { userId: "u-olivia", roleKey: "admin", isOwner: false, canInvite: true, canLeave: true, leaveBlocked: null, canTransfer: false },
    });
    const f = fakeTenancy({ team: () => ok(after), invitations: () => ok({ invitations: [] }), transfer: () => ok(after) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId="t-summit" initial={team()} />);
    const form = container.querySelector("[data-aitw-transfer]")!;
    const select = form.querySelector("select")!;
    select.value = "u-sam";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await type(labelled(form, "Type Summit Window Co. to confirm"), "Summit Window Co.");
    await submit(form);
    await wait(10);
    const done = container.querySelector("[data-aitw-done]");
    expect(text(done)).toContain("Sam Lee is now the owner");
    expect(visible(done)).toBe(true);
    await unmount();
  });
});

describe("T1BO-02: every emailed link keeps working, and a dead one says what to do", () => {
  it("the words say so", () => {
    expect(TEAM.replaced("crew@x.test")).toMatch(/earlier links to this invitation still work/);
    const unknown = acceptOutcomeText({ status: "unknown", company: null, message: null }, { singular: "company", plural: "companies" });
    expect(unknown).not.toMatch(/may have been used already\.$/);
    expect(unknown).toMatch(/Ask whoever invited you to send it again/);
  });
});

describe("T1BO-07: the wrong address is explained before Accept, with both ways out", () => {
  it("shows where it was sent (masked), who you're signed in as, and offers sign-out or asking for this address", async () => {
    const f = fakeTenancy({});
    const { container, unmount } = await mount(
      <AcceptInvitation
        transport={f.transport}
        token="tok"
        signedInAs="carl.crew77@gmail.test"
        signOutHref="/sign-out"
        preview={{
          found: true,
          companyName: "Green Blade Lawn Care",
          roleName: "Member",
          invitedBy: "Lena Torres",
          addressMatches: false,
          sentTo: "c•••@greenblade.test",
          signedInAs: "carl.crew77@gmail.test",
        }}
      />,
    );
    const words = text(container);
    expect(words).toContain("c•••@greenblade.test");
    expect(words).toContain("carl.crew77@gmail.test");
    expect(words).toContain("Ask Lena Torres to invite carl.crew77@gmail.test instead");
    expect(link(container, "Sign out and use that address")?.getAttribute("href")).toBe("/sign-out");
    expect(button(container, "Accept invitation")).toBeNull();
    await unmount();
  });
});

describe("T1BO-08: company settings never loses an edit quietly", () => {
  it("lists what isn't saved in a bar that stays in view, and asks before an in-app link leaves the page", async () => {
    const f = fakeTenancy({
      checkSlug: (q) => ok({ slug: q.slug ?? "", available: true, problem: null, message: null, suggestion: q.slug ?? "" }),
    });
    const { container, unmount } = await mount(<CompanySettings transport={f.transport} tenantId="t-summit" initialCompany={profile()} initialSettings={settings()} />);
    expect(container.querySelector("[data-aitw-unsaved]")).toBeNull();
    await type(labelled(container.querySelector('section[id="profile"]')!, "Company name"), "Summit Window Co. Inc");
    expect(text(container.querySelector("[data-aitw-unsaved]"))).toContain("Name and web address");

    const away = document.createElement("a");
    away.href = "/settings/team";
    away.textContent = "Team";
    document.body.appendChild(away);
    if (typeof window.confirm !== "function") window.confirm = () => true;
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    away.dispatchEvent(event);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    await unmount();
  });
});

describe("T1BO-09: support can find a team member's companies", () => {
  it("company detail lists who is invited; a person's company count links to their companies", async () => {
    const detail = fakeAdmin({
      company: () => ok(adminDetail({ invitations: [{ email: "crew@summitwindows.test", roleName: "Member", invitedBy: "Olivia", expiresAt: "2026-10-19T15:00:00.000Z" }] })),
    });
    const a = await mount(<CompanyDetail transport={detail.transport} tenantId="t-summit" />);
    expect(text(a.container.querySelector("[data-aitw-invitations]"))).toContain("crew@summitwindows.test");
    await a.unmount();

    const staff = fakeAdmin({ people: () => ok(people({ people: [person({ email: "carl@greenblade.test", companies: 2 })] })) });
    const b = await mount(<StaffPeople transport={staff.transport} companiesHref="/admin/companies" />);
    await wait(10);
    const row = b.container.querySelector('[data-person="u-olivia"]')!;
    expect(link(row, "2")?.getAttribute("href")).toBe("/admin/companies?q=carl%40greenblade.test");
    await b.unmount();
  });
});

describe("T1BO-10: the small slips", () => {
  it("one word for withdrawing an invitation, and no per-person access sentence in the role dialog", async () => {
    const f = fakeTenancy({ team: () => ok(team()), invitations: () => ok({ invitations: [invitation()] }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId="t-summit" initial={team()} />);
    await wait(10);
    expect(button(container.querySelector("[data-invitation]")!, "Withdraw")).not.toBeNull();
    expect(button(container.querySelector("[data-invitation]")!, "Revoke")).toBeNull();
    expect(TEAM.roleBody("Sam Lee", "Does the day-to-day work.")).not.toMatch(/set up just for/);
    await unmount();
  });

  it("'join as a Member', with the article", () => {
    expect(ONBOARDING.invitedYou("Eight Lawn", "Member")).toBe("Eight Lawn invited you to join as a Member.");
  });

  it("other time zones read as places, not ids", () => {
    expect(zoneOptionLabel("America/Argentina/Buenos_Aires")).toMatch(/^Buenos Aires/);
    expect(zoneOptionLabel("America/Argentina/Buenos_Aires")).not.toContain("/");
  });

  it("colour: the swatch starts on the example colour, a half-typed one says so, and a read-only person sees no typing hint", async () => {
    const f = fakeTenancy({});
    const edit = await mount(<CompanySettings transport={f.transport} tenantId="t-summit" initialCompany={profile({ brandColor: null })} initialSettings={settings()} />);
    const branding = edit.container.querySelector('section[id="branding"]')!;
    expect((branding.querySelector('input[type="color"]') as HTMLInputElement).value).toBe("#0f766e");
    await type(labelled(branding, "Brand colour"), "green");
    expect(text(branding.querySelector("[data-aitw-preview]"))).not.toContain("No colour chosen");
    expect(text(branding.querySelector("[data-aitw-preview]"))).toContain("#0f766e");
    await edit.unmount();

    const view = await mount(
      <CompanySettings transport={f.transport} tenantId="t-summit" initialCompany={profile({}, ["tenant.view"])} initialSettings={settings()} />,
    );
    expect(text(view.container.querySelector('section[id="branding"]'))).not.toContain("Type a colour like");
    await view.unmount();
  });

  it("operator activity: routine joins aren't flagged 'Sensitive'; 'Make them the owner' waits for a choice", async () => {
    const f = fakeAdmin({ company: () => ok(adminDetail({}, { ownerDeleted: true })) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container.querySelector("[data-aitw-activity]"))).not.toContain("Sensitive");
    await click(button(container, "Change owner"));
    expect(button(dialog()!, "Make them the owner")?.disabled).toBe(true);
    await unmount();
  });
});

describe("SEC-T1-C (console): staff can free a suspended squatter's address", () => {
  it("a suspended company with no old addresses still offers to free its current one", async () => {
    const f = fakeAdmin({
      company: () => ok(adminDetail({}, { status: "suspended", suspendedAt: "2026-10-12T15:00:00.000Z", suspendedReason: "squatting" })),
      releaseAddresses: () => ok(adminDetail({}, { status: "suspended", slug: "co-1a2b3c4d5e" })),
    });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    await click(button(container, "Free its web addresses"));
    expect(text(dialog()!.querySelector("h2"))).toBe("Free /t/summit-window-co and its old addresses?");
    await click(button(dialog()!, "Free its web addresses"));
    expect(f.of("releaseAddresses")).toHaveLength(1);
    await unmount();
  });
});
