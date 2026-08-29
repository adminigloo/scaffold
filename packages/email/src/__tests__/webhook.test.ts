import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import {
  DeliveryWebhookNotConfiguredError,
  DeliveryWebhookVerificationError,
  MalformedDeliveryEventError,
  mapDeliveryStatus,
  deliveryStatusRank,
  shouldApplyDeliveryStatus,
  verifyDeliveryWebhook,
  type DeliveryEventType,
} from "../webhook.js";
import type { EmailStatus } from "../schema.js";

// A real svix secret, so these tests exercise genuine signature verification.
// A mocked `Webhook` would pass even if the verification were deleted, which
// is the one thing this file has to prove is still there.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function signed(payload: unknown, id = "msg_test_1", at: Date = new Date()) {
  const body = JSON.stringify(payload);
  const signature = new Webhook(SECRET).sign(id, at, body);
  return {
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": signature,
    },
  };
}

const OCCURRED = "2026-08-28T10:00:00.000Z";

function event(type: string, data: Record<string, unknown> = {}) {
  return {
    type,
    created_at: OCCURRED,
    data: {
      email_id: "6c1a2f0e-0000-4000-8000-000000000001",
      to: ["customer@example.com"],
      from: "Riddler Go <hello@riddlergo.com>",
      subject: "Your receipt",
      ...data,
    },
  };
}

