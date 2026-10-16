import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { templateLabel as serverTemplateLabel } from "@adminigloo/comms";
import { TEMPLATE_GROUPS, TEMPLATE_WORDS, templateGroup, templateLabel, templateWhen } from "../admin/words.js";

/**
 * Tenancy 2b-1, 12.4: the alerts package sends staff emails as the
 * `team_alert` template, and the Messages screen lists it beside the
 * features' own emails. It needs no entry of its own: it groups under
 * "Other" and reads "Team alert", which this pins.
 *
 * comms 0.4 moved the template NAMES to the server (`templateLabel`), so
 * Alert settings can say "switched off in Messages (New lead (to your
 * office))" in the words this screen shows. The widget keeps its own copy (a
 * widget never imports the server package at runtime); the devDependency is
 * used here only, to prove the two copies say the same thing.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe("the team alert email on the Messages screen", () => {
  it("is called 'Team alert' and listed under Other", () => {
    expect(templateLabel("team_alert")).toBe("Team alert");
    expect(templateGroup("team_alert")).toBe("Other");
    expect(TEMPLATE_GROUPS).toContain("Other");
  });

  it("has no 'when' line of its own (none is promised)", () => {
    expect(templateWhen("team_alert")).toBeNull();
  });
});

describe("the same names as the server's templateLabel (comms 0.4)", () => {
  it("every template the screen names reads the same from @adminigloo/comms", () => {
    for (const [key, words] of Object.entries(TEMPLATE_WORDS)) {
      expect(serverTemplateLabel(key), key).toBe(words.label);
    }
    expect(serverTemplateLabel("team_alert")).toBe(templateLabel("team_alert"));
  });

  it("an unknown key is title-cased the same way on both sides", () => {
    for (const key of ["thank_you_note", "welcome", "spring_promo_2026"]) {
      expect(serverTemplateLabel(key)).toBe(templateLabel(key));
    }
  });

  it("the widget still never imports @adminigloo/comms outside its tests", () => {
    for (const file of ["../admin/words.ts", "../admin/MessagesConsole.tsx", "../client.ts", "../types.ts"]) {
      const source = readFileSync(resolve(here, file), "utf8");
      expect(source.includes('from "@adminigloo/comms"'), file).toBe(false);
    }
  });
});

describe("released with comms 0.4 (12.4)", () => {
  it("declares @adminigloo/comms ^0.4.0 as an optional peer", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as Record<string, any>;
    expect(manifest.peerDependencies?.["@adminigloo/comms"]).toBe("^0.4.0");
    expect(manifest.peerDependenciesMeta?.["@adminigloo/comms"]?.optional).toBe(true);
  });
});
