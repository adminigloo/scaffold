import { describe, expect, it } from "vitest";
import {
  FEEDBACK_EMAIL_TEMPLATES,
  FEEDBACK_TICKET_NEW_KIND,
  FEEDBACK_TICKET_REPLIED_KIND,
  feedbackAlertKinds,
  feedbackAlertsFor,
  feedbackPermissions,
  feedbackReporterEmailFor,
  type FeedbackEvent,
} from "../index.js";

const KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
const HREF = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

const created: FeedbackEvent = {
  type: "ticket.created",
  tenantId: "co-1",
  ticketId: "tk-1",
  ticketNumber: "FB-00012",
  title: "The booking page\nis blank",
  priority: "high",
  category: "bug",
  reporterName: "Pat Rivera",
  reporterEmail: "pat@example.test",
};

describe("alert kinds", () => {
  it("are well-formed, go to whoever can see the board, and default to the app", () => {
    for (const kind of feedbackAlertKinds.kinds) {
      expect(kind.key).toMatch(KEY);
      expect(kind.audience.permission).toBe("feedback.view");
      expect(Object.keys(feedbackPermissions)).toContain(kind.audience.permission);
      expect(kind.audience.routing).toBeUndefined();
      expect(kind.defaultChannel).toBe("in_app");
    }
    expect(feedbackAlertKinds.kinds.map((k) => k.key)).toEqual([FEEDBACK_TICKET_NEW_KIND, FEEDBACK_TICKET_REPLIED_KIND]);
  });

  it("say a new ticket in one line, keyed by the ticket, opening it", () => {
    const [draft] = feedbackAlertsFor(created, { hrefs: { ticket: "/app/feedback?ticket={id}" } });
    expect(draft).toMatchObject({
      kind: FEEDBACK_TICKET_NEW_KIND,
      title: "New feedback FB-00012: The booking page is blank",
      body: "From Pat Rivera",
      href: "/app/feedback?ticket=tk-1",
      dedupeKey: "feedback.ticket.new:tk-1",
      actorUserId: null,
      replyTo: "pat@example.test",
    });
    expect(draft?.href).toMatch(HREF);
  });

  it("key a reply by the reply, so two replies are two alerts and one twice is one", () => {
    const replied = (messageId: string): FeedbackEvent => ({
      type: "reporter.replied",
      tenantId: "co-1",
      ticketId: "tk-1",
      ticketNumber: "FB-00012",
      title: "x",
      messageId,
      excerpt: "Still blank on my phone",
      reporterName: "Pat",
    });
    const [one] = feedbackAlertsFor(replied("m-1"), { hrefs: { ticket: "/admin/feedback?ticket={id}" } });
    const [two] = feedbackAlertsFor(replied("m-2"), { hrefs: { ticket: "/admin/feedback?ticket={id}" } });
    expect(one?.title).toBe("Pat answered on FB-00012");
    expect(one?.dedupeKey).not.toBe(two?.dedupeKey);
  });

  it("raise nothing for what the team did, and open nothing for a pattern that isn't a same-site path", () => {
    const moved: FeedbackEvent = {
      type: "ticket.moved",
      tenantId: "co-1",
      ticketId: "tk-1",
      ticketNumber: "FB-1",
      title: "x",
      fromStatus: "open",
      toStatus: "closed",
      toLabel: "Closed",
      toTerminal: true,
      userId: "u-1",
      reporterName: null,
      reporterEmail: null,
    };
    expect(feedbackAlertsFor(moved, { hrefs: { ticket: "/x/{id}" } })).toEqual([]);
    expect(feedbackAlertsFor(created, { hrefs: { ticket: "//evil.test/{id}" } })[0]?.href).toBeNull();
  });
});

describe("reporter emails", () => {
  it("answer a staff reply with the reply, in the company's name, keyed by the reply", () => {
    const email = feedbackReporterEmailFor(
      {
        type: "staff.replied",
        tenantId: "co-1",
        ticketId: "tk-1",
        ticketNumber: "FB-00012",
        title: "Blank page",
        messageId: "m-9",
        body: "Fixed — try again?",
        staffName: "Ada",
        userId: "u-1",
        reporterName: "Pat",
        reporterEmail: "pat@example.test",
      },
      { businessName: "Green Acres", feedbackUrl: "https://app.test/t/green-acres/feedback" },
    );
    expect(email).toMatchObject({
      to: "pat@example.test",
      templateKey: "feedback_staff_reply",
      idempotencyKey: "feedback-reply:m-9",
      vars: { businessName: "Green Acres", staffName: "Ada", reply: "Fixed — try again?", feedbackUrl: "https://app.test/t/green-acres/feedback" },
    });
  });

  it("tell a reporter their ticket moved, and send nothing to a reporter with no address", () => {
    const moved = (reporterEmail: string | null): FeedbackEvent => ({
      type: "ticket.moved",
      tenantId: "co-1",
      ticketId: "tk-1",
      ticketNumber: "FB-00012",
      title: "Blank page",
      fromStatus: "open",
      toStatus: "resolved",
      toLabel: "Resolved",
      toTerminal: true,
      userId: "u-1",
      reporterName: null,
      reporterEmail,
    });
    expect(feedbackReporterEmailFor(moved("pat@example.test"), { businessName: "Green Acres", feedbackUrl: "https://x" })).toMatchObject({
      templateKey: "feedback_status_changed",
      vars: { statusLabel: "Resolved", reporterName: "there" },
    });
    expect(feedbackReporterEmailFor(moved(null), { businessName: "G", feedbackUrl: "https://x" })).toBeNull();
    expect(feedbackReporterEmailFor(moved("not an address"), { businessName: "G", feedbackUrl: "https://x" })).toBeNull();
    expect(feedbackReporterEmailFor(created, { businessName: "G", feedbackUrl: "https://x" })).toBeNull();
  });

  it("have a template for every key the mapper uses, each naming only variables it is given", () => {
    const keys = FEEDBACK_EMAIL_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(["feedback_staff_reply", "feedback_status_changed", "feedback_team_ticket_reply", "feedback_team_ticket_status"]);
    const given: Record<string, string[]> = {
      feedback_staff_reply: ["businessName", "reporterName", "ticketNumber", "title", "feedbackUrl", "staffName", "reply"],
      feedback_status_changed: ["businessName", "reporterName", "ticketNumber", "title", "feedbackUrl", "statusLabel"],
      // A team-filed ticket's emails never quote the team's own title, nor point at My reports.
      feedback_team_ticket_reply: ["businessName", "reporterName", "ticketNumber", "staffName", "reply"],
      feedback_team_ticket_status: ["businessName", "reporterName", "ticketNumber", "statusLabel"],
    };
    for (const template of FEEDBACK_EMAIL_TEMPLATES) {
      const used = [...`${template.subject} ${template.body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const name of used) expect(given[template.key], `${template.key} uses {{${name}}}`).toContain(name);
    }
  });
});
