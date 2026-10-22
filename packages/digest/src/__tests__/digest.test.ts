import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDigestHandlers } from "../handlers.js";
import { html } from "../html.js";
import { createDigests, type DigestOutgoing, type Digests, type DigestSendOutcome } from "../instance.js";
import { defineEmailKinds, type DigestPerson } from "../registry.js";
import { signUnsubscribe } from "../tokens.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * The digest on a real Postgres: each person's digest at their own hour in
 * their own zone, once a day however often the run is replayed, nothing
 * until they say yes, "skipped" (never "failed") with no provider, one-click
 * unsubscribe by the header and by the link, another person's link refused,
 * and the preview staff-only and never sent.
 */

const SECRET = "test-secret-for-unsubscribe-links-000000";
const BASE = "https://alma.example.com";

let t: TestDb;
let now = new Date("2026-10-21T12:30:00Z");
let sent: DigestOutgoing[] = [];
let answer: (message: DigestOutgoing) => DigestSendOutcome = () => ({ status: "sent" });
let reported: { step: string }[] = [];
let people: Record<string, DigestPerson> = {};

const kinds = defineEmailKinds({
  digests: [
    {
      key: "morning",
      title: "Morning summary",
      description: "Yesterday's results and today's window.",
      sections: [
        {
          key: "results",
          render: (person, day) =>
            person.userId === "user_quiet"
              ? null
              : { title: `Results for ${day.label}`, text: `Hello ${person.name ?? "there"}, it is ${day.date} in ${person.timeZone}.`, html: html`<p>Hello ${person.name}, <b>${day.date}</b></p>` },
        },
        {
          key: "broken",
          render: (person) => {
            if (person.userId === "user_broken") throw new Error("the weather feed is down");
            return null;
          },
        },
      ],
    },
  ],
  alerts: [{ key: "price-alerts", title: "Price alerts", description: "When a price crosses your line." }],
});

function instance(overrides: { idempotentSends?: boolean; sendIntervalMs?: number } = {}): Digests {
  return createDigests({
    db: t.db,
    tables: t.tables,
    kinds,
    people: async (ids) => ids.flatMap((id) => (people[id] ? [people[id]!] : [])),
    send: async (message) => {
      sent.push(message);
      return answer(message);
    },
    idempotentSends: overrides.idempotentSends ?? true,
    siteName: "Alma",
    siteTimeZone: "America/New_York",
    secret: SECRET,
    baseUrl: BASE,
    sendIntervalMs: overrides.sendIntervalMs ?? 0,
    now: () => now,
    sleep: async () => {},
    onError: (_error, context) => reported.push(context),
  });
}

function person(userId: string, name: string): DigestPerson {
  return { userId, email: `${userId}@example.com`, name };
}

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.client.exec(`DELETE FROM digest_sends; DELETE FROM digest_subscriptions; DELETE FROM digest_preferences;`);
  now = new Date("2026-10-21T12:30:00Z");
  sent = [];
  reported = [];
  answer = () => ({ status: "sent" });
  people = {
    user_ann: person("user_ann", "Ann"),
    user_bo: person("user_bo", "Bo"),
    user_cy: person("user_cy", "Cy"),
  };
});

async function subscribeBoth(digests: Digests) {
  // Ann in Chicago at 7 AM; Bo in Tokyo at 7 AM. Cy never says yes.
  await digests.savePreferences("user_ann", { timeZone: "America/Chicago", deliveryHour: 7, choices: { morning: true } });
  await digests.savePreferences("user_bo", { timeZone: "Asia/Tokyo", deliveryHour: 7, choices: { morning: true } });
  await digests.savePreferences("user_cy", { timeZone: "Europe/London" });
}

