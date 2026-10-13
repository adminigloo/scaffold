import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AcceptInvitation } from "../AcceptInvitation.js";
import { CompaniesConsole } from "../admin/CompaniesConsole.js";
import { CompanyDetail } from "../admin/CompanyDetail.js";
import { StaffPeople } from "../admin/StaffPeople.js";
import { CompanySettings } from "../CompanySettings.js";
import { CompanySuspended } from "../CompanySuspended.js";
import { CompanySwitcher } from "../CompanySwitcher.js";
import { Onboarding } from "../Onboarding.js";
import { SetupChecklist } from "../SetupChecklist.js";
import { TeamManager } from "../TeamManager.js";
import { checklist, fakeAdmin, fakeTenancy, onboardingSession, profile, session, settings, team } from "./fakes.js";

/**
 * The components without a DOM (react-dom/server): what a server render (a
 * Next.js page, before hydration) puts on the page. Every component renders
 * without a crash: a loading state when it has nothing yet, the real thing
 * when the page handed it server data, and no `data-theme` under "auto" (the
 * CSS's media query decides, so no flash).
 */

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[   ]/g, " ");
const never = () => new Promise<never>(() => {});

describe("server render", () => {
  it("every component renders on the server with only a transport: a loading state, no data-theme", () => {
    const t = fakeTenancy({ session: never, checklist: never, team: never, company: never, settings: never }).transport;
    const a = fakeAdmin({ companies: never, company: never, people: never }).transport;
    const outputs = [
      html(<Onboarding transport={t} />),
      html(<CompanySwitcher transport={t} />),
      html(<SetupChecklist transport={t} tenantId="t" />),
      html(<TeamManager transport={t} tenantId="t" />),
      html(<CompanySettings transport={t} tenantId="t" />),
      html(<CompanySuspended companyName="Side Gig" />),
      html(<AcceptInvitation transport={t} token="tok" signedInAs="sam@summitwindows.test" />),
      html(<CompaniesConsole transport={a} detailHref={(id) => id} />),
      html(<CompanyDetail transport={a} tenantId="t" />),
      html(<StaffPeople transport={a} />),
    ];
    for (const out of outputs) {
      expect(out).toMatch(/^<div class="aitw-root/);
      expect(out).not.toContain("data-theme");
    }
    expect(outputs[0]).toContain("Loading…");
    expect(outputs[2]).toContain("Loading…");
    expect(outputs[3]).toContain("Loading…");
    expect(outputs[4]).toContain("Loading…");
    expect(outputs[5]).toContain("Side Gig is suspended");
    expect(outputs[6]).toContain("Accept invitation");
    expect(outputs[7]).toContain('class="aitw-root aitw-admin"');
    expect(outputs[7]).toContain("Loading companies…");
    expect(outputs[8]).toContain("Loading the company…");
    expect(outputs[9]).toContain("Loading people…");
  });

  it("with server data, the first byte is the real screen (no loading flash)", () => {
    const t = fakeTenancy({}).transport;
    expect(html(<Onboarding transport={t} initialSession={onboardingSession()} />)).toContain("What&#x27;s your company called?");
    expect(html(<CompanySwitcher transport={t} session={session()} />)).toContain('aria-label="Summit Window Co., switch company"');
    expect(html(<SetupChecklist transport={t} tenantId="t" initial={checklist()} />)).toContain("0 of 3 done");
    expect(html(<TeamManager transport={t} tenantId="t" initial={team()} />)).toContain("Sam Lee");
    const settingsHtml = html(<CompanySettings transport={t} tenantId="t" initialCompany={profile()} initialSettings={settings()} />);
    expect(settingsHtml).toContain('id="details"');
    expect(settingsHtml).toContain('id="branding"');
    expect(settingsHtml).toContain('id="profile"');
  });

  it("a pinned theme is on the root from the first byte; with no server at all, one plain sentence", () => {
    expect(html(<CompanySuspended companyName="X" theme="dark" className="mine" />)).toMatch(/^<div class="aitw-root mine" data-theme="dark"/);
    for (const node of [<Onboarding />, <TeamManager tenantId="t" />, <CompanySettings tenantId="t" />, <SetupChecklist tenantId="t" />, <AcceptInvitation token="t" signedInAs={null} />, <CompaniesConsole detailHref={(id) => id} />, <CompanyDetail tenantId="t" />, <StaffPeople />]) {
      expect(html(node)).toContain("This page isn&#x27;t connected to its server yet.");
    }
  });
});
