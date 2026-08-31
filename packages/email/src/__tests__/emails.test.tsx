import { describe, expect, it } from "vitest";
import {
  InvitationEmail,
  invitationPlainText,
  invitationSubject,
  renderEmailHtml,
  renderInvitationEmail,
  type InvitationEmailProps,
} from "../emails.js";

/**
 * The invitation template.
 *
 * The assertions worth having here are the ones a reviewer cannot make by
 * reading: that a customer-typed organisation name cannot become markup, that
 * both bodies exist and agree about the URL, and that the token-bearing link is
 * printed in full rather than hidden behind anchor text a filter will read as
 * phishing.
 */

const BASE: InvitationEmailProps = {
  tenantName: "Northwind Trading",
  invitedBy: "ada@example.com",
  roleName: "Admin",
  url: "https://app.example.com/invite/Xy9-token_value",
  expiresAt: new Date("2026-03-08T12:00:00.000Z"),
  productName: "Verify App",
};

describe("renderInvitationEmail", () => {
  it("produces a subject, an HTML document and a plain-text part", () => {
    const message = renderInvitationEmail(BASE);

    expect(message.subject).toBe("ada@example.com invited you to Northwind Trading");
    // A message with no text part scores as spam at most providers, and the
    // first symptom is not a broken layout — it is an invitation nobody saw.
    expect(message.text.length).toBeGreaterThan(0);
    // Quirks mode without it, which reinterprets the table widths the whole
    // layout rests on.
    expect(message.html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("prints the full URL in both bodies", () => {
    const message = renderInvitationEmail(BASE);

    expect(message.text).toContain(BASE.url);
    // Twice in the HTML: the button's href and the visible fallback. A link
    // whose label and target differ is the strongest phishing signal a filter
    // looks for, and this message has to be delivered.
    expect(message.html).toContain(`href="${BASE.url}"`);
    expect(message.html).toContain(">https://app.example.com/invite/Xy9-token_value<");
  });

  it("cannot be turned into markup by an organisation name", () => {
    // THE REASON THIS IS REACT EMAIL AND NOT A TEMPLATE STRING. An organisation
    // name is typed by a customer and lands in a document sent from our own
    // authenticated domain. The previous implementation escaped by hand at
    // every interpolation, which is correct until one is forgotten.
    const message = renderInvitationEmail({
      ...BASE,
      tenantName: '<img src=x onerror="alert(1)">',
      invitedBy: "</td></tr><script>steal()</script>",
    });

    expect(message.html).not.toContain("<img src=x");
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;img src=x");
  });

  it("cannot be given a javascript: destination that renders as a link", () => {
    const message = renderInvitationEmail({
      ...BASE,
      url: 'javascript:alert(1)"><script>x()</script>',
    });

    expect(message.html).not.toContain("<script>");
  });

  it("says the link does not expire when there is no expiry", () => {
    const props = { ...BASE, expiresAt: null };

    expect(invitationPlainText(props)).toContain("This link does not expire.");
    expect(renderInvitationEmail(props).html).toContain("This link does not expire.");
  });

  it("formats the expiry in UTC, matching the row it came from", () => {
    expect(invitationPlainText(BASE)).toContain("8 March 2026");
  });

  it("names an unknown sender rather than leaving a gap", () => {
    const props = { ...BASE, invitedBy: null };

    expect(invitationSubject(props)).toBe("Someone invited you to Northwind Trading");
    expect(invitationPlainText(props)).toContain("Someone has invited you");
  });

  it("picks the article from the role name", () => {
    expect(invitationPlainText(BASE)).toContain("as an Admin");
    expect(invitationPlainText({ ...BASE, roleName: "Member" })).toContain("as a Member");
  });
});

describe("renderEmailHtml", () => {
  it("renders any template synchronously, with no promise to await", () => {
    // Synchronous on purpose: the one call site composes a message inside a
    // function whose signature is fixed, and @react-email/render's `render`
    // returns a promise so that it can pretty-print — which no inbox reads.
    const html: string = renderEmailHtml(<InvitationEmail {...BASE} />);

    expect(typeof html).toBe("string");
    expect(html).toContain("Northwind Trading");
  });
});