describe("two people in different zones", () => {
  it("each gets one email for their own local day, at or after their own hour", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    // 12:30 UTC: 7:30 AM in Chicago (Oct 21's window open), 9:30 PM in Tokyo
    // (still Oct 21's window, opened at 7 AM there).
    const result = await digests.run();
    expect(result.stoppedEarly).toBe(false);
    expect(result.digests[0]).toMatchObject({ key: "morning", subscribed: 2, due: 2, sent: 2, waiting: 0 });
    const byPerson = Object.fromEntries(sent.map((message) => [message.userId, message]));
    expect(Object.keys(byPerson).sort()).toEqual(["user_ann", "user_bo"]);
    expect(byPerson.user_ann?.text).toContain("it is 2026-10-21 in America/Chicago");
    expect(byPerson.user_bo?.text).toContain("it is 2026-10-21 in Asia/Tokyo");
    expect(byPerson.user_ann?.subject).toBe("Morning summary: Wednesday, October 21");
  });

  it("before a person's hour, nothing new: their previous day's email already went", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await digests.run();
    sent = [];
    // 23:00 UTC: 6 PM in Chicago (Oct 21 already sent); 8 AM Oct 22 in Tokyo: Bo's next day.
    now = new Date("2026-10-21T23:00:00Z");
    await digests.run();
    expect(sent.map((message) => [message.userId, message.text.match(/it is (\S+)/)?.[1]])).toEqual([["user_bo", "2026-10-22"]]);
    // 12:30 UTC the next day: Ann's Oct 22 (Bo's Oct 22 is done).
    sent = [];
    now = new Date("2026-10-22T12:30:00Z");
    await digests.run();
    expect(sent.map((message) => [message.userId, message.text.match(/it is (\S+)/)?.[1]])).toEqual([["user_ann", "2026-10-22"]]);
  });

  it("an hour later in the person's zone means an hour later: Ann at 9 AM is not due at 8", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { timeZone: "America/Chicago", deliveryHour: 9, choices: { morning: true } });
    // The window open at 8 AM Oct 21 is Oct 20's (it closes at 9), a day
    // before she said yes: nothing yet.
    now = new Date("2026-10-21T13:00:00Z");
    await digests.run();
    expect(sent).toEqual([]);
    now = new Date("2026-10-21T14:00:00Z"); // 9 AM CDT
    await digests.run();
    expect(sent.map((message) => message.text.match(/it is (\S+)/)?.[1])).toEqual(["2026-10-21"]);
  });

  it("someone who says yes before their hour gets that day's at their hour, not the day before's now and that day's within the hour", async () => {
    const digests = instance();
    // 5:30 AM in Chicago on Oct 21. The window open is still Oct 20's (it
    // closes at 7), which would have gone now, and Oct 21's at 7: two
    // emails in one morning for someone who just ticked the box.
    now = new Date("2026-10-21T10:30:00Z");
    await digests.savePreferences("user_ann", { timeZone: "America/Chicago", deliveryHour: 7, choices: { morning: true } });
    expect((await digests.run()).digests[0]).toMatchObject({ subscribed: 1, due: 0, sent: 0 });
    now = new Date("2026-10-21T12:05:00Z"); // 7:05 AM CDT
    await digests.run();
    now = new Date("2026-10-21T13:05:00Z");
    await digests.run();
    expect(sent.map((message) => message.text.match(/it is (\S+)/)?.[1])).toEqual(["2026-10-21"]);
  });

  it("someone who says yes after their hour still gets that day's at once", async () => {
    const digests = instance();
    now = new Date("2026-10-21T15:00:00Z"); // 10 AM CDT: Oct 21's window is open
    await digests.savePreferences("user_ann", { timeZone: "America/Chicago", deliveryHour: 7, choices: { morning: true } });
    await digests.run();
    expect(sent.map((message) => message.text.match(/it is (\S+)/)?.[1])).toEqual(["2026-10-21"]);
  });

  it("a person with no zone of their own runs on the site's", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { choices: { morning: true } });
    expect((await digests.preferencesOf("user_ann")).timeZoneSource).toBe("site");
    await digests.run();
    expect(sent[0]?.text).toContain("in America/New_York");
  });
});

