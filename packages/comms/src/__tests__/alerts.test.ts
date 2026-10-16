import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMS_MESSAGE_FAILED_KIND,
  commsAlertKinds,
  commsFailureAlert,
  sendNow,
  templateLabel,
  upsertTemplate,
  type CommsAlertDraft,
  type CommsAlertKinds,
  type CommsFailure,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, 12.3: the words, the one alert kind and its mapper.
 *
 * The fragment is checked against notifications' definition rules (4.2)
 * COPIED here as a check: comms never imports @adminigloo/notifications (2a
 * D4), so the package's own test is where a bad key would otherwise first
 * show up, in a project's registry at startup.
 */

// --- 4.2's rules, copied ------------------------------------------------------

const KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
const ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const HREF = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;
/** CR, LF, U+2028, U+2029 (built by code, so no editor turns them into real line breaks). */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LINE_BREAKS = { test: (value: string) => /[\r\n]/.test(value) || value.includes(LS) || value.includes(PS) };

export function fragmentProblems(fragment: CommsAlertKinds): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const kind of fragment.kinds) {
    if (!KIND_KEY.test(kind.key) || kind.key.length > 64) problems.push(`${kind.key}: key`);
    if (keys.has(kind.key)) problems.push(`${kind.key}: duplicate`);
    keys.add(kind.key);
    if (kind.label.length < 1 || kind.label.length > 80) problems.push(`${kind.key}: label`);
    if (kind.category.length < 1 || kind.category.length > 40) problems.push(`${kind.key}: category`);
    if (kind.description !== undefined && kind.description.length > 200) problems.push(`${kind.key}: description`);
    if (!kind.audience.permission) problems.push(`${kind.key}: permission`);
    if (kind.audience.assigned && !kind.audience.assigned.permission) problems.push(`${kind.key}: assigned permission`);
    if (kind.email === false && kind.defaultChannel === "email") problems.push(`${kind.key}: email default on a never-emailed kind`);
    if (kind.email === false && kind.emailBy === "producer") problems.push(`${kind.key}: producer email on a never-emailed kind`);
    if (kind.audience.routing && !fragment.routings.some((r) => r.key === kind.audience.routing)) {
      problems.push(`${kind.key}: routing ${kind.audience.routing} isn't declared`);
    }
  }
  for (const routing of fragment.routings) {
    if (!ROUTING_KEY.test(routing.key)) problems.push(`${routing.key}: routing key`);
    if (!routing.permission) problems.push(`${routing.key}: routing permission`);
  }
  return problems;
}

/** 3.3's rules for a draft. */
export function draftProblems(draft: CommsAlertDraft): string[] {
  const problems: string[] = [];
  if (draft.title.length < 1 || Array.from(draft.title).length > 200) problems.push("title length");
  if (LINE_BREAKS.test(draft.title)) problems.push("title is not one line");
  if (draft.body !== null && Array.from(draft.body).length > 2000) problems.push("body length");
  if (draft.href !== null && !HREF.test(draft.href)) problems.push("href");
  if (draft.dedupeKey.length < 1 || draft.dedupeKey.length > 200) problems.push("dedupe key");
  return problems;
}

describe("templateLabel (moved from comms-widget's words)", () => {
  it("names every template the features send, and the team alert", () => {
    expect(templateLabel("visit_reminder")).toBe("Visit reminder");
    expect(templateLabel("invoice_sent")).toBe("Invoice");
    expect(templateLabel("estimate_lead_staff")).toBe("New lead (to your office)");
    expect(templateLabel("quote_staff_notice")).toBe("Quote answered (to your office)");
    expect(templateLabel("visit_staff_notice")).toBe("New request or change (to your office)");
    expect(templateLabel("team_alert")).toBe("Team alert");
  });

  it("title-cases a key it doesn't know, and never answers blank", () => {
    expect(templateLabel("thank_you_note")).toBe("Thank you note");
    expect(templateLabel("welcome")).toBe("Welcome");
    expect(templateLabel("___")).toBe("___");
  });
});

describe("commsAlertKinds", () => {
  it("passes the registry's definition rules (4.2, copied)", () => {
    expect(fragmentProblems(commsAlertKinds)).toEqual([]);
  });

  it("is the one kind of 12.3's table, never emailed", () => {
    expect(commsAlertKinds.routings).toEqual([]);
    expect(commsAlertKinds.kinds).toHaveLength(1);
    expect(commsAlertKinds.kinds[0]).toMatchObject({
      key: COMMS_MESSAGE_FAILED_KIND,
      label: "An email to a customer doesn't go",
      category: "Messages",
      audience: { permission: "comms.manage" },
      defaultChannel: "in_app",
      email: false,
    });
    expect(COMMS_MESSAGE_FAILED_KIND).toBe("comms.message.failed");
    // No routing, no assigned: everyone who manages messages hears of it.
    expect(commsAlertKinds.kinds[0]!.audience.routing).toBeUndefined();
    expect(commsAlertKinds.kinds[0]!.audience.assigned).toBeUndefined();
  });

  it("is frozen: a project can't edit the package's words in place", () => {
    expect(Object.isFrozen(commsAlertKinds)).toBe(true);
    expect(Object.isFrozen(commsAlertKinds.kinds)).toBe(true);
    expect(Object.isFrozen(commsAlertKinds.kinds[0])).toBe(true);
  });
});

