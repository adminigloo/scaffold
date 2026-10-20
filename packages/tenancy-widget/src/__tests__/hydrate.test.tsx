// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CompanySettings } from "../CompanySettings.js";
import { CompanySwitcher } from "../CompanySwitcher.js";
import { Onboarding } from "../Onboarding.js";
import { SetupChecklist } from "../SetupChecklist.js";
import { TeamManager } from "../TeamManager.js";
import { checklist, fakeTenancy, onboardingSession, profile, session, settings, settle, team } from "./fakes.js";

/**
 * The emitted pages render these from a server component with server data,
 * then the browser hydrates them. A first client render that differs from
 * the server's by one character (a date printed in another zone, a time-zone
 * list the browser knows better) makes React throw the server page away.
 * Each component is rendered to a string, hydrated over it, and must
 * hydrate without a single recoverable error.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function hydrates(element: ReactElement): Promise<unknown[]> {
  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  document.body.appendChild(container);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | null = null;
  await act(async () => {
    root = hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) });
  });
  await settle();
  await act(async () => root!.unmount());
  return errors;
}

describe("hydration", () => {
  const t = () => fakeTenancy({}).transport;
  for (const [name, element] of [
    ["Onboarding", <Onboarding transport={t()} initialSession={onboardingSession()} />],
    ["CompanySwitcher", <CompanySwitcher transport={t()} session={session()} />],
    ["SetupChecklist", <SetupChecklist transport={t()} tenantId="t" initial={checklist()} />],
    ["SetupChecklist collapsible", <SetupChecklist transport={t()} tenantId="t" initial={checklist()} collapsible />],
    ["TeamManager", <TeamManager transport={t()} tenantId="t" initial={team({ you: { ...team().you, canInvite: false } })} />],
    ["CompanySettings", <CompanySettings transport={t()} tenantId="t" initialCompany={profile()} initialSettings={settings()} />],
  ] as const) {
    it(`${name} hydrates over its server render without a mismatch`, async () => {
      expect(await hydrates(element)).toEqual([]);
    });
  }
});