describe("the replay", () => {
  it("running the cron again sends nobody anything", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await digests.run();
    const first = sent.length;
    const again = await digests.run();
    const third = await digests.run();
    expect(first).toBe(2);
    expect(sent).toHaveLength(2);
    expect(again.digests[0]).toMatchObject({ subscribed: 2, due: 0, sent: 0 });
    expect(third.digests[0]).toMatchObject({ due: 0, sent: 0 });
  });

  it("two runs at once still send each person one", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await Promise.all([digests.run(), digests.run(), digests.run()]);
    expect(sent.map((message) => message.userId).sort()).toEqual(["user_ann", "user_bo"]);
  });

  it("a failure the provider may take later is tried again, with the same idempotency key", async () => {
    const digests = instance({ idempotentSends: true });
    await subscribeBoth(digests);
    answer = (message) => (message.userId === "user_ann" ? { status: "failed", error: "429 slow down", retryable: true } : { status: "sent" });
    await digests.run();
    const firstKey = sent.find((message) => message.userId === "user_ann")?.idempotencyKey;
    answer = () => ({ status: "sent" });
    sent = [];
    await digests.run(); // before its next try
    expect(sent).toHaveLength(0);
    now = new Date(now.getTime() + 6 * 60_000);
    await digests.run();
    expect(sent.map((message) => message.userId)).toEqual(["user_ann"]);
    expect(sent[0]?.idempotencyKey).toBe(firstKey);
    expect(reported.some((context) => context.step === "send")).toBe(true);
  });

  it("without idempotent sends a failure is tried once and never again", async () => {
    const digests = instance({ idempotentSends: false });
    await subscribeBoth(digests);
    answer = () => ({ status: "failed", error: "500", retryable: true });
    await digests.run();
    answer = () => ({ status: "sent" });
    sent = [];
    now = new Date(now.getTime() + 60 * 60_000);
    await digests.run();
    expect(sent).toHaveLength(0);
  });

  it("stops before its time runs out and says who is still waiting", async () => {
    const digests = instance({ sendIntervalMs: 0 });
    await subscribeBoth(digests);
    const result = await digests.run({ timeBudgetMs: 5_000 }); // less than one send and the margin
    expect(result.stoppedEarly).toBe(true);
    expect(result.digests[0]).toMatchObject({ due: 2, sent: 0, waiting: 2 });
    expect(sent).toHaveLength(0);
    const later = await digests.run();
    expect(later.digests[0]).toMatchObject({ sent: 2, waiting: 0 });
  });
});