const CUSTOMER = new Set(["visit_reminder", "invoice_sent", "quote_sent"]);

function failure(overrides: Partial<CommsFailure> = {}): CommsFailure {
  return {
    tenantId: "t-1",
    messageId: "0192f0aa-0000-7000-8000-000000000001",
    scheduledId: null,
    channel: "email",
    to: "pat@x.com",
    templateKey: "visit_reminder",
    error: "provider down",
    at: new Date("2026-11-02T15:00:00Z"),
    ...overrides,
  };
}

describe("commsFailureAlert", () => {
  it("reads 'The visit reminder email to … didn't go' (review BO-26)", () => {
    const draft = commsFailureAlert(failure(), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    expect(draft).toEqual({
      tenantId: "t-1",
      kind: "comms.message.failed",
      title: "The visit reminder email to pat@x.com didn't go",
      body: "Open Messages to see what happened.",
      href: "/app/messages",
      dedupeKey: "comms.message.failed:0192f0aa-0000-7000-8000-000000000001",
      subject: { type: "comms.message", id: "0192f0aa-0000-7000-8000-000000000001" },
      actorUserId: null,
    });
    expect(draftProblems(draft!)).toEqual([]);
  });

  it("names the invoice and the quote in lower case, title case kept for lists", () => {
    const invoice = commsFailureAlert(failure({ templateKey: "invoice_sent" }), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    expect(invoice?.title).toBe("The invoice email to pat@x.com didn't go");
    const quote = commsFailureAlert(failure({ templateKey: "quote_sent" }), { href: "/admin/messages", customerTemplateKeys: CUSTOMER });
    expect(quote?.title).toBe("The quote email to pat@x.com didn't go");
    expect(quote?.href).toBe("/admin/messages");
    expect(templateLabel("invoice_sent")).toBe("Invoice");
  });

  it("returns null for a template not in the customer set (an office notice, a team alert)", () => {
    for (const templateKey of ["team_alert", "estimate_lead_staff", "visit_staff_notice", "quote_staff_notice"]) {
      expect(commsFailureAlert(failure({ templateKey }), { href: "/app/messages", customerTemplateKeys: CUSTOMER })).toBeNull();
    }
    expect(commsFailureAlert(failure(), { href: "/app/messages", customerTemplateKeys: new Set() })).toBeNull();
  });

  it("keys a queued message given up with no log row on the queue row (D7)", () => {
    const draft = commsFailureAlert(failure({ messageId: null, scheduledId: "sched-9" }), {
      href: "/app/messages",
      customerTemplateKeys: CUSTOMER,
    });
    expect(draft?.dedupeKey).toBe("comms.message.failed:queued:sched-9");
    expect(draft?.subject).toEqual({ type: "comms.message", id: "sched-9" });
  });

  it("the same failure maps to the same key twice (a replayed onFailed alerts once)", () => {
    const one = commsFailureAlert(failure(), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    const two = commsFailureAlert(failure({ at: new Date() }), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    expect(one?.dedupeKey).toBe(two?.dedupeKey);
  });

  it("keeps the title one line and at most 200 characters, whatever the address", () => {
    const long = `${"a".repeat(240)}@example.com`;
    const draft = commsFailureAlert(failure({ to: long }), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    expect(draftProblems(draft!)).toEqual([]);
    expect(Array.from(draft!.title).length).toBeLessThanOrEqual(200);
    const odd = commsFailureAlert(failure({ templateKey: `visit${LS}reminder`, to: "pat@x.com\r\nBcc: z@x.com" }), {
      href: "/app/messages",
      customerTemplateKeys: new Set([`visit${LS}reminder`]),
    });
    expect(draftProblems(odd!)).toEqual([]);
  });

  it("opens nothing rather than an href that isn't a same-site path (D18)", () => {
    for (const href of ["//evil.example/x", "/\\evil", "https://evil.example", "/app/messages?x= y"]) {
      expect(commsFailureAlert(failure(), { href, customerTemplateKeys: CUSTOMER })?.href).toBeNull();
    }
  });

  it("fills an {id} placeholder with the message, URL-encoded", () => {
    const draft = commsFailureAlert(failure({ messageId: "a b" }), { href: "/app/messages?message={id}", customerTemplateKeys: CUSTOMER });
    expect(draft?.href).toBe("/app/messages?message=a%20b");
  });

  it("calls a text a text", () => {
    const draft = commsFailureAlert(failure({ channel: "sms", to: "+18015551234" }), { href: "/app/messages", customerTemplateKeys: CUSTOMER });
    expect(draft?.title).toBe("The visit reminder text to +18015551234 didn't go");
  });
});

describe("onFailed → commsFailureAlert, end to end (PGlite)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("a failed reminder becomes the alert the glue hands to alerts.notify", async () => {
    const a = tenant("alert");
    await upsertTemplate(t.db, { tenantId: a, key: "visit_reminder", subject: "See you", body: "Hi" });
    const drafts: CommsAlertDraft[] = [];
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "pat@x.com", templateKey: "visit_reminder" },
      {
        email: async () => ({ error: { message: "mailbox full" } }),
        onFailed: (f) => {
          const draft = commsFailureAlert(f, { href: "/app/messages", customerTemplateKeys: CUSTOMER });
          if (draft) drafts.push(draft);
        },
      },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ tenantId: a, dedupeKey: `comms.message.failed:${row.id}`, title: "The visit reminder email to pat@x.com didn't go" });
  });
});