describe("verifyDeliveryWebhook — an unset secret", () => {
  // Without a signing secret the route cannot tell a real bounce from anyone
  // on the internet POSTing JSON at the URL. Since a bounce suppresses an
  // address, trusting the payload hands a stranger a button that cuts a
  // specific customer off from their own password resets.
  const unsigned = JSON.stringify(event("email.bounced"));

  it("REFUSES rather than trusting the payload", () => {
    expect(() => verifyDeliveryWebhook(unsigned, {}, undefined)).toThrow(
      DeliveryWebhookNotConfiguredError,
    );
  });

  it("refuses null, empty and whitespace secrets alike", () => {
    for (const secret of [null, "", "   "]) {
      expect(() => verifyDeliveryWebhook(unsigned, {}, secret)).toThrow(
        DeliveryWebhookNotConfiguredError,
      );
    }
  });

  it("refuses even a genuinely signed request, since it cannot check it", () => {
    // No bypass: the absence of a secret is not evidence about the request.
    const { body, headers } = signed(event("email.bounced"));
    expect(() => verifyDeliveryWebhook(body, headers, "")).toThrow(
      DeliveryWebhookNotConfiguredError,
    );
  });

  it("does not return null, which a route would read as 'nothing to do'", () => {
    // The distinction that matters. `null` means an event we do not act on,
    // and the route answers 200 to it. An unconfigured route answering 200 to
    // forged bounces looks healthy forever.
    let threw = false;
    try {
      verifyDeliveryWebhook(unsigned, {}, undefined);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("verifyDeliveryWebhook — verification", () => {
  it("normalises a delivered event", () => {
    const { body, headers } = signed(event("email.delivered"));
    expect(verifyDeliveryWebhook(body, headers, SECRET)).toEqual({
      id: "msg_test_1",
      type: "email.delivered",
      messageId: "6c1a2f0e-0000-4000-8000-000000000001",
      recipient: "customer@example.com",
      occurredAt: new Date(OCCURRED),
    });
  });

  it("normalises a bounce and a complaint", () => {
    for (const type of ["email.bounced", "email.complained"] as const) {
      const { body, headers } = signed(event(type));
      expect(verifyDeliveryWebhook(body, headers, SECRET)?.type).toBe(type);
    }
  });

  it("rejects a tampered body", () => {
    const { body, headers } = signed(event("email.bounced"));
    const tampered = body.replace("customer@example.com", "victim@example.com");
    expect(() => verifyDeliveryWebhook(tampered, headers, SECRET)).toThrow(
      DeliveryWebhookVerificationError,
    );
  });

  it("rejects a payload signed with a different secret", () => {
    const { body, headers } = signed(event("email.bounced"));
    expect(() =>
      verifyDeliveryWebhook(body, headers, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toThrow(DeliveryWebhookVerificationError);
  });

  it("rejects a replay from outside the signing window", () => {
    // svix enforces a ~5 minute tolerance. Worth asserting rather than
    // assuming: without it a captured request stays valid forever.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const { body, headers } = signed(event("email.bounced"), "msg_stale", stale);
    expect(() => verifyDeliveryWebhook(body, headers, SECRET)).toThrow(
      DeliveryWebhookVerificationError,
    );
  });

  it("uses the svix id, which is stable across the provider's retries", () => {
    // Not `email_id`: that repeats across delivered-then-bounced for one
    // message, so deduplicating on it would drop the second event.
    const { body, headers } = signed(event("email.delivered"), "msg_retry_7");
    expect(verifyDeliveryWebhook(body, headers, SECRET)?.id).toBe("msg_retry_7");
  });
});

describe("verifyDeliveryWebhook — events we do not act on", () => {
  const ignored = [
    "email.sent",
    "email.delivery_delayed",
    "email.opened",
    "contact.created",
    "",
  ];

  for (const type of ignored) {
    it(`returns null for ${JSON.stringify(type)}`, () => {
      const { body, headers } = signed(event(type));
      expect(verifyDeliveryWebhook(body, headers, SECRET)).toBeNull();
    });
  }

  it("returns null rather than throwing on a payload with no type at all", () => {
    const { body, headers } = signed({ data: { email_id: "x" } });
    expect(verifyDeliveryWebhook(body, headers, SECRET)).toBeNull();
  });

  it("does not treat email.sent as delivery", () => {
    // We already wrote `sent` ourselves when the provider accepted the
    // message. Acting on it again would move a row that had since bounced
    // back to `sent`, because webhook delivery is not ordered.
    const { body, headers } = signed(event("email.sent"));
    expect(verifyDeliveryWebhook(body, headers, SECRET)).toBeNull();
  });
});

describe("verifyDeliveryWebhook — a verified event that makes no sense", () => {
  // Loud, not null. A real bounce landing in the "we do not act on this"
  // branch keeps a dead address on the list, and that is how a sending
  // domain's reputation goes — one unnoticed hard bounce at a time.
  it("throws when a handled event carries no email_id", () => {
    const { body, headers } = signed(event("email.bounced", { email_id: undefined }));
    expect(() => verifyDeliveryWebhook(body, headers, SECRET)).toThrow(
      MalformedDeliveryEventError,
    );
  });

  it("throws when a handled event carries no recipient", () => {
    const { body, headers } = signed(event("email.bounced", { to: [] }));
    expect(() => verifyDeliveryWebhook(body, headers, SECRET)).toThrow(
      MalformedDeliveryEventError,
    );
  });

  it("throws when the recipient is not a string", () => {
    const { body, headers } = signed(event("email.bounced", { to: [{ email: "x" }] }));
    expect(() => verifyDeliveryWebhook(body, headers, SECRET)).toThrow(
      MalformedDeliveryEventError,
    );
  });

  it("throws when `data` is missing entirely", () => {
    const { body, headers } = signed({ type: "email.bounced", created_at: OCCURRED });
    expect(() => verifyDeliveryWebhook(body, headers, SECRET)).toThrow(
      MalformedDeliveryEventError,
    );
  });

  it("accepts a single recipient sent as a bare string", () => {
    // Providers have shipped both shapes. Neither is wrong enough to drop a
    // bounce over.
    const { body, headers } = signed(event("email.bounced", { to: "a@x.com" }));
    expect(verifyDeliveryWebhook(body, headers, SECRET)?.recipient).toBe("a@x.com");
  });
});

describe("verifyDeliveryWebhook — occurredAt", () => {
  it("prefers the event's own timestamp", () => {
    const { body, headers } = signed(event("email.delivered"));
    expect(verifyDeliveryWebhook(body, headers, SECRET)?.occurredAt).toEqual(
      new Date(OCCURRED),
    );
  });

  it("falls back to the timestamp inside data", () => {
    const inner = "2026-08-28T09:59:00.000Z";
    const { body, headers } = signed({
      type: "email.delivered",
      data: {
        email_id: "id_1",
        to: ["a@x.com"],
        created_at: inner,
      },
    });
    expect(verifyDeliveryWebhook(body, headers, SECRET)?.occurredAt).toEqual(
      new Date(inner),
    );
  });

  it("never returns an Invalid Date", () => {
    // An unparseable timestamp would otherwise reach the driver as a Date with
    // a NaN time, which Postgres rejects — turning one malformed field into a
    // 500, which makes the provider retry the same malformed event for days.
    const { body, headers } = signed({
      type: "email.delivered",
      created_at: "last Tuesday",
      data: { email_id: "id_1", to: ["a@x.com"], created_at: "also not a date" },
    });
    const occurredAt = verifyDeliveryWebhook(body, headers, SECRET)?.occurredAt;
    expect(occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(occurredAt?.getTime() ?? NaN)).toBe(false);
  });

  it("uses the signed svix timestamp when the payload has no usable one", () => {
    // Truncated to whole seconds, and recent, because the header carries
    // seconds and svix refuses a signature outside its replay window.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const { body, headers } = signed(
      { type: "email.delivered", data: { email_id: "id_1", to: ["a@x.com"] } },
      "msg_ts",
      at,
    );
    expect(verifyDeliveryWebhook(body, headers, SECRET)?.occurredAt).toEqual(at);
  });
});

describe("mapDeliveryStatus", () => {
  it("maps each event to the column value it writes", () => {
    expect(mapDeliveryStatus("email.delivered")).toBe("delivered");
    expect(mapDeliveryStatus("email.bounced")).toBe("bounced");
    expect(mapDeliveryStatus("email.complained")).toBe("complained");
  });

  it("never maps an inbound event back to a status we wrote ourselves", () => {
    // `sent` and `skipped` are ours. A webhook rewriting a row to either of
    // them would erase what we know about a message the provider is telling us
    // failed.
    const ours = ["queued", "sent", "skipped", "failed"];
    const types: DeliveryEventType[] = [
      "email.delivered",
      "email.bounced",
      "email.complained",
    ];
    for (const type of types) {
      expect(ours).not.toContain(mapDeliveryStatus(type));
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering. svix retries at 5s / 5m / 30m, so the order these events are
// generated in is not the order a route sees them in. Every pair below is
// therefore exercised in BOTH arrival orders and has to settle on the same
// status either way — that is the entire property being defended.
// ---------------------------------------------------------------------------

const ALL_STATUSES: EmailStatus[] = [
  "queued",
  "sent",
  "skipped",
  "delivered",
  "bounced",
  "complained",
  "failed",
];

const WEBHOOK_STATUSES: EmailStatus[] = ["delivered", "bounced", "complained"];

const EARLY = new Date("2026-08-28T10:00:00.000Z");
const LATE = new Date("2026-08-28T10:30:00.000Z");

/**
 * Feed two events to a fresh row in the given arrival order and report where it
 * ends up — i.e. exactly what a route does, one UPDATE at a time.
 */
function settle(
  first: { status: EmailStatus; at: Date },
  second: { status: EmailStatus; at: Date },
  start: EmailStatus = "sent",
): EmailStatus {
  let status = start;
  let at = new Date(0);
  for (const incoming of [first, second]) {
    if (
      shouldApplyDeliveryStatus(status, incoming.status, {
        currentOccurredAt: at,
        incomingOccurredAt: incoming.at,
      })
    ) {
      status = incoming.status;
      at = incoming.at;
    }
  }
  return status;
}

describe("deliveryStatusRank", () => {
  it("puts the terminal negative outcomes above delivered", () => {
    // The bug this exists for: 'delivered' outranking a real bounce leaves the
    // address looking healthy while the domain is rejecting our mail.
    expect(deliveryStatusRank("bounced")).toBeGreaterThan(
      deliveryStatusRank("delivered"),
    );
    expect(deliveryStatusRank("complained")).toBeGreaterThan(
      deliveryStatusRank("delivered"),
    );
  });

  it("puts delivered above the statuses we wrote before the provider replied", () => {
    expect(deliveryStatusRank("delivered")).toBeGreaterThan(deliveryStatusRank("sent"));
    expect(deliveryStatusRank("sent")).toBeGreaterThan(deliveryStatusRank("queued"));
  });

  it("ranks bounced and complained equally", () => {
    // Neither is more final. Both mean stop mailing this address, so the tie is
    // broken on time rather than on an invented hierarchy.
    expect(deliveryStatusRank("complained")).toBe(deliveryStatusRank("bounced"));
  });

  it("puts skipped and failed above everything a webhook can produce", () => {
    // Those rows have a null message_id — nothing was dispatched — so the
    // webhook's only lookup key cannot reach them. An event that appears to is
    // a bad join, and honouring it erases the proof the mail never went out.
    for (const local of ["skipped", "failed"] as const) {
      for (const incoming of WEBHOOK_STATUSES) {
        expect(deliveryStatusRank(local)).toBeGreaterThan(deliveryStatusRank(incoming));
      }
    }
  });
});

describe("shouldApplyDeliveryStatus — the out-of-order bounce", () => {
  it("refuses a late 'delivered' over a 'bounced'", () => {
    // The exact failure: the bounce POST 500s, svix redelivers the delivered
    // event 30 minutes later, and applying it in arrival order marks a dead
    // address healthy.
    expect(
      shouldApplyDeliveryStatus("bounced", "delivered", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: LATE,
      }),
    ).toBe(false);
  });

  it("refuses a late 'delivered' over a 'complained'", () => {
    expect(
      shouldApplyDeliveryStatus("complained", "delivered", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: LATE,
      }),
    ).toBe(false);
  });

  it("still lets a bounce land on a row that says delivered", () => {
    expect(
      shouldApplyDeliveryStatus("delivered", "bounced", {
        currentOccurredAt: LATE,
        incomingOccurredAt: EARLY,
      }),
    ).toBe(true);
  });

  it("reaches the same status whichever order the pair arrives in", () => {
    for (const a of WEBHOOK_STATUSES) {
      for (const b of WEBHOOK_STATUSES) {
        const forward = settle({ status: a, at: EARLY }, { status: b, at: LATE });
        const reverse = settle({ status: b, at: LATE }, { status: a, at: EARLY });
        expect(`${a} then ${b}: ${reverse}`).toBe(`${a} then ${b}: ${forward}`);
      }
    }
  });

  it("never settles on 'delivered' when a bounce or complaint was in the pair", () => {
    for (const negative of ["bounced", "complained"] as const) {
      // Both generation orders, and both arrival orders of each.
      for (const [negativeAt, deliveredAt] of [
        [EARLY, LATE],
        [LATE, EARLY],
      ] as const) {
        const negativeFirst = settle(
          { status: negative, at: negativeAt },
          { status: "delivered", at: deliveredAt },
        );
        const deliveredFirst = settle(
          { status: "delivered", at: deliveredAt },
          { status: negative, at: negativeAt },
        );
        expect([negativeFirst, deliveredFirst]).toEqual([negative, negative]);
      }
    }
  });
});

describe("shouldApplyDeliveryStatus — equal ranks", () => {
  it("prefers the later occurredAt between a bounce and a complaint", () => {
    expect(
      shouldApplyDeliveryStatus("bounced", "complained", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: LATE,
      }),
    ).toBe(true);
    expect(
      shouldApplyDeliveryStatus("complained", "bounced", {
        currentOccurredAt: LATE,
        incomingOccurredAt: EARLY,
      }),
    ).toBe(false);
  });

  it("keeps what is written on an exact tie", () => {
    // Two events stamped the same instant must settle identically in both
    // arrival orders; a tiebreak favouring the incoming one would make the
    // final status depend on which POST svix happened to land first.
    expect(
      shouldApplyDeliveryStatus("bounced", "complained", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: EARLY,
      }),
    ).toBe(false);
    expect(
      shouldApplyDeliveryStatus("complained", "bounced", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: EARLY,
      }),
    ).toBe(false);
  });

  it("makes a redelivery of the same event a no-op", () => {
    // svix retries the identical notification up to three times, each carrying
    // the same occurredAt, so only the first should write.
    expect(
      shouldApplyDeliveryStatus("delivered", "delivered", {
        currentOccurredAt: EARLY,
        incomingOccurredAt: EARLY,
      }),
    ).toBe(false);
  });

  it("keeps what is written when a timestamp is missing or unparseable", () => {
    // The current timestamp comes off a database row, so it can be null. An
    // ordering we cannot prove must not licence an overwrite.
    for (const order of [
      { currentOccurredAt: null, incomingOccurredAt: LATE },
      { currentOccurredAt: EARLY, incomingOccurredAt: undefined },
      { currentOccurredAt: new Date("nonsense"), incomingOccurredAt: LATE },
      { currentOccurredAt: EARLY, incomingOccurredAt: new Date("nonsense") },
      {},
    ]) {
      expect(shouldApplyDeliveryStatus("bounced", "complained", order)).toBe(false);
    }
  });

  it("still lets rank decide when no timestamp is available", () => {
    // Rank is not a tiebreak, it is the rule. A bounce with no usable time
    // still beats a row that says delivered.
    expect(shouldApplyDeliveryStatus("delivered", "bounced", {})).toBe(true);
    expect(shouldApplyDeliveryStatus("bounced", "delivered", {})).toBe(false);
  });
});

describe("shouldApplyDeliveryStatus — rows a webhook cannot own", () => {
  it("never supersedes 'skipped'", () => {
    // A skipped row has message_id null: nothing was dispatched, so no
    // delivery event can legitimately match it. Overwriting one destroys the
    // only record that says the mail never went out — the row somebody is
    // reading when they ask why the customer got nothing.
    for (const incoming of WEBHOOK_STATUSES) {
      expect(
        shouldApplyDeliveryStatus("skipped", incoming, {
          currentOccurredAt: EARLY,
          incomingOccurredAt: LATE,
        }),
      ).toBe(false);
    }
  });

  it("never supersedes 'failed'", () => {
    for (const incoming of WEBHOOK_STATUSES) {
      expect(
        shouldApplyDeliveryStatus("failed", incoming, {
          currentOccurredAt: EARLY,
          incomingOccurredAt: LATE,
        }),
      ).toBe(false);
    }
  });

  it("applies to a row that has no status yet", () => {
    expect(shouldApplyDeliveryStatus(null, "bounced")).toBe(true);
    expect(shouldApplyDeliveryStatus(undefined, "delivered")).toBe(true);
  });
});

describe("shouldApplyDeliveryStatus — every pair, both arrival orders", () => {
  it("is antisymmetric: at most one direction of a pair may apply", () => {
    // If both directions applied, two events would flip the row back and forth
    // forever depending on which retry landed last.
    for (const a of ALL_STATUSES) {
      for (const b of ALL_STATUSES) {
        const forward = shouldApplyDeliveryStatus(a, b, {
          currentOccurredAt: EARLY,
          incomingOccurredAt: LATE,
        });
        const reverse = shouldApplyDeliveryStatus(b, a, {
          currentOccurredAt: LATE,
          incomingOccurredAt: EARLY,
        });
        expect(`${a} vs ${b}: ${String(forward && reverse)}`).toBe(`${a} vs ${b}: false`);
      }
    }
  });

  it("follows the ranking on every pair a webhook can deliver", () => {
    for (const current of ALL_STATUSES) {
      for (const incoming of WEBHOOK_STATUSES) {
        const applied = shouldApplyDeliveryStatus(current, incoming, {
          currentOccurredAt: EARLY,
          incomingOccurredAt: LATE,
        });
        // The incoming event is the later one here, so equal ranks apply too.
        const expected =
          deliveryStatusRank(incoming) >= deliveryStatusRank(current);
        expect(`${current} -> ${incoming}: ${String(applied)}`).toBe(
          `${current} -> ${incoming}: ${String(expected)}`,
        );
      }
    }
  });
});

describe("mapDeliveryStatus feeds the guard", () => {
  it("keeps the bounce when a verified pair arrives in either order", () => {
    // End to end through the parser, because that is where occurredAt actually
    // comes from.
    const bounce = verifyDeliveryWebhook(
      ...signedEvent("email.bounced", "2026-08-28T10:00:00.000Z", "msg_b"),
    );
    const delivered = verifyDeliveryWebhook(
      ...signedEvent("email.delivered", "2026-08-28T10:30:00.000Z", "msg_d"),
    );
    if (bounce === null || delivered === null) throw new Error("expected two events");

    for (const arrival of [
      [bounce, delivered],
      [delivered, bounce],
    ]) {
      let status: EmailStatus = "sent";
      let at = new Date(0);
      for (const received of arrival) {
        const incoming = mapDeliveryStatus(received.type);
        if (
          shouldApplyDeliveryStatus(status, incoming, {
            currentOccurredAt: at,
            incomingOccurredAt: received.occurredAt,
          })
        ) {
          status = incoming;
          at = received.occurredAt;
        }
      }
      expect(status).toBe("bounced");
    }
  });
});

function signedEvent(
  type: string,
  createdAt: string,
  id: string,
): [string, Record<string, string>, string] {
  const { body, headers } = signed({ ...event(type), created_at: createdAt }, id);
  return [body, headers, SECRET];
}
