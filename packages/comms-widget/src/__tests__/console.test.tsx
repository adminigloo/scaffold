// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MessagesConsole } from "../admin/MessagesConsole.js";
import { behindSentence, lateSentence, previewSubject, runDueSentence, templateGroup, templateLabel, templateWhen } from "../admin/words.js";
import { button, click, fail, fakeTransport, labelled, message, mount, ok, status, submit, template, text, type } from "./dom.js";

/**
 * <MessagesConsole> (Tenancy 2a, 9.7): how the company's emails go out, its
 * messages grouped in plain words with an editor that shows the server's
 * refusals on their fields, a confirm before switching one off, the delivery
 * log, and "Send what's due now" with every non-zero count.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const TEMPLATES = [
  template({ key: "visit_reminder" }),
  template({ key: "visit_confirmed", subject: "You're booked" }),
  template({ key: "estimate_sent", subject: "Your estimate" }),
  template({ key: "quote_accepted_staff", subject: "Quote accepted" }),
  template({ key: "invoice_sent", subject: "Invoice {{invoiceNumber}}" }),
  template({ key: "review_request", subject: "How did we do?" }),
  template({ key: "visit_text", channel: "sms", subject: null }),
];

function console_(extra: Parameters<typeof fakeTransport>[0] = {}) {
  return fakeTransport({
    status: () => ok(status()),
    templates: () => ok({ templates: TEMPLATES }),
    messages: () => ok({ messages: [message()] }),
    ...extra,
  });
}

const section = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-aicw-section="${name}"]`)!;

describe("words", () => {
  it("labels and groups templates from their keys", () => {
    expect(templateLabel("visit_reminder")).toBe("Visit reminder");
    expect(templateLabel("invoice_sent")).toBe("Invoice");
    // A key the features don't send is title-cased.
    expect(templateLabel("thank_you_note")).toBe("Thank you note");
    expect(templateGroup("visit_reminder")).toBe("Visits");
    expect(templateGroup("estimate_sent")).toBe("Estimates");
    expect(templateGroup("quote_accepted")).toBe("Estimates");
    expect(templateGroup("lead_received_staff")).toBe("Estimates");
    expect(templateGroup("invoice_sent")).toBe("Invoices");
    expect(templateGroup("review_request")).toBe("Other");
    expect(templateGroup("booking_reminder")).toBe("Other");
  });

  it("the run-due sentence lists every non-zero count, never 'Sent 3' alone", () => {
    expect(runDueSentence({ sent: 3, skipped: 0, failed: 1, retrying: 2, cancelled: 0, expired: 0, stoppedEarly: false })).toBe(
      "Sent 3 · failed 1 · 2 will retry.",
    );
    expect(runDueSentence({ sent: 0, skipped: 2, failed: 0, retrying: 0, cancelled: 1, expired: 4, stoppedEarly: true })).toBe(
      "Sent 0 · skipped 2 · cancelled 1 · expired 4. More are due: send again.",
    );
    expect(runDueSentence({ sent: 3, skipped: 0, failed: 0, retrying: 0, cancelled: 0, expired: 0, stoppedEarly: false })).toBe("Sent 3.");
  });

  it("names every feature email in an owner's words, says when it goes out, and never shows a key (review T2A-BO-08)", () => {
    expect(templateLabel("estimate_lead_staff")).toBe("New lead (to your office)");
    expect(templateLabel("visit_staff_notice")).toBe("New request or change (to your office)");
    expect(templateLabel("quote_accepted_customer")).toBe("Quote accepted");
    expect(templateWhen("visit_reminder")).toBe("To the customer, the day before the visit.");
    expect(templateWhen("thank_you_note")).toBeNull();
    for (const key of [
      "visit_requested", "visit_confirmed", "visit_declined", "visit_rescheduled", "visit_reassigned", "visit_cancelled",
      "visit_expired", "visit_reminder", "visit_staff_notice", "estimate_lead_customer", "estimate_lead_staff", "quote_sent",
      "quote_follow_up", "quote_accepted_customer", "quote_expired_customer", "quote_staff_notice", "invoice_sent",
    ]) {
      expect(templateLabel(key), key).not.toMatch(/_/);
      expect(templateWhen(key), key).toMatch(/^To (the customer|your office)/);
    }
  });

  it("previews a subject with example values, never {{…}} (review T2A-BO-08)", () => {
    expect(previewSubject("{{subjectTag}}: {{customerName}}, {{shortWhen}}", "Green Acres")).toBe("New request: Pat Rivera, Tue, Nov 4, 9:00 AM");
    expect(previewSubject("Invoice {{invoiceNumber}} from {{businessName}}", "Green Acres")).toBe("Invoice INV-0042 from Green Acres");
    expect(previewSubject("Hello {{somethingNew}}", null)).toBe("Hello …");
  });

  it("says when scheduled messages missed their run (review SEC-2A-01)", () => {
    expect(behindSentence(1)).toMatch(/^1 scheduled message missed its send time and will go out on the next run./);
    expect(behindSentence(40)).toMatch(/^40 scheduled messages missed their send time/);
    expect(behindSentence(40)).toContain("run it more often");
  });

  it("says how many scheduled messages are late", () => {
    expect(lateSentence(1)).toMatch(/^1 scheduled message is late/);
    expect(lateSentence(4)).toBe(
      "4 scheduled messages are late: the daily job that sends them hasn't run. Ask whoever set up your site to check it.",
    );
  });
});

describe("<MessagesConsole>", () => {
  it("says who customers see emails from and where replies go", async () => {
    const fake = console_();
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    expect(text(section(container, "how"))).toContain(
      "Your customers see emails from Green Acres and their replies go to gail@greenacres.test.",
    );
    await unmount();
  });

  it("warns when email is off, and when scheduled messages are late", async () => {
    const fake = console_({
      status: () => ok(status({ emails: false, emailsOffReason: "This site doesn't send email yet.", scheduled: { pending: 5, behind: 0, late: 3 } })),
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    const how = text(section(container, "how"));
    // An owner reads the operator's job in plain words; the server's reason is for staff.
    expect(how).toContain("Email isn't switched on for this site yet");
    expect(how).not.toContain("This site doesn't send email yet.");
    expect(how).toContain("3 scheduled messages are late: the daily job that sends them hasn't run.");
    await unmount();
    const staff = await mount(<MessagesConsole transport={fake.transport} showTechnical />);
    expect(text(section(staff.container, "how"))).toContain("This site doesn't send email yet.");
    await staff.unmount();
  });

  it("warns when scheduled messages missed their run, and not otherwise (review SEC-2A-01)", async () => {
    const quiet = console_();
    const first = await mount(<MessagesConsole transport={quiet.transport} />);
    expect(first.container.querySelector("[data-aicw-behind]")).toBeNull();
    await first.unmount();
    const fake = console_({ status: () => ok(status({ scheduled: { pending: 60, behind: 40, late: 0 } })) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    expect(text(container.querySelector("[data-aicw-behind]"))).toContain("40 scheduled messages missed their send time");
    await unmount();
  });

  it("shows when each feature email goes out and its subject with example values (review T2A-BO-08)", async () => {
    const fake = console_({
      templates: () =>
        ok({
          templates: [
            template({ key: "visit_staff_notice", subject: "{{subjectTag}}: {{customerName}}, {{shortWhen}}", body: "x", variables: [] }),
          ],
        }),
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    const row = text(container.querySelector('[data-aicw-template="visit_staff_notice"]'));
    expect(row).toContain("New request or change (to your office)");
    expect(row).toContain("To your office, when a customer asks for, moves or cancels a visit.");
    expect(row).toContain("New request: Pat Rivera, Tue, Nov 4, 9:00 AM");
    expect(row).not.toContain("{{");
    await unmount();
  });

  it("groups the messages under Visits, Estimates, Invoices and Other, with plain labels", async () => {
    const fake = console_();
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    const groups = [...container.querySelectorAll("[data-aicw-group]")].map((g) => g.getAttribute("data-aicw-group"));
    expect(groups).toEqual(["Visits", "Estimates", "Invoices", "Other"]);
    const visits = container.querySelector('[data-aicw-group="Visits"]');
    expect(text(visits)).toContain("Visit reminder");
    expect(text(visits)).toContain("Visit text");
    expect(text(visits)).toContain("Text message");
    expect(text(container)).not.toContain("visit_reminder");
    await unmount();
  });

  it("edits a message: the placeholders are listed, and the server's issues land on their fields", async () => {
    const fake = console_({
      saveTemplate: () => fail("invalid", "Some details need another look.", { issues: [{ path: ["subject"], message: "An email needs a subject." }] }),
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    await click(button(container, "Edit Visit reminder"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(text(dialog)).toContain('Edit "Visit reminder"');
    expect(text(dialog.querySelector("[data-aicw-vars]"))).toBe("Filled in for you: {{date}}, {{name}}");
    await type(labelled(dialog, "Subject"), "");
    await submit(dialog.querySelector("form"));
    expect(fake.of("saveTemplate")[0]!.args).toEqual(["visit_reminder", { subject: "", body: "Hi {{name}}, see you {{date}}." }]);
    const subject = labelled(dialog, "Subject")!;
    expect(subject.getAttribute("aria-invalid")).toBe("true");
    expect(text(dialog)).toContain("An email needs a subject.");
    await unmount();
  });

  it("a successful save updates the list and closes the editor, announced", async () => {
    const fake = console_({ saveTemplate: (_key, body) => ok({ template: template({ subject: body.subject, body: body.body }) }) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    await click(button(container, "Edit Visit reminder"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await type(labelled(dialog, "Subject"), "Tomorrow: {{date}}");
    await submit(dialog.querySelector("form"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The list previews the new subject with example values.
    expect(text(container.querySelector('[data-aicw-template="visit_reminder"]'))).toContain("Tomorrow: Tue, Nov 4");
    expect(text(container.querySelector("[data-aicw-announce]"))).toBe("Visit reminder saved.");
    await unmount();
  });

  it("an SMS template's editor has no subject", async () => {
    const fake = console_({ saveTemplate: (_key, body) => ok({ template: template({ key: "visit_text", channel: "sms", subject: null, body: body.body }) }) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    await click(button(container, "Edit Visit text"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(labelled(dialog, "Subject")).toBeNull();
    await submit(dialog.querySelector("form"));
    expect((fake.of("saveTemplate")[0]!.args[1] as { subject: unknown }).subject).toBeNull();
    await unmount();
  });

  it("switching one off asks first; keeping it on changes nothing", async () => {
    const fake = console_({ setActive: (_key, body) => ok({ template: template({ active: body.active }) }) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    await click(button(container, "Turn off Visit reminder"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(text(dialog)).toContain('Turn off "Visit reminder"? Customers won\'t get it until you turn it back on.');
    await click(button(dialog, "Keep it on"));
    expect(fake.of("setActive")).toHaveLength(0);
    await click(button(container, "Turn off Visit reminder"));
    await click(button(container.querySelector('[role="dialog"]')!, "Turn off"));
    expect(fake.of("setActive")[0]!.args).toEqual(["visit_reminder", { active: false }]);
    expect(text(container.querySelector('[data-aicw-template="visit_reminder"]'))).toContain("Off");
    await unmount();
  });

  it("turning one back on needs no confirm", async () => {
    const off = TEMPLATES.map((t) => (t.key === "visit_reminder" ? { ...t, active: false } : t));
    const fake = console_({ templates: () => ok({ templates: off }), setActive: (_key, body) => ok({ template: template({ active: body.active }) }) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    await click(button(container, "Turn on Visit reminder"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(fake.of("setActive")[0]!.args).toEqual(["visit_reminder", { active: true }]);
    await unmount();
  });

  it("shows the delivery log with status words and who it was sent as, never the body", async () => {
    const fake = console_({
      messages: () =>
        ok({
          messages: [
            message(),
            message({ id: "m2", status: "skipped", note: "no email provider configured", fromName: null, blanks: ["time"] }),
            message({ id: "m3", status: "failed", note: "The provider said no." }),
          ],
        }),
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    const log = text(section(container, "log"));
    expect(log).toContain("Sent");
    expect(log).toContain("Skipped");
    expect(log).toContain("Failed");
    expect(log).toContain("Sent as Green Acres");
    expect(log).toContain("no email provider configured");
    expect(log).toContain("Left blank: time");
    expect(log).toContain("pat@example.com");
    await unmount();
  });

  it("Send what's due now: one sentence with every non-zero count, announced, and the log reloads", async () => {
    const fake = console_({ runDue: () => ok({ sent: 3, skipped: 0, failed: 1, retrying: 2, cancelled: 0, expired: 0, stoppedEarly: false }) });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    expect(fake.of("messages")).toHaveLength(1);
    await click(button(container, "Send what's due now"));
    expect(text(container.querySelector("[data-aicw-run-outcome]"))).toBe("Sent 3 · failed 1 · 2 will retry.");
    expect(text(container.querySelector("[data-aicw-announce]"))).toBe("Sent 3 · failed 1 · 2 will retry.");
    expect(fake.of("messages")).toHaveLength(2);
    await unmount();
  });

  it("canManage={false} offers no edit, switch or send controls", async () => {
    const fake = console_();
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} canManage={false} />);
    expect(button(container, "Edit")).toBeNull();
    expect(button(container, "Turn off")).toBeNull();
    expect(button(container, "Send what's due now")).toBeNull();
    expect(text(container)).toContain("Visit reminder");
    await unmount();
  });

  it("a failed load is a sentence with Try again, never a throw", async () => {
    let calls = 0;
    const fake = console_({
      templates: () => (++calls === 1 ? fail("network", "Couldn't reach the server.") : ok({ templates: TEMPLATES })),
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    expect(text(section(container, "templates"))).toContain("Couldn't reach the server.");
    await click(button(section(container, "templates"), "Try again"));
    expect(text(section(container, "templates"))).toContain("Visit reminder");
    await unmount();
  });

  it("a transport that throws is still a sentence", async () => {
    const fake = console_({
      status: () => {
        throw new Error("host transport blew up");
      },
    });
    const { container, unmount } = await mount(<MessagesConsole transport={fake.transport} />);
    expect(text(section(container, "how"))).toContain("Something went wrong. Please try again.");
    await unmount();
  });

  it("with neither transport nor baseUrl, it says so", async () => {
    const { container, unmount } = await mount(<MessagesConsole />);
    expect(text(container)).toContain("This screen isn't connected to the messages server yet.");
    await unmount();
  });
});

describe("server render", () => {
  it("renders a loading state on the server, with no data-theme under 'auto'", () => {
    const never = () => new Promise<never>(() => {});
    const fake = fakeTransport({ status: never, templates: never, messages: never });
    const html = renderToStaticMarkup(<MessagesConsole transport={fake.transport} />);
    expect(html).toMatch(/^<div class="aicw-root/);
    expect(html).not.toContain("data-theme");
    expect(html).toContain("Loading your messages…");
    expect(renderToStaticMarkup(<MessagesConsole transport={fake.transport} theme="dark" />)).toContain('data-theme="dark"');
  });
});
