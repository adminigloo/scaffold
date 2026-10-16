import { describe, expect, it } from "vitest";
import { breakLinks } from "../links.js";
import { renderAlertEmail } from "../render.js";
import { TEAM_ALERT_EMAIL_TEMPLATE } from "../template.js";
import type { AlertEmailMessage } from "../types.js";

/**
 * `renderAlertEmail` (Tenancy 2b-1, 4.9; reviews G12, BO-17): the team alert
 * email for a host without comms, in the template's exact words, with what a
 * customer typed escaped and its links broken.
 */

const message = (extra: Partial<AlertEmailMessage> = {}): AlertEmailMessage => ({
  tenantId: "green-acres",
  alertId: "a1",
  kind: "estimator.lead",
  to: "gail@greenacres.test",
  recipientName: "Gail",
  addressOnly: false,
  title: "Pat Rivera asked for an estimate",
  body: "Front walk, 3 steps.",
  href: "/app/estimates/e1",
  replyTo: null,
  idempotencyKey: "alert:a1",
  ...extra,
});
const options = { businessName: "Green Acres", link: "https://app.example/app/estimates/e1", settingsLink: "https://app.example/app/alerts/settings" };

describe("renderAlertEmail", () => {
  it("speaks the template's exact words", () => {
    const mail = renderAlertEmail(message(), options);
    expect(TEAM_ALERT_EMAIL_TEMPLATE).toEqual({ key: "team_alert", subject: "{{title}}", body: "{{body}}\n\n{{linkLine}}\n\n{{settingsLine}}" });
    expect(mail.subject).toBe("Pat Rivera asked for an estimate");
    expect(mail.text).toBe(
      [
        "Front walk, 3 steps.",
        "Open it: https://app.example/app/estimates/e1",
        "Change which alerts you get by email: https://app.example/app/alerts/settings",
      ].join("\n\n"),
    );
    expect(mail.html).toBe(
      [
        "<p>Front walk, 3 steps.</p>",
        '<p>Open it: <a href="https://app.example/app/estimates/e1" style="word-break:break-all">https://app.example/app/estimates/e1</a></p>',
        '<p>Change which alerts you get by email: <a href="https://app.example/app/alerts/settings" style="word-break:break-all">https://app.example/app/alerts/settings</a></p>',
      ].join("\n"),
    );
  });

  it("escapes <script> in a title or body in the html", () => {
    const mail = renderAlertEmail(message({ title: "<script>alert(1)</script>", body: '"><img src=x onerror=alert(1)>' }), options);
    expect(mail.html).not.toMatch(/<script|<img/);
    expect(mail.html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.subject).toBe("<script>alert(1)</script>"); // a Subject is text, not markup
  });

  it("breaks a link-shaped body in both parts, so the only links are the host's", () => {
    const mail = renderAlertEmail(message({ body: "Pay now at https://evil.example/pay or www.evil.example" }), options);
    expect(mail.text).toContain("https[:]//evil[.]example/pay");
    expect(mail.text).toContain("www[.]evil.example");
    expect(mail.html).toContain("https[:]//evil[.]example/pay");
    expect(mail.html.match(/<a /g)).toHaveLength(2);
  });

  it("strips CR, LF, U+2028 and U+2029 from the subject", () => {
    const mail = renderAlertEmail(message({ title: `Lead\r\nBcc: x@y.z${String.fromCharCode(0x2028)}more${String.fromCharCode(0x2029)}end` }), options);
    expect(mail.subject).toBe("Lead Bcc: x@y.z more end");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("folds away an empty body and a null link", () => {
    const mail = renderAlertEmail(message({ body: null }), { ...options, link: null });
    expect(mail.text).toBe("Change which alerts you get by email: https://app.example/app/alerts/settings");
    expect(mail.html).toBe(
      '<p>Change which alerts you get by email: <a href="https://app.example/app/alerts/settings" style="word-break:break-all">https://app.example/app/alerts/settings</a></p>',
    );
  });

  it("an email-only address gets its own sentence and no settings link", () => {
    const mail = renderAlertEmail(message({ addressOnly: true }), options);
    expect(mail.text).toContain("You get this because Green Acres added this address.");
    expect(mail.text).not.toContain("alerts/settings");
    expect(mail.html).not.toContain("alerts/settings");
  });

  it("never makes a link of something that isn't http(s)", () => {
    const mail = renderAlertEmail(message(), { ...options, link: "javascript:alert(1)" });
    expect(mail.html).not.toContain("javascript:");
    expect(mail.text).not.toContain("Open it");
  });

  it("escapes the business name in the html", () => {
    const mail = renderAlertEmail(message({ addressOnly: true }), { ...options, businessName: "Tom & <Jerry>" });
    expect(mail.html).toContain("You get this because Tom &amp; &lt;Jerry&gt; added this address.");
  });
});

describe("breakLinks", () => {
  it("breaks schemes, www. and domains with a path, and leaves street words alone", () => {
    expect(breakLinks("see https://evil.example/pay")).toBe("see https[:]//evil[.]example/pay");
    expect(breakLinks("www.evil.example")).toBe("www[.]evil.example");
    expect(breakLinks("evil.example/pay")).toBe("evil[.]example/pay");
    expect(breakLinks("pay at evil.com")).toBe("pay at evil[.]com");
    expect(breakLinks("12 St. Louis Ave, P.O. Box 12")).toBe("12 St. Louis Ave, P.O. Box 12");
  });

  it("keeps line breaks, and is harmless twice", () => {
    const once = breakLinks("line one\nhttps://evil.example/x");
    expect(once).toBe("line one\nhttps[:]//evil[.]example/x");
    expect(breakLinks(once)).toBe(once);
  });
});
