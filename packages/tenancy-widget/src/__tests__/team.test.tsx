// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamManager } from "../TeamManager.js";
import type { TeamWire } from "../types.js";
import {
  button,
  choose,
  click,
  dialog,
  fail,
  fakeTenancy,
  invitation,
  labelled,
  member,
  mount,
  ok,
  settle,
  submit,
  team,
  text,
  type,
  type Handlers,
} from "./fakes.js";

/**
 * <TeamManager> (contract 8.6): the server's `actions` are the only source of
 * what may be done; a role change saves at once and reverts on a refusal;
 * removing, revoking and leaving confirm in a focus-trapped dialog; an
 * invitation that couldn't be emailed hands over the link; a full plan says
 * so with an Upgrade link; transferring ownership waits for the typed name;
 * and a page left open across a removal says so instead of offering buttons
 * that no longer work.
 */

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const T = "t-summit";
const row = (root: ParentNode, userId: string) => root.querySelector<HTMLElement>(`[data-member="${userId}"]`)!;

function fake(extra: Handlers = {}, initialTeam: TeamWire = team()) {
  return fakeTenancy({
    team: () => ok(initialTeam),
    invitations: () => ok({ invitations: [invitation()] }),
    ...extra,
  });
}

describe("<TeamManager>: members", () => {
  it("lists members with (you) and the Owner badge, and renders ONLY the actions the server allows", async () => {
    const t = team({
      members: [
        ...team().members,
        member({ userId: "u-viewer", name: "Vic", email: "vic@summitwindows.test", roleKey: "viewer", roleName: "Viewer", actions: { roles: [], remove: false, transferTo: false } }),
      ],
    });
    const f = fake({}, t);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={t} />);
    expect(f.of("team")).toHaveLength(0); // server-rendered
    const olivia = row(container, "u-olivia");
    expect(text(olivia)).toContain("Olivia (you)");
    expect(text(olivia)).toContain("Owner");
    expect(olivia.querySelector("select")).toBeNull();
    expect(button(olivia, "Remove")).toBeNull();
    const sam = row(container, "u-sam");
    const select = sam.querySelector("select")!;
    expect(labelled(sam, "Role for Sam Lee")).toBe(select);
    expect([...select.options].map((o) => o.value)).toEqual(["member", "admin", "viewer"]);
    expect(button(sam, "Remove")).not.toBeNull();
    const vic = row(container, "u-viewer");
    expect(vic.querySelector("select")).toBeNull(); // roles: [] → plain text
    expect(text(vic)).toContain("Viewer");
    expect(button(vic, "Remove")).toBeNull();
    // Tables keep column headers for screen readers, and labels for the stacked cards.
    expect([...container.querySelectorAll('th[scope="col"]')].length).toBeGreaterThan(0);
    expect(sam.querySelector("td")!.getAttribute("data-label")).toBe("Name");
    await unmount();
  });

  it("a role change saves at once, then confirms and refetches", async () => {
    const promoted = team({ members: [team().members[0]!, member({ roleKey: "admin", roleName: "Admin", actions: { roles: ["member", "viewer"], remove: true, transferTo: true } })] });
    let teamCalls = 0;
    const f = fakeTenancy({
      team: () => ok(++teamCalls > 0 ? promoted : team()),
      invitations: () => ok({ invitations: [] }),
      changeRole: () => ok({ member: promoted.members[1]! }),
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await choose(row(container, "u-sam").querySelector("select"), "admin");
    // Making someone an Admin asks first (review T1-08), and says their own
    // per-person access is cleared.
    expect(f.of("changeRole")).toHaveLength(0);
    const d = dialog()!;
    expect(text(d.querySelector("h2"))).toBe("Make Sam Lee an Admin?");
    expect(text(d)).toContain("The change takes effect straight away.");
    await click(button(d, "Make an Admin"));
    expect(f.of("changeRole").map((c) => c.args)).toEqual([[T, "u-sam", { roleKey: "admin" }]]);
    expect(text(container.querySelector('[role="status"]'))).toBe("Role changed. Sam Lee is now an Admin.");
    expect(f.of("team").length).toBeGreaterThanOrEqual(1);
    expect((row(container, "u-sam").querySelector("select") as HTMLSelectElement).value).toBe("admin");
    await unmount();
  });

  it("a refused role change reverts the select and says why", async () => {
    const f = fake({ changeRole: () => fail("rank", "You can only change people whose role is below yours, and only to a role below yours.", { status: 403 }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const select = row(container, "u-sam").querySelector("select") as HTMLSelectElement;
    await choose(select, "admin");
    await click(button(dialog()!, "Make an Admin"));
    expect((row(container, "u-sam").querySelector("select") as HTMLSelectElement).value).toBe("member");
    expect(text(container.querySelector('[role="alert"][data-aitw-alert]'))).toContain("only change people whose role is below yours");
    await unmount();
  });

  it("remove: a focus-trapped dialog that says what happens, Escape cancels, focus returns to the button", async () => {
    const f = fake();
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const remove = button(row(container, "u-sam"), "Remove")!;
    remove.focus();
    await click(remove);
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(text(d.querySelector("h2"))).toBe("Remove Sam Lee from Summit Window Co.?");
    expect(text(d)).toContain("They lose access straight away. Anything they made stays.");
    expect(d.getAttribute("aria-labelledby")).toBe(d.querySelector("h2")!.id);
    // Cancel has focus (a stray Enter never removes anyone); Tab wraps inside.
    expect(document.activeElement).toBe(button(d, "Cancel"));
    const confirm = button(d, "Remove Sam Lee")!;
    expect(confirm.className).toContain("aitw-btn-danger");
    confirm.focus();
    await act(async () => {
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(d.querySelector(".aitw-dialog-close"));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(f.of("removeMember")).toHaveLength(0);
    expect(document.activeElement).toBe(remove);
    await unmount();
  });

  it("remove, confirmed: the person is removed and the team is asked for again", async () => {
    let removed = false;
    const f = fakeTenancy({
      team: () => ok(removed ? team({ members: [team().members[0]!] }) : team()),
      invitations: () => ok({ invitations: [] }),
      removeMember: () => {
        removed = true;
        return ok({ removed: "u-sam" });
      },
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await click(button(row(container, "u-sam"), "Remove"));
    await click(button(dialog()!, "Remove Sam Lee"));
    expect(f.of("removeMember").map((c) => c.args)).toEqual([[T, "u-sam"]]);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-member="u-sam"]')).toBeNull();
    expect(text(container.querySelector('[role="status"]'))).toBe("Sam Lee was removed.");
    await unmount();
  });

  it("removed (or demoted) while the page was open: the next refusal replaces the page with a plain notice", async () => {
    const f = fake({ changeRole: () => fail("not_a_member", "You're not part of this company.", { status: 403 }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await choose(row(container, "u-sam").querySelector("select"), "viewer");
    // A demotion asks first (review T1-08); the refusal comes on confirming.
    await click(button(dialog()!, "Make a Viewer"));
    expect(text(container)).toBe("You're not part of this company.");
    expect(container.querySelector("select")).toBeNull();
    await unmount();
    const g = fakeTenancy({ team: () => fail("not_a_member", "You're not part of this company.", { status: 403 }) });
    const fresh = await mount(<TeamManager transport={g.transport} tenantId={T} />);
    expect(text(fresh.container)).toBe("You're not part of this company.");
    await fresh.unmount();
  });
});

describe("<TeamManager>: role changes that ask first (review T1-08)", () => {
  it("a step up below Admin saves at once; cancelling a demotion puts the select back and sends nothing", async () => {
    const viewer = member({ userId: "u-vi", name: "Vi", email: "vi@x.test", roleKey: "viewer", roleName: "Viewer", actions: { roles: ["admin", "member"], remove: true, transferTo: true } });
    const t = team({ members: [team().members[0]!, member(), viewer] });
    const f = fake({ changeRole: (_t, userId, body) => ok({ member: { ...viewer, userId, roleKey: body.roleKey } }) }, t);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={t} />);
    await choose(row(container, "u-vi").querySelector("select"), "member");
    expect(dialog()).toBeNull();
    expect(f.of("changeRole").map((c) => c.args)).toEqual([[T, "u-vi", { roleKey: "member" }]]);
    await choose(row(container, "u-sam").querySelector("select"), "viewer");
    expect(text(dialog()!.querySelector("h2"))).toBe("Make Sam Lee a Viewer?");
    await click(button(dialog()!, "Cancel"));
    expect(dialog()).toBeNull();
    expect(f.of("changeRole")).toHaveLength(1);
    expect((row(container, "u-sam").querySelector("select") as HTMLSelectElement).value).toBe("member");
    await unmount();
  });
});

describe("<TeamManager>: invitations", () => {
  it("a re-send that replaced an open invitation says so, and the success line isn't repeated at the bottom (review T1-06, T1-15)", async () => {
    const f = fake({ invite: () => ok({ invitation: invitation(), delivery: "sent", link: null, replaced: true }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await type(labelled(container, "Email address"), "rae@summitwindows.test");
    await submit(container.querySelector("[data-aitw-invite] form"));
    const invite = container.querySelector("[data-aitw-invite]")!;
    expect(text(invite)).toContain("A new email went to rae@summitwindows.test. The earlier links to this invitation still work too.");
    // The page-wide status line is for screen readers only now.
    expect(container.querySelector('[role="status"][data-aitw-status]')!.className).toContain("aitw-sr");
    await unmount();
  });

  it("invites by email with a role; when the email went out it says so", async () => {
    const f = fake({ invite: (_t, body) => ok({ invitation: invitation({ email: body.email, roleKey: body.roleKey }), delivery: "sent", link: null }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const role = labelled(container, "Role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual(["Admin", "Member", "Viewer"]);
    expect(role.value).toBe("member");
    expect(text(container)).toContain("Does the day-to-day work.");
    const email = labelled(container, "Email address") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("off");
    await type(email, "sam@summitwindows.test");
    await choose(role, "viewer");
    await submit(container.querySelector("[data-aitw-invite] form"));
    expect(f.of("invite").map((c) => c.args)).toEqual([[T, { email: "sam@summitwindows.test", roleKey: "viewer" }]]);
    expect(text(container.querySelector("[data-aitw-invite]"))).toContain("Invitation sent to sam@summitwindows.test.");
    expect((labelled(container, "Email address") as HTMLInputElement).value).toBe("");
    await unmount();
  });

  it("when the email couldn't go, it hands over the link to copy", async () => {
    const f = fake({ invite: () => ok({ invitation: invitation(), delivery: "skipped", link: "https://app.test/invite/tok123" }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await type(labelled(container, "Email address"), "rae@summitwindows.test");
    await submit(container.querySelector("[data-aitw-invite] form"));
    const invite = container.querySelector("[data-aitw-invite]")!;
    expect(text(invite)).toContain("We couldn't email rae@summitwindows.test, so copy this link and send it to them yourself.");
    const field = labelled(invite, "Invitation link") as HTMLInputElement;
    expect(field.value).toBe("https://app.test/invite/tok123");
    expect(field.readOnly).toBe(true);
    expect(button(invite, "Copy link")).not.toBeNull();
    await unmount();
  });

  it("a bad address is refused on the field before anything is sent", async () => {
    const f = fake();
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await type(labelled(container, "Email address"), "sam at summit");
    await submit(container.querySelector("[data-aitw-invite] form"));
    expect(f.of("invite")).toHaveLength(0);
    expect(labelled(container, "Email address")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(container)).toContain("Enter an email address, like sam@example.com.");
    await unmount();
  });

  it("a full plan says so, with the Upgrade link; the seats line counts invitations", async () => {
    const t = team({ seats: { limit: 3, used: 2, pending: 1 } });
    const f = fake({
      invite: () => fail("seats_full", "Your plan includes 3 people and 3 are on the team or invited. Remove someone or upgrade to add more.", { upgradeHref: "/billing" }),
    }, t);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={t} />);
    expect(text(container.querySelector("[data-aitw-seats]"))).toBe("3 of 3 places used (including invitations).");
    await type(labelled(container, "Email address"), "rae@summitwindows.test");
    await submit(container.querySelector("[data-aitw-invite] form"));
    expect(text(container)).toContain("Your plan includes 3 people");
    expect(container.querySelector("[data-aitw-upgrade]")!.getAttribute("href")).toBe("/billing");
    await unmount();
  });

  it("pending invitations: expiry, Resend (same outcome as an invite), Revoke after a confirmation", async () => {
    const f = fake({
      invitations: () => ok({ invitations: [invitation(), invitation({ id: "inv-2", email: "old@summitwindows.test", state: "expired", canRevoke: false })] }),
      resendInvitation: () => ok({ invitation: invitation(), delivery: "failed", link: "https://app.test/invite/new" }),
      revokeInvitation: () => ok({ id: "inv-1" }),
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const pending = container.querySelector('[data-invitation="inv-1"]')!;
    expect(text(pending)).toContain("rae@summitwindows.test");
    expect(text(pending)).toMatch(/Expires Oct 19, 2026/);
    const expired = container.querySelector('[data-invitation="inv-2"]')!;
    expect(text(expired)).toContain("Expired");
    expect(button(expired, "Withdraw")).toBeNull();
    await click(button(pending, "Resend"));
    expect(f.of("resendInvitation").map((c) => c.args)).toEqual([[T, "inv-1"]]);
    expect((labelled(container, "Invitation link") as HTMLInputElement).value).toBe("https://app.test/invite/new");
    await click(button(container.querySelector('[data-invitation="inv-1"]')!, "Withdraw"));
    expect(text(dialog()!.querySelector("h2"))).toBe("Withdraw the invitation to rae@summitwindows.test?");
    expect(text(dialog())).toContain("The link they have will stop working.");
    await click(button(dialog()!, "Withdraw invitation"));
    expect(f.of("revokeInvitation").map((c) => c.args)).toEqual([[T, "inv-1"]]);
    expect(text(container.querySelector('[role="status"]'))).toBe("The invitation to rae@summitwindows.test was withdrawn.");
    await unmount();
  });

  it("someone who can't invite sees no invite form and no pending list (and nothing is fetched for it)", async () => {
    const t = team({ you: { ...team().you, canInvite: false }, invitableRoles: [] });
    const f = fake({}, t);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={t} />);
    expect(container.querySelector("[data-aitw-invite]")).toBeNull();
    expect(f.of("invitations")).toHaveLength(0);
    await unmount();
  });
});

describe("<TeamManager>: an owner alone on the team (review T1-16)", () => {
  it("is told how to hand the company over: invite someone first", async () => {
    const solo = team({ members: [team().members[0]!] });
    const f = fake({}, solo);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={solo} />);
    expect(container.querySelector("[data-aitw-transfer]")).toBeNull();
    expect(text(container.querySelector("[data-aitw-transfer-hint]"))).toBe(
      "To hand Summit Window Co. to someone new, invite them first. Once they've joined, you can transfer ownership here.",
    );
    await unmount();
  });
});

describe("<TeamManager>: leaving and handing over", () => {
  it("the owner can't leave: the button is replaced by the sentence", async () => {
    const { container, unmount } = await mount(<TeamManager transport={fake().transport} tenantId={T} initial={team()} />);
    expect(button(container, "Leave Summit Window Co.")).toBeNull();
    expect(text(container.querySelector("[data-aitw-leave-blocked]"))).toBe("You own this company. Hand ownership to someone else before you leave.");
    await unmount();
  });

  it("a member leaves after confirming, and is sent on", async () => {
    const t = team({ you: { userId: "u-sam", roleKey: "member", isOwner: false, canInvite: false, canLeave: true, leaveBlocked: null, canTransfer: false } });
    const f = fake({ leave: () => ok({ left: T }) }, t);
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={t} afterLeaveHref="/next" />);
    await click(button(container, "Leave Summit Window Co."));
    expect(text(dialog()!.querySelector("h2"))).toBe("Leave Summit Window Co.?");
    expect(text(dialog())).toContain("You'll lose access to it straight away.");
    await click(button(dialog()!, "Leave Summit Window Co."));
    expect(f.of("leave").map((c) => c.args)).toEqual([[T]]);
    expect(assign).toHaveBeenCalledWith("/next");
    await unmount();
  });

  it("transfer stays disabled until a new owner is chosen AND the name is typed (any case), then succeeds", async () => {
    const after = team({
      you: { userId: "u-olivia", roleKey: "admin", isOwner: false, canInvite: true, canLeave: true, leaveBlocked: null, canTransfer: false },
      members: [member({ userId: "u-olivia", name: "Olivia", isYou: true, roleKey: "admin", roleName: "Admin", actions: { roles: [], remove: false, transferTo: false } }), member({ isOwner: true, roleKey: "owner", roleName: "Owner", actions: { roles: [], remove: false, transferTo: false } })],
    });
    let transferred = false;
    const f = fake({
      team: () => ok(transferred ? after : team()),
      transfer: () => {
        transferred = true;
        return ok(after);
      },
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const form = container.querySelector("[data-aitw-transfer]")!;
    const go = button(form, "Transfer ownership")!;
    expect(go.disabled).toBe(true);
    await choose(labelled(form, "New owner"), "u-sam");
    expect(text(form)).toContain("Sam Lee becomes the owner and runs the team and the settings. You'll become an Admin.");
    expect(go.disabled).toBe(true);
    const confirm = labelled(form, "Type Summit Window Co. to confirm")!;
    await type(confirm, "summit window");
    expect(button(form, "Transfer ownership")!.disabled).toBe(true);
    await type(confirm, "  summit   WINDOW co. ");
    expect(button(form, "Transfer ownership")!.disabled).toBe(false);
    await submit(form);
    expect(f.of("transfer").map((c) => c.args)).toEqual([[T, { toUserId: "u-sam", confirmName: "  summit   WINDOW co. " }]]);
    expect(text(container.querySelector('[role="status"]'))).toBe("Sam Lee is now the owner. You're an Admin.");
    // Re-rendered from the answer: the former owner can leave now, and there is nothing left to transfer.
    expect(button(container, "Leave Summit Window Co.")).not.toBeNull();
    expect(container.querySelector("[data-aitw-transfer]")).toBeNull();
    await unmount();
  });

  it("a mismatched name refused by the server lands on the confirmation field", async () => {
    const f = fake({ transfer: () => fail("confirmation_mismatch", "Type the company's name exactly as it's shown to confirm.", { status: 422 }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const form = container.querySelector("[data-aitw-transfer]")!;
    await choose(labelled(form, "New owner"), "u-sam");
    await type(labelled(form, "Type Summit Window Co. to confirm"), "Summit Window Co.");
    await submit(form);
    expect(labelled(form, "Type Summit Window Co. to confirm")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(form)).toContain("Type the company's name exactly as it's shown to confirm.");
    await unmount();
  });

  it("no transport and no baseUrl: one plain sentence, no crash", async () => {
    const { container, unmount } = await mount(<TeamManager tenantId={T} />);
    expect(text(container)).toBe("This page isn't connected to its server yet.");
    await unmount();
  });
});

describe("<TeamManager>: review round 3", () => {
  it("SEC-T1-B: a Resend the email limits held says why in the server's words, hands over the link, and never says 'couldn't email'", async () => {
    const note =
      "We emailed rae@summitwindows.test 3 minutes ago, so we didn't email them again yet. Emails can take a few minutes to arrive. " +
      "The link in the email we already sent still works. You can email it again in 7 minutes, or copy the link below and send it yourself.";
    const f = fake({
      resendInvitation: () => ok({ invitation: invitation(), delivery: "held", link: "https://app.test/invite/held", replaced: true, note }),
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await click(button(container.querySelector('[data-invitation="inv-1"]')!, "Resend"));
    const held = container.querySelector('[data-aitw-issued="held"]')!;
    expect(text(held)).toContain(note);
    expect(text(held)).not.toContain("couldn't email");
    expect(text(held)).not.toContain("A new email went");
    expect((labelled(held, "Invitation link") as HTMLInputElement).value).toBe("https://app.test/invite/held");
    expect(text(container.querySelector('[role="status"]'))).toBe(note);
    await unmount();
  });

  it("not emailed and replacing an open invitation: no 'a new email went', only that the earlier links work", async () => {
    const f = fake({ resendInvitation: () => ok({ invitation: invitation(), delivery: "skipped", link: "https://app.test/invite/x", replaced: true, note: null }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    await click(button(container.querySelector('[data-invitation="inv-1"]')!, "Resend"));
    const pending = container.querySelector("[data-aitw-issued]")!;
    expect(text(pending)).not.toContain("A new email went");
    expect(text(pending)).toContain("The earlier links to this invitation still work too.");
    // Review R4 SEC-T1-B: with no mailer there were never any earlier EMAILS to speak of.
    expect(text(pending)).not.toMatch(/emails? (went|we sent)|earlier emails/);
    await unmount();
  });

  it("T1BO-07: beside an invitation someone tried while signed in as someone else, the owner reads who (masked) and what to do", async () => {
    const f = fake({
      invitations: () =>
        ok({
          invitations: [
            invitation({ wrongAccount: { signedInAs: "j•••@gmail.com", at: "2026-10-12T16:00:00.000Z" } }),
            invitation({ id: "inv-2", email: "quiet@summitwindows.test" }),
          ],
        }),
    });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId={T} initial={team()} />);
    const tried = container.querySelector('[data-invitation="inv-1"] [data-aitw-wrong-account]')!;
    expect(text(tried)).toBe(
      "Someone tried to accept this while signed in as j•••@gmail.com (Oct 12, 2026). " +
        "Ask them to sign in with the address it was sent to, or withdraw it and invite the address they use.",
    );
    expect(container.querySelector('[data-invitation="inv-2"] [data-aitw-wrong-account]')).toBeNull();
    await unmount();
  });
});
