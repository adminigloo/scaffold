// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ASSISTANT_ADMIN_ROUTES } from "@adminigloo/assistant";
import { AssistantSettings } from "../admin/AssistantSettings.js";
import type { AssistantSettingsTransport } from "../client.js";
import { CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, LIGHT_TOKENS } from "../styles.js";
import type { AssistantSettingsWire } from "../types.js";
import { button, click, mount, ok, type } from "./dom.js";

/**
 * The owner's settings screen, the wire's two copies, the client's paths
 * against the server's route table, and the colours.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function fakeSettings(start: Partial<AssistantSettingsWire> = {}) {
  const state: AssistantSettingsWire = {
    profile: "",
    profileMaxChars: 2400,
    rules: [],
    glossary: [],
    faqs: [],
    usage: { messagesUsed: 42, messageLimit: 300, centsUsed: "37", centLimit: 300, resetsOn: "2026-11-01", usedUp: false, limitedBy: null, message: null },
    configured: true,
    ...start,
  };
  const calls: string[] = [];
  let n = 0;
  const transport: AssistantSettingsTransport = {
    settings: async () => ok(structuredClone(state)),
    saveProfile: async (profile) => {
      calls.push(`profile:${profile}`);
      state.profile = profile;
      return ok({ profile });
    },
    addRule: async (text) => {
      calls.push(`rule:${text}`);
      const rule = { id: `r${++n}`, text };
      state.rules.push(rule);
      return ok(rule);
    },
    removeRule: async (id) => {
      calls.push(`remove-rule:${id}`);
      state.rules = state.rules.filter((r) => r.id !== id);
      return ok({ removed: true as const });
    },
    addTerm: async (term, meaning) => {
      calls.push(`term:${term}:${meaning}`);
      const row = { id: `t${++n}`, term, meaning };
      state.glossary.push(row);
      return ok(row);
    },
    removeTerm: async (id) => ok({ removed: true as const }),
    saveFaq: async ({ id, question, answer }) => {
      calls.push(`faq:${id ?? "new"}:${question}`);
      const faq = { id: id ?? `f${++n}`, question, answer };
      state.faqs = [faq, ...state.faqs.filter((f) => f.id !== faq.id)];
      return ok(faq);
    },
    removeFaq: async (id) => ok({ removed: true as const }),
    changes: async () => ok({ changes: [{ id: "1", what: "Added a house rule: Always offer a free quote.", when: "2026-10-16T12:00:00Z" }] }),
  };
  return { transport, calls, state };
}

describe("the settings screen", () => {
  it("shows the month's use in figures the server worked out, and writes each part in plain words", async () => {
    const f = fakeSettings();
    const m = await mount(<AssistantSettings baseUrl="/x" transport={f.transport} />);
    expect(m.container.querySelector("[data-aia-usage]")?.textContent).toBe("42 of 300 questions used this month · $0.37 of $3.00 of AI");
    expect(m.container.textContent).toContain("It starts again on November 1.");
    expect(m.container.textContent).toContain("Added a house rule: Always offer a free quote.");

    await type(m.container.querySelector("textarea"), "We mow lawns in Boise.");
    await click(button(m.container, "Save"));
    expect(f.calls).toContain("profile:We mow lawns in Boise.");
    expect(m.container.textContent).toContain("Saved.");

    const inputs = () => [...m.container.querySelectorAll("input")];
    await type(inputs()[0], "Do you work Sundays?");
    await type(m.container.querySelectorAll("textarea")[1], "No, Monday to Saturday.");
    await click(button(m.container, "Add the answer"));
    expect(f.calls).toContain("faq:new:Do you work Sundays?");
    expect(m.container.textContent).toContain("Do you work Sundays?");

    await type(inputs()[1], "Always offer a free quote.");
    await click(button(m.container, "Add rule"));
    expect(m.container.textContent).toContain("Rule added.");
    await click(button(m.container, "Remove"));
    expect(f.calls.some((c) => c.startsWith("remove-") || c.startsWith("faq"))).toBe(true);
    await m.unmount();
  });

  it("says when the AI isn't switched on, and when the month is used up", async () => {
    const off = await mount(<AssistantSettings baseUrl="/x" transport={fakeSettings({ configured: false }).transport} />);
    expect(off.container.textContent).toContain("isn't switched on for this site yet");
    await off.unmount();
    const used = fakeSettings({
      usage: { messagesUsed: 300, messageLimit: 300, centsUsed: "300", centLimit: 300, resetsOn: "2026-11-01", usedUp: true, limitedBy: "messages", message: "This month's assistant allowance is used up (300 messages). It starts again on November 1." },
    });
    const m = await mount(<AssistantSettings baseUrl="/x" transport={used.transport} />);
    expect(m.container.querySelector(".aia-meter")?.getAttribute("data-full")).toBe("true");
    expect(m.container.textContent).toContain("allowance is used up (300 messages)");
    await m.unmount();
  });
});

const here = dirname(fileURLToPath(import.meta.url));

function wireRegion(source: string): string | null {
  const text = source.replace(/\r\n/g, "\n");
  if (text.split("// WIRE:BEGIN").length !== 2 || text.split("// WIRE:END").length !== 2) return null;
  return text.slice(text.indexOf("// WIRE:BEGIN"), text.indexOf("// WIRE:END") + "// WIRE:END".length);
}

describe("wire parity with @adminigloo/assistant", () => {
  it("the WIRE regions are byte-identical", () => {
    const mine = wireRegion(readFileSync(resolve(here, "../types.ts"), "utf8"));
    const theirs = wireRegion(readFileSync(resolve(here, "../../../assistant/src/wire.ts"), "utf8"));
    expect(mine).not.toBeNull();
    expect(mine).toBe(theirs);
  });

  it("the client speaks every route the server's table lists", () => {
    const client = readFileSync(resolve(here, "../client.ts"), "utf8");
    for (const route of ASSISTANT_ADMIN_ROUTES) {
      const path = route.path.replace(/\{[a-z-]+\}/g, "${segment(id)}").replace("${segment(id)}/messages", "${segment(conversationId)}/messages");
      const variants = [path, path.replace("${segment(id)}", "${segment(actionId)}/${decision}").replace(/\/(confirm|decline)$/, "")];
      const spoken = variants.some((p) => client.includes(`/${p}`)) || client.includes(`/${route.path.split("/{")[0]}`);
      expect(spoken, `${route.method} ${route.path}`).toBe(true);
    }
  });
});

describe("colours", () => {
  it("every pair the widget prints meets WCAG AA, light and dark", () => {
    for (const tokens of [LIGHT_TOKENS, { ...LIGHT_TOKENS, ...DARK_TOKENS }]) {
      for (const [fg, bg, min] of CONTRAST_PAIRS) {
        expect(contrastRatio(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});
