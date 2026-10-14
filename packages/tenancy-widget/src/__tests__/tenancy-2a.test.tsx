// @vitest-environment happy-dom
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { humanizeRoleKey, parseTeam, roleKeyOrNull } from "../client.js";
import { brandPair, CompanyBrandBar, telHref } from "../CompanyBrandBar.js";
import { CompanyUnavailable } from "../CompanyUnavailable.js";
import { AA_TEXT_RATIO, brandColorReport, contrastRatio } from "../color.js";
import { TeamManager } from "../TeamManager.js";
import type { PublicCompanyWire, TeamWire } from "../types.js";
import { fakeTenancy, invitation, labelled, member, mount, ok, team, text } from "./fakes.js";

/**
 * Tenancy 2a (contract 5): any role key the server offers (Crew), and a
 * company's public face (<CompanyBrandBar>, <CompanyUnavailable>).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const CREW = { key: "crew", name: "Crew member", description: "Opens their own crew's route for the day.", rank: 5 };

function crewTeam(): TeamWire {
  const base = team();
  return team({
    members: [
      ...base.members,
      member({ userId: "u-carl", name: "Carl Crew", email: "carl@crew.test", roleKey: "crew", roleName: "Crew member", actions: { roles: ["admin", "member", "viewer"], remove: true, transferTo: true } }),
    ],
    roles: [...base.roles, CREW],
    invitableRoles: ["admin", "member", "viewer", "crew"],
  });
}

describe("roles the project adds (5.1)", () => {
  it("roleKeyOrNull takes any well-formed key; a malformed one is null", () => {
    expect(roleKeyOrNull("crew")).toBe("crew");
    expect(roleKeyOrNull("field_lead")).toBe("field_lead");
    expect(roleKeyOrNull("owner")).toBe("owner");
    for (const bad of ["Crew", "c", "crew!", "", 5, null, "x".repeat(33)]) expect(roleKeyOrNull(bad)).toBeNull();
  });

  it("a crew key round-trips through the client parser: member, role option, invitable, actions", () => {
    const parsed = parseTeam(JSON.parse(JSON.stringify(crewTeam())))!;
    expect(parsed.members.find((m) => m.userId === "u-carl")).toMatchObject({ roleKey: "crew", roleName: "Crew member" });
    expect(parsed.roles.map((r) => r.key)).toEqual(["owner", "admin", "member", "viewer", "crew"]);
    expect(parsed.roles.at(-1)).toEqual(CREW);
    expect(parsed.invitableRoles).toContain("crew");
    expect(parsed.members.find((m) => m.userId === "u-carl")!.actions.roles).toEqual(["admin", "member", "viewer"]);
  });

  it("a key with no row in `roles` reads as words, never blank", () => {
    expect(humanizeRoleKey("crew")).toBe("Crew");
    expect(humanizeRoleKey("field_lead")).toBe("Field lead");
  });

  it("the team page shows a Crew row, offers Crew in the invite select with its description, and in a member's role select", async () => {
    const t = crewTeam();
    t.members[1] = member({ actions: { roles: ["admin", "viewer", "crew"], remove: true, transferTo: true } });
    const f = fakeTenancy({ team: () => ok(t), invitations: () => ok({ invitations: [invitation()] }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId="t-summit" initial={t} />);
    const carl = container.querySelector<HTMLElement>('[data-member="u-carl"]')!;
    expect(text(carl)).toContain("Carl Crew");
    expect(text(carl)).toContain("Crew member");
    const invite = labelled(container, "Role") as HTMLSelectElement;
    expect([...invite.options].map((o) => [o.value, o.textContent])).toContainEqual(["crew", "Crew member"]);
    const sam = container.querySelector<HTMLElement>('[data-member="u-sam"]')!;
    const select = sam.querySelector("select");
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toContain("Crew member");
    await unmount();
  });

  it("an offered key the server sent no row for is humanised in the select", async () => {
    const t = team({ invitableRoles: ["admin", "member", "viewer", "field_lead"] });
    const f = fakeTenancy({ team: () => ok(t), invitations: () => ok({ invitations: [] }) });
    const { container, unmount } = await mount(<TeamManager transport={f.transport} tenantId="t-summit" initial={t} />);
    const invite = labelled(container, "Role") as HTMLSelectElement;
    expect([...invite.options].map((o) => o.textContent)).toEqual(["Admin", "Member", "Viewer", "Field lead"]);
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// The public face
// ---------------------------------------------------------------------------

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[   ]/g, " ");

function publicCompany(extra: Partial<PublicCompanyWire> = {}): PublicCompanyWire {
  return {
    name: "Summit Window Co.",
    slug: "summit-window-co",
    publicPath: "/t/summit-window-co",
    logoUrl: null,
    brandColor: null,
    onBrandColor: null,
    contactEmail: null,
    contactPhone: null,
    status: "active",
    ...extra,
  };
}

const FULL = publicCompany({
  logoUrl: "https://blob.test/logo.png",
  brandColor: "#0f766e",
  onBrandColor: "#ffffff",
  contactEmail: "office@summitwindows.test",
  contactPhone: "(555) 010-0100",
});

describe("<CompanyBrandBar> (5.2)", () => {
  it("server-renders with everything: the logo (alt empty, 40px), the name linked home, mailto and tel, the brand rule", () => {
    const out = html(<CompanyBrandBar company={FULL} />);
    expect(out).toContain('data-aitw-brand-bar=""');
    expect(out).toMatch(/<img class="aitw-brandbar-logo" src="https:\/\/blob\.test\/logo\.png" alt="" height="40"\/>/);
    expect(out).toContain('<a class="aitw-brandbar-name" href="/t/summit-window-co">Summit Window Co.</a>');
    expect(out).toContain('href="mailto:office@summitwindows.test"');
    expect(out).toContain('href="tel:5550100100"');
    expect(out).toMatch(/class="aitw-brandbar" style="--aitw-brand:#0f766e;--aitw-on-brand:#ffffff" data-brand=""/);
    expect(out).not.toMatch(/<h[1-6]/);
    expect(out).not.toContain("data-theme");
  });

  it("server-renders with nothing: initials in the neutral badge, the name, no contact line, no brand rule", () => {
    const out = html(<CompanyBrandBar company={publicCompany()} />);
    expect(out).toContain('<span class="aitw-brandbar-initials" aria-hidden="true">SW</span>');
    expect(out).not.toContain("data-brand");
    expect(out).not.toContain("aitw-contact");
    expect(out).not.toContain("<img");
  });

  it("homeHref null → the name is plain text; showContact false hides the contact line; a custom href is used", () => {
    expect(html(<CompanyBrandBar company={FULL} homeHref={null} />)).toContain('<span class="aitw-brandbar-name">Summit Window Co.</span>');
    expect(html(<CompanyBrandBar company={FULL} showContact={false} />)).not.toContain("mailto:");
    expect(html(<CompanyBrandBar company={FULL} homeHref="https://summitwindows.test" />)).toContain('href="https://summitwindows.test"');
  });

  it("a colour with no logo: the initials badge is filled with it, in the server's text colour", () => {
    const out = html(<CompanyBrandBar company={publicCompany({ brandColor: "#fde047", onBrandColor: "#111111" })} />);
    expect(out).toContain('style="--aitw-brand:#fde047;--aitw-on-brand:#111111" data-brand=""');
    expect(out).toContain('<span class="aitw-brandbar-initials" aria-hidden="true" data-brand="">SW</span>');
  });

  it("the initials badge's text passes AA on its colour (large bold text: 3:1 for any colour; 4.5:1 whenever one exists)", () => {
    let seed = 17;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const colours = ["#0f766e", "#fde047", "#777777", "#ff0000", "#000000", "#ffffff"];
    for (let i = 0; i < 300; i += 1) colours.push(`#${Math.floor(next() * 0xffffff).toString(16).padStart(6, "0")}`);
    for (const colour of colours) {
      const report = brandColorReport(colour)!;
      // What the server sends as onBrandColor, and what the bar falls back to without it.
      for (const on of [report.textOnColor, brandPair({ brandColor: colour, onBrandColor: null })!.on]) {
        const ratio = contrastRatio(colour, on);
        expect(ratio, `${on} on ${colour}`).toBeGreaterThanOrEqual(3);
        if (report.readable) expect(ratio, `${on} on ${colour}`).toBeGreaterThanOrEqual(AA_TEXT_RATIO - 0.005);
      }
    }
  });

  it("tel: keeps digits and a leading +; no digits → plain text", () => {
    expect(telHref("+1 (555) 010-0100")).toBe("tel:+15550100100");
    expect(telHref("call the office")).toBeNull();
    expect(html(<CompanyBrandBar company={publicCompany({ contactPhone: "ask at the desk" })} />)).toContain('<span data-aitw-contact="phone">ask at the desk</span>');
  });
});

describe("<CompanyUnavailable> (5.3)", () => {
  it("server-renders the heading, the plain body, and the contact links", () => {
    const out = html(<CompanyUnavailable company={{ ...FULL, status: "suspended" }} />);
    expect(out).toContain(">Summit Window Co. isn&#x27;t taking requests online right now</h1>");
    expect(out).toContain("<p>Please get in touch with them directly.</p>");
    expect(out).toContain('<a href="mailto:office@summitwindows.test" data-aitw-contact="email">Email office@summitwindows.test</a>');
    expect(out).toContain('<a href="tel:5550100100" data-aitw-contact="phone">Call (555) 010-0100</a>');
    expect(out).not.toMatch(/suspend|reason|support/i);
    expect(out).not.toContain("<button");
  });

  it("with no contact: the heading and the body only", () => {
    const out = html(<CompanyUnavailable company={publicCompany({ status: "suspended" })} />);
    expect(out).toContain("<h1");
    expect(out).toContain("Please get in touch with them directly.");
    expect(out).not.toContain("<ul");
    expect(out).not.toContain("<a ");
  });
});
