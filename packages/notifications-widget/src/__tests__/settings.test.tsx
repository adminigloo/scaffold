// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AlertSettings } from "../admin/AlertSettings.js";
import { NOT_ON_A_LIST } from "../admin/words.js";
import { button, choice, choiceInput, click, fail, fakeTransport, group, mount, ok, prefs, text, type } from "./dom.js";

/**
 * `<AlertSettings>` (Tenancy 2b-1, section 5; reviews BO-01, BO-11, BO-12,
 * BO-20): both radios, the disabled email with its note and the Messages
 * link, "Not on your list", a refused save put back, the routing cards with
 * the business-email line, the address checks, and the "owner gets these in
 * the app" sentence.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const kind = (container: HTMLElement, key: string) => container.querySelector<HTMLElement>(`[data-ainw-kind="${key}"]`)!;
const card = (container: HTMLElement, key: string) => container.querySelector<HTMLElement>(`[data-ainw-group="${key}"]`)!;

describe("how you get each alert", () => {
  it("one section per category, two radios per kind, the routed sentence, and the email line", async () => {
    const f = fakeTransport({ preferences: () => ok(prefs()) });
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(m.container.querySelector("[data-ainw-section=how] .ainw-muted"))).toBe("Alert emails go to gail@greenacres.test.");
    expect([...m.container.querySelectorAll("[data-ainw-category]")].map((c) => c.getAttribute("data-ainw-category"))).toEqual(["Estimates", "Team"]);
    const lead = kind(m.container, "estimator.lead");
    expect(text(lead.querySelector("legend"))).toBe("Someone asks for an estimate");
    expect(choiceInput(lead, "In the app and by email")?.checked).toBe(true);
    expect(choiceInput(lead, "In the app")?.checked).toBe(false);
    expect(text(lead)).toContain("You're on the list for these.");
    expect(f.of("routing")).toHaveLength(0); // not the owner
    expect(m.container.querySelector("[data-ainw-section=who]")).toBeNull();
    await m.unmount();
  });

  it("a change saves at once and says Saved.", async () => {
    const f = fakeTransport({
      preferences: () => ok(prefs()),
      setPreference: (body) => ok(prefs({ choices: [choice({ channel: body.channel })] })),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(choiceInput(kind(m.container, "estimator.lead"), "In the app"));
    expect(f.of("setPreference")[0]?.args).toEqual([{ kind: "estimator.lead", channel: "in_app" }]);
    expect(choiceInput(kind(m.container, "estimator.lead"), "In the app")?.checked).toBe(true);
    expect(text(m.container.querySelector("[role=status]"))).toBe("Saved.");
    await m.unmount();
  });

  it("a refused save puts the old choice back and shows the server's sentence", async () => {
    const f = fakeTransport({
      preferences: () => ok(prefs()),
      setPreference: () => fail("invalid", "This alert is only shown in the app.", { issues: [{ path: ["channel"], message: "This alert is only shown in the app." }] }),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(choiceInput(kind(m.container, "estimator.lead"), "In the app"));
    expect(choiceInput(kind(m.container, "estimator.lead"), "In the app and by email")?.checked).toBe(true);
    expect(text(m.container.querySelector("[role=alert]"))).toBe("This alert is only shown in the app.");
    await m.unmount();
  });

  it("email that can't go is disabled with its note; switched off in Messages, the note links there (review BO-11)", async () => {
    const f = fakeTransport({
      preferences: () =>
        ok(
          prefs({
            choices: [
              choice({
                channel: "in_app",
                emailOffered: false,
                emailOffInMessages: true,
                emailNote: 'Emails for this are switched off in Messages ("New lead (to your office)"). Turn it back on there.',
              }),
              choice({ kind: "comms.message.failed", label: "An email to a customer didn't go", category: "Estimates", channel: "in_app", emailOffered: false, emailNote: "This alert is only shown in the app.", routed: null }),
            ],
          }),
        ),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    const lead = kind(m.container, "estimator.lead");
    expect(choiceInput(lead, "In the app and by email")?.disabled).toBe(true);
    const note = lead.querySelector("[data-ainw-note]");
    expect(text(note)).toContain('switched off in Messages ("New lead (to your office)")');
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/app/messages");
    const failed = kind(m.container, "comms.message.failed");
    expect(text(failed.querySelector("[data-ainw-note]"))).toBe("This alert is only shown in the app.");
    expect(failed.querySelector("[data-ainw-note] a")).toBeNull();
    await m.unmount();
  });

  it("kinds the person can't get are listed under Not on your list, without radios; reachable false says so first (review BO-12)", async () => {
    const f = fakeTransport({
      preferences: () =>
        ok(
          prefs({
            reachable: false,
            choices: [choice({ receives: false, routed: { group: "New estimate requests", onList: false, viaAssigned: false } })],
          }),
        ),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    const section = m.container.querySelector("[data-ainw-section=not-mine]")!;
    expect(text(section)).toContain("Not on your list");
    expect(text(section)).toContain("The owner chooses who hears about new work in Alert settings.");
    expect(text(section)).toContain("Someone asks for an estimate");
    expect(section.querySelector("input")).toBeNull();
    expect(m.container.querySelector("[data-ainw-kind]")).toBeNull();
    expect(text(m.container.querySelector("[data-ainw-section=how] .ainw-notice-info"))).toBe(NOT_ON_A_LIST);
    await m.unmount();
  });

  it("crew see the crew sentence, true too for someone on no crew (review BO-8)", async () => {
    const f = fakeTransport({ preferences: () => ok(prefs({ choices: [choice({ kind: "scheduling.visit.moved", label: "A customer moves a visit", category: "Estimates", routed: { group: "Visits", onList: false, viaAssigned: true } })] })) });
    const m = await mount(<AlertSettings transport={f.transport} />);
    const line = text(kind(m.container, "scheduling.visit.moved"));
    expect(line).toContain("You get these for visits of a crew you're on. If you're on no crew, you won't get these.");
    expect(line).not.toContain("your crew");
    await m.unmount();
  });

  it("says where the emails about new work go when that is the business email, on the top line and under the kind (review BO-1)", async () => {
    const f = fakeTransport({
      preferences: () =>
        ok(
          prefs({
            choices: [
              choice({ emailTo: "office@greenacres.test" }),
              choice({ kind: "tenancy.member.joined", label: "Someone joins the team", category: "Team", channel: "in_app", routed: null }),
            ],
          }),
        ),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(m.container.querySelector("[data-ainw-section=how] .ainw-muted"))).toBe(
      "Alert emails go to gail@greenacres.test. Emails about new work go to office@greenacres.test, the business email in company settings.",
    );
    expect(text(kind(m.container, "estimator.lead"))).toContain("Emails for this go to office@greenacres.test, the business email in company settings.");
    expect(text(kind(m.container, "tenancy.member.joined"))).not.toContain("office@greenacres.test");
    await m.unmount();
  });

  it("hideTitle leaves the heading to the page around it (review BO-11)", async () => {
    const f = fakeTransport({ preferences: () => ok(prefs()) });
    const m = await mount(<AlertSettings transport={f.transport} hideTitle />);
    expect(m.container.querySelector(".ainw-title")).toBeNull();
    expect(text(m.container)).not.toContain("Alert settings");
    expect(kind(m.container, "estimator.lead")).not.toBeNull();
    await m.unmount();
    const n = await mount(<AlertSettings transport={f.transport} />);
    expect(text(n.container.querySelector(".ainw-title"))).toBe("Alert settings");
    await n.unmount();
  });

  it("says when email doesn't go at all", async () => {
    const f = fakeTransport({ preferences: () => ok(prefs({ emailAvailable: false, emailOffReason: "This site doesn't send email yet, so alerts stay in the app." })) });
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(m.container.querySelector("[data-ainw-section=how] .ainw-muted"))).toBe("This site doesn't send email yet, so alerts stay in the app.");
    await m.unmount();
  });
});

describe("who hears about new work", () => {
  function owner(groups = [group()]) {
    return fakeTransport({
      preferences: () => ok(prefs({ canManageRouting: true })),
      routing: () => ok({ groups }),
      setRouting: (body) => ok({ groups: groups.map((g) => (g.key === body.key ? { ...g, mode: body.mode, userIds: body.userIds, extraEmails: body.extraEmails } : g)) }),
    });
  }

  it("one card per group: its label, what it covers, The owner (name)", async () => {
    const f = owner([group(), group({ key: "visits", label: "Visit requests and customer changes", covers: ["A customer asks for a visit"] })]);
    const m = await mount(<AlertSettings transport={f.transport} />);
    const estimates = card(m.container, "estimates");
    expect(text(estimates.querySelector("legend"))).toBe("New estimate requests and quote answers");
    expect(text(estimates)).toContain("This covers: Someone asks for an estimate, a customer accepts a quote.");
    expect(choiceInput(estimates, "The owner (Gail Owner)")?.checked).toBe(true);
    expect(card(m.container, "visits")).not.toBeNull();
    await m.unmount();
  });

  it("says where the owner's emails go when that is the business email (review BO-01)", async () => {
    const f = owner([group({ ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true })]);
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(card(m.container, "estimates"))).toContain("Emails go to office@greenacres.test, the business email in company settings.");
    const plain = owner([group()]);
    const n = await mount(<AlertSettings transport={plain.transport} />);
    expect(text(card(n.container, "estimates"))).not.toContain("the business email");
    await m.unmount();
    await n.unmount();
  });

  it("says which kinds send no email at all because the owner gets them in the app only, and whose choice that is (review BO-1)", async () => {
    const business = { ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true };
    const some = owner([group({ ...business, ownerInAppOnly: ["Someone asks for an estimate"] })]);
    const m = await mount(<AlertSettings transport={some.transport} />);
    const c = text(card(m.container, "estimates"));
    expect(c).toContain("Emails go to office@greenacres.test, the business email in company settings.");
    expect(c).toContain('No emails go out for: Someone asks for an estimate. It\'s set to "In the app" in "How you get each alert", above.');
    await m.unmount();

    const all = owner([group({ ...business, ownerInAppOnly: ["Someone asks for an estimate", "A customer accepts a quote"], ownerIsYou: false })]);
    const n = await mount(<AlertSettings transport={all.transport} />);
    const d = text(card(n.container, "estimates"));
    expect(d).not.toContain("Emails go to office@greenacres.test");
    expect(d).toContain(`No emails go out for: Someone asks for an estimate, a customer accepts a quote. They're set to "In the app" in the owner's own Alert settings.`);
    await n.unmount();

    // On the owner's own address the choice is only theirs: nothing more to say.
    const own = owner([group({ ownerInAppOnly: ["Someone asks for an estimate"] })]);
    const o = await mount(<AlertSettings transport={own.transport} />);
    expect(text(card(o.container, "estimates"))).not.toContain("No emails go out");
    await o.unmount();
  });

  it("the owner choosing In the app for a lead re-reads the cards, so the card says the business mailbox gets none (review BO-1)", async () => {
    let inApp = false;
    const business = { ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true };
    const f = fakeTransport({
      preferences: () => ok(prefs({ canManageRouting: true })),
      setPreference: (body) => {
        inApp = body.channel === "in_app";
        return ok(prefs({ canManageRouting: true, choices: [choice({ channel: body.channel })] }));
      },
      routing: () => ok({ groups: [group({ ...business, ownerInAppOnly: inApp ? ["Someone asks for an estimate"] : [] })] }),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(card(m.container, "estimates").querySelector("[data-ainw-no-emails]")).toBeNull();
    await click(choiceInput(kind(m.container, "estimator.lead"), "In the app"));
    expect(f.of("routing")).toHaveLength(2);
    expect(text(card(m.container, "estimates").querySelector("[data-ainw-no-emails]"))).toBe(
      'No emails go out for: Someone asks for an estimate. It\'s set to "In the app" in "How you get each alert", above.',
    );
    await m.unmount();
  });

  it("nobody ticked, with a business email: the owner gets these, and emails go to the business email (review BO-7)", async () => {
    const f = owner([group({ mode: "chosen", userIds: [], ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true })]);
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(card(m.container, "estimates").querySelector("[data-ainw-nobody]"))).toBe(
      "Nobody is ticked, so the owner gets these, and emails go to office@greenacres.test.",
    );
    await m.unmount();
    const off = owner([
      group({ mode: "chosen", userIds: [], ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true, ownerInAppOnly: ["Someone asks for an estimate", "A customer accepts a quote"] }),
    ]);
    const n = await mount(<AlertSettings transport={off.transport} />);
    expect(text(card(n.container, "estimates").querySelector("[data-ainw-nobody]"))).toBe("Nobody is ticked, so the owner gets these in the app.");
    await n.unmount();
  });

  it("These people: a checklist of the company's people, saved per card", async () => {
    const f = owner();
    const m = await mount(<AlertSettings transport={f.transport} />);
    const c = card(m.container, "estimates");
    await click(choiceInput(c, "These people"));
    const mo = choiceInput(card(m.container, "estimates"), "Mo Member");
    expect(text(mo?.closest("label"))).toBe("Mo Member mo@greenacres.test");
    await click(mo);
    await click(button(card(m.container, "estimates"), "Save"));
    expect(f.of("setRouting")[0]?.args).toEqual([{ key: "estimates", mode: "chosen", userIds: ["u-mo"], extraEmails: [] }]);
    expect(text(m.container.querySelector("[role=status]"))).toBe("Saved.");
    await m.unmount();
  });

  it("nobody ticked: the owner gets these in the app, and addresses still get the emails (review BO-20)", async () => {
    const f = owner();
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(choiceInput(card(m.container, "estimates"), "These people"));
    expect(text(card(m.container, "estimates").querySelector("[data-ainw-nobody]"))).toBe("Nobody is ticked, so the owner gets these in the app.");
    await click(button(card(m.container, "estimates"), "Add an address"));
    await type(card(m.container, "estimates").querySelector("input[type=email]"), "office@greenacres.test");
    expect(text(card(m.container, "estimates").querySelector("[data-ainw-nobody]"))).toBe(
      "Nobody is ticked, so the owner gets these in the app. These addresses still get the emails.",
    );
    await m.unmount();
  });

  it("checks each address before sending, and never sends a bad one", async () => {
    const f = owner();
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(choiceInput(card(m.container, "estimates"), "These people"));
    await click(button(card(m.container, "estimates"), "Add an address"));
    await type(card(m.container, "estimates").querySelector("input[type=email]"), "not an address");
    await click(button(card(m.container, "estimates"), "Save"));
    expect(f.of("setRouting")).toHaveLength(0);
    expect(text(card(m.container, "estimates").querySelector(".ainw-field-error"))).toBe("That doesn't look like an email address.");
    expect(card(m.container, "estimates").querySelector("input[type=email]")?.getAttribute("aria-invalid")).toBe("true");
    await type(card(m.container, "estimates").querySelector("input[type=email]"), "office@greenacres.test");
    await click(button(card(m.container, "estimates"), "Save"));
    expect(f.of("setRouting")[0]?.args).toEqual([{ key: "estimates", mode: "chosen", userIds: [], extraEmails: ["office@greenacres.test"] }]);
    await m.unmount();
  });

  it("offers at most five addresses", async () => {
    const f = owner([group({ mode: "chosen", extraEmails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test"] })]);
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(button(card(m.container, "estimates"), "Add an address"));
    expect(card(m.container, "estimates").querySelectorAll("input[type=email]")).toHaveLength(5);
    expect(button(card(m.container, "estimates"), "Add an address")).toBeNull();
    await m.unmount();
  });

  it("shows the server's refusal on the card", async () => {
    const f = fakeTransport({
      preferences: () => ok(prefs({ canManageRouting: true })),
      routing: () => ok({ groups: [group()] }),
      setRouting: () => fail("invalid", "Pick people from your company.", { issues: [{ path: ["userIds"], message: "Pick people from your company." }] }),
    });
    const m = await mount(<AlertSettings transport={f.transport} />);
    await click(button(card(m.container, "estimates"), "Save"));
    expect(text(card(m.container, "estimates").querySelector("[role=alert]"))).toBe("Pick people from your company.");
    await m.unmount();
  });

  it("shows the switched-off-in-Messages note on the card (review BO-11)", async () => {
    const f = owner([group({ emailNote: 'Emails for this are switched off in Messages ("New lead (to your office)"). Turn it back on there.' })]);
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(card(m.container, "estimates").querySelector(".ainw-notice-warn"))).toContain("switched off in Messages");
    await m.unmount();
  });
});

describe("where the business email is set (businessEmailSettings)", () => {
  /** The owner, whose emails about new work go to the business email: all three sentences show. */
  function business() {
    return fakeTransport({
      preferences: () => ok(prefs({ canManageRouting: true, choices: [choice({ emailTo: "office@greenacres.test" })] })),
      routing: () => ok({ groups: [group({ ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true })] }),
    });
  }
  const sentences = (container: HTMLElement) => [
    text(container.querySelector("[data-ainw-section=how] .ainw-muted")),
    text(kind(container, "estimator.lead").querySelector("[data-ainw-email-to]")),
    text([...card(container, "estimates").querySelectorAll(".ainw-note")].find((p) => p.textContent?.startsWith("Emails go to")) ?? null),
  ];

  it("an app that keeps it elsewhere names its own page, in all three sentences", async () => {
    const f = business();
    const m = await mount(<AlertSettings transport={f.transport} businessEmailSettings="Settings → Business profile" />);
    expect(sentences(m.container)).toEqual([
      "Alert emails go to gail@greenacres.test. Emails about new work go to office@greenacres.test, the business email in Settings → Business profile.",
      "Emails for this go to office@greenacres.test, the business email in Settings → Business profile.",
      "Emails go to office@greenacres.test, the business email in Settings → Business profile.",
    ]);
    expect(text(m.container)).not.toContain("company settings");
    await m.unmount();
  });

  it("without it (or blank), today's words: company settings", async () => {
    for (const given of [undefined, "  "]) {
      const f = business();
      const m = await mount(<AlertSettings transport={f.transport} businessEmailSettings={given} />);
      expect(sentences(m.container).every((line) => line.endsWith("the business email in company settings."))).toBe(true);
      await m.unmount();
    }
  });
});

describe("rendering", () => {
  it("renders on the server", () => {
    const f = fakeTransport({});
    const html = renderToStaticMarkup(<AlertSettings transport={f.transport} />);
    expect(html).toContain('class="ainw-root"');
    expect(html).toContain("Loading your alert settings");
  });

  it("a load failure says why, with Try again", async () => {
    const f = fakeTransport({ preferences: () => fail("forbidden", "You've been signed out. Sign in again to keep working.", { status: 401 }) });
    const m = await mount(<AlertSettings transport={f.transport} />);
    expect(text(m.container.querySelector(".ainw-notice-error"))).toContain("You've been signed out.");
    expect(button(m.container, "Try again")).not.toBeNull();
    await m.unmount();
  });
});