describe("nothing until a person says yes", () => {
  it("someone who never chose a digest gets none", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await digests.run();
    expect(sent.some((message) => message.userId === "user_cy")).toBe(false);
    expect((await digests.preferencesOf("user_cy")).choices).toEqual({ morning: false, "price-alerts": false });
  });

  it("a day where every section has nothing to say sends nothing, and says so on the ledger", async () => {
    const digests = instance();
    people.user_quiet = person("user_quiet", "Quiet");
    await digests.savePreferences("user_quiet", { choices: { morning: true } });
    const result = await digests.run();
    expect(result.digests[0]).toMatchObject({ empty: 1, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("a section that throws is left out and reported; the rest still go", async () => {
    const digests = instance();
    people.user_broken = person("user_broken", "Broken");
    await digests.savePreferences("user_broken", { choices: { morning: true } });
    await digests.run();
    expect(sent).toHaveLength(1);
    expect(reported).toContainEqual(expect.objectContaining({ step: "section:broken" }));
  });

  it("a person who is gone (deleted, suspended, no address) is sent nothing and nothing is written", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    delete people.user_bo;
    await digests.run();
    expect(sent.map((message) => message.userId)).toEqual(["user_ann"]);
    people.user_bo = person("user_bo", "Bo");
    await digests.run();
    expect(sent.map((message) => message.userId)).toEqual(["user_ann", "user_bo"]);
  });
});

describe("no email provider configured", () => {
  it("is skipped: recorded once, never failed, never reported, never retried", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    answer = () => ({ status: "skipped", reason: "no-transport" });
    const result = await digests.run();
    expect(result.digests[0]).toMatchObject({ skipped: 2, failed: 0, sent: 0 });
    expect(reported).toEqual([]);
    const statuses = await t.client.query<{ status: string }>(`SELECT status FROM digest_sends ORDER BY user_id`);
    expect(statuses.rows.map((row) => row.status)).toEqual(["skipped", "skipped"]);
    now = new Date(now.getTime() + 3 * 60 * 60_000);
    const again = await digests.run();
    expect(again.digests[0]).toMatchObject({ due: 0, skipped: 0 });
  });
});

describe("every email carries its own one-click unsubscribe", () => {
  it("List-Unsubscribe names the one-click address for this person and this email", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await digests.run();
    const ann = sent.find((message) => message.userId === "user_ann")!;
    expect(ann.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(ann.headers["List-Unsubscribe"]).toBe(`<${digests.oneClickUrl("user_ann", "morning")}>`);
    expect(ann.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/alma\.example\.com\/api\/email\/v1\/unsubscribe\?t=/);
    expect(ann.html).toContain(digests.unsubscribeUrl("user_ann", "morning").replace(/&/g, "&amp;"));
    expect(ann.text).toContain(`Unsubscribe from the Morning summary: ${digests.unsubscribeUrl("user_ann", "morning")}`);
  });
});

describe("unsubscribing", () => {
  function handlers(digests: Digests, who: { person?: string | null; staff?: boolean | "signed-out" } = {}) {
    return createDigestHandlers({
      digests,
      person: async () => who.person ?? null,
      staff: async () => who.staff ?? false,
    });
  }

  it("by the header: a POST of List-Unsubscribe=One-Click stops that one email and leaves the others", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { choices: { morning: true, "price-alerts": true } });
    const response = await handlers(digests).handle(
      new Request(digests.oneClickUrl("user_ann", "morning"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://mail.google.com" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(200);
    expect((await digests.preferencesOf("user_ann")).choices).toEqual({ morning: false, "price-alerts": true });
    await digests.run();
    expect(sent).toHaveLength(0);
  });

  it("by the link: the page's form unsubscribes and comes back to the page; undo puts it back", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { choices: { morning: true } });
    const token = digests.unsubscribeToken("user_ann", "morning");
    const response = await handlers(digests).handle(
      new Request(`${BASE}/api/email/v1/unsubscribe?t=${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click&from=page",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${BASE}/unsubscribe?t=${token}&done=unsubscribed`);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(false);
    const undo = await handlers(digests).handle(
      new Request(`${BASE}/api/email/v1/unsubscribe?t=${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "from=page&action=resubscribe",
      }),
    );
    expect(undo.headers.get("location")).toContain("done=resubscribed");
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(true);
  });

  it("opening the link (a GET) never unsubscribes: it goes to the page, which asks", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { choices: { morning: true } });
    const response = await handlers(digests).handle(new Request(digests.oneClickUrl("user_ann", "morning")));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/\/unsubscribe\?t=/);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(true);
  });

  it("another person's signed link is refused, and nobody's choice changes", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    const annToken = digests.unsubscribeToken("user_ann", "morning");
    const forged = `${Buffer.from("user_bo\nmorning").toString("base64url")}.${annToken.split(".")[1]}`;
    const wrongSecret = signUnsubscribe("someone-elses-secret-0000000000000000", "user_bo", "morning");
    for (const token of [forged, wrongSecret, "nonsense"]) {
      const response = await handlers(digests).handle(
        new Request(`${BASE}/api/email/v1/unsubscribe?t=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
      );
      expect(response.status).toBe(400);
    }
    expect((await digests.preferencesOf("user_bo")).choices.morning).toBe(true);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(true);
  });

  it("a POST that is neither one-click nor the page's form changes nothing", async () => {
    const digests = instance();
    await digests.savePreferences("user_ann", { choices: { morning: true } });
    const response = await handlers(digests).handle(new Request(digests.oneClickUrl("user_ann", "morning"), { method: "POST" }));
    expect(response.status).toBe(400);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(true);
  });
});

describe("the preview", () => {
  function handlers(digests: Digests, staff: boolean | "signed-out") {
    return createDigestHandlers({ digests, person: async () => null, staff: async () => staff });
  }

  it("is staff only", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    const url = `${BASE}/api/email/v1/preview?person=user_ann&digest=morning&day=2026-10-21`;
    expect((await handlers(digests, false).handle(new Request(url))).status).toBe(403);
    expect((await handlers(digests, "signed-out").handle(new Request(url))).status).toBe(401);
  });

  it("renders any person's digest for a chosen day, exactly as it would go, and never sends it", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    const response = await handlers(digests, true).handle(new Request(`${BASE}/api/email/v1/preview?person=user_bo&digest=morning&day=2026-10-19`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Monday, October 19");
    expect(body).toContain("Hello Bo");
    expect(sent).toHaveLength(0);
    const ledger = await t.client.query(`SELECT 1 FROM digest_sends`);
    expect(ledger.rows).toHaveLength(0);
    const json = await (await handlers(digests, true).handle(new Request(`${BASE}/api/email/v1/preview?person=user_bo&digest=morning&format=json`))).json();
    expect(json).toMatchObject({ digest: "morning", timeZone: "Asia/Tokyo", subscribed: true });
  });
});

describe("the preferences routes", () => {
  it("the signed-in person reads and saves their own; another site can't", async () => {
    const digests = instance();
    const h = createDigestHandlers({ digests, person: async () => "user_ann", staff: async () => false });
    const read = await (await h.handle(new Request(`${BASE}/api/email/v1/preferences`))).json();
    expect(read.preferences.choices).toEqual({ morning: false, "price-alerts": false });
    expect(read.kinds.map((kind: { key: string }) => kind.key)).toEqual(["morning", "price-alerts"]);
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      h.handle(new Request(`${BASE}/api/email/v1/preferences`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const saved = await (await put({ choices: { morning: true }, deliveryHour: 6, timeZone: "America/Denver" })).json();
    expect(saved.preferences).toMatchObject({ deliveryHour: 6, timeZone: "America/Denver", timeZoneSource: "person", choices: { morning: true } });
    expect((await put({ choices: { "not-a-kind": true } })).status).toBe(400);
    expect((await put({ deliveryHour: 25 })).status).toBe(400);
    expect((await put({ timeZone: "Mars/Base" })).status).toBe(400);
    expect((await put({ choices: { morning: false } }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(true);
    const signedOut = createDigestHandlers({ digests, person: async () => null, staff: async () => false });
    expect((await signedOut.handle(new Request(`${BASE}/api/email/v1/preferences`))).status).toBe(401);
  });
});

describe("the sign-up opt-in", () => {
  it("ticks only what they ticked, never over a choice they made, and keeps the browser's zone only when they have none", async () => {
    const digests = instance();
    expect(await digests.applySignUpChoice("user_ann", { timeZone: "America/Phoenix", digests: ["morning", "price-alerts", "nope"] })).toEqual({
      subscribed: ["morning"],
    });
    expect(await digests.preferencesOf("user_ann")).toMatchObject({ timeZone: "America/Phoenix", timeZoneSource: "browser", choices: { morning: true } });
    await digests.savePreferences("user_bo", { timeZone: "Europe/Paris", choices: { morning: false } });
    expect(await digests.applySignUpChoice("user_bo", { timeZone: "America/Phoenix", digests: ["morning"] })).toEqual({ subscribed: [] });
    expect(await digests.preferencesOf("user_bo")).toMatchObject({ timeZone: "Europe/Paris", choices: { morning: false } });
  });
});

describe("alert emails", () => {
  it("go only to people who chose the kind, at most once per key", async () => {
    const digests = instance();
    const alert = { kind: "price-alerts", dedupeKey: "nyc:2026-10-21:80", subject: "NYC hit 80°", text: "It hit 80.", html: html`<p>It hit <b>80°</b>.</p>` };
    expect(await digests.sendAlert({ userId: "user_ann", ...alert })).toEqual({ status: "not-subscribed" });
    await digests.savePreferences("user_ann", { choices: { "price-alerts": true } });
    expect(await digests.sendAlert({ userId: "user_ann", ...alert })).toEqual({ status: "sent" });
    expect(await digests.sendAlert({ userId: "user_ann", ...alert })).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["List-Unsubscribe"]).toContain("/api/email/v1/unsubscribe?t=");
    expect(sent[0]?.text).toContain("Unsubscribe from Price alerts:");
    delete people.user_ann;
    expect(await digests.sendAlert({ userId: "user_ann", ...alert, dedupeKey: "other" })).toEqual({ status: "no-person" });
  });

  it("hand the provider an idempotency key it takes, whatever the alert's own key holds, the same on a retry", async () => {
    const digests = instance();
    // A long sign-in id, as a host that keys people by address has.
    const long = "pat.morgan-whitfield+alerts@example-company-with-a-long-name.com";
    people[long] = person(long, "Pat");
    await digests.savePreferences("user_ann", { choices: { "price-alerts": true } });
    await digests.savePreferences(long, { choices: { "price-alerts": true } });
    const alert = { kind: "price-alerts", subject: "It moved", text: "It moved.", html: html`<p>It moved.</p>` };
    // Two keys of the longest length allowed that differ only at the end.
    const near = "nyc:2026-10-21:".padEnd(198, "x");
    const cases: Array<[string, string]> = [
      ["user_ann", "AAPL above 200"],
      ["user_ann", "Zürich:2026-10-21"],
      [long, `${near}:a`],
      [long, `${near}:b`],
    ];
    for (const [userId, dedupeKey] of cases) expect(await digests.sendAlert({ ...alert, userId, dedupeKey })).toEqual({ status: "sent" });
    const keys = sent.map((message) => message.idempotencyKey);
    // Resend's rule, and @adminigloo/email's (it refuses any other key, so the
    // alert could never go): 1 to 256 visible ASCII characters, no spaces.
    for (const key of keys) expect(key).toMatch(/^[\x21-\x7e]{1,256}$/);
    // Never one key for two emails: the provider would drop the second.
    expect(new Set(keys).size).toBe(cases.length);

    answer = () => ({ status: "failed", error: "503", retryable: true });
    expect(await digests.sendAlert({ ...alert, userId: "user_ann", dedupeKey: "AAPL above 210" })).toMatchObject({ status: "failed" });
    answer = () => ({ status: "sent" });
    now = new Date(now.getTime() + 6 * 60_000);
    expect(await digests.sendAlert({ ...alert, userId: "user_ann", dedupeKey: "AAPL above 210" })).toEqual({ status: "sent" });
    expect(sent.at(-1)?.idempotencyKey).toBe(sent.at(-2)?.idempotencyKey);
  });

  it("forgets a person's every row", async () => {
    const digests = instance();
    await subscribeBoth(digests);
    await digests.run();
    expect(await digests.forgetPerson("user_ann")).toBe(3);
    expect((await digests.preferencesOf("user_ann")).choices.morning).toBe(false);
    expect((await digests.preferencesOf("user_bo")).choices.morning).toBe(true);
  });
});

describe("a prefix keeps the tables apart from the host's own", () => {
  it("runs the same under aig_", async () => {
    const prefixed = await createTestDb("aig_");
    try {
      const digests = createDigests({
        db: prefixed.db,
        tables: prefixed.tables,
        kinds,
        people: async (ids) => ids.map((id) => person(id, id)),
        send: async () => ({ status: "sent" }),
        siteName: "Alma",
        siteTimeZone: "UTC",
        secret: SECRET,
        baseUrl: BASE,
        now: () => now,
        sleep: async () => {},
      });
      await digests.savePreferences("u1", { choices: { morning: true } });
      expect((await digests.run()).digests[0]).toMatchObject({ sent: 1 });
      const rows = await prefixed.client.query(`SELECT 1 FROM aig_digest_sends`);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await prefixed.close();
    }
  });
});
