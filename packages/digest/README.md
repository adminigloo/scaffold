# @adminigloo/digest

Each person's own email choices and a daily digest in their own time zone.
A morning summary at 7 AM wherever they are, alert emails they chose, and on
every email a link that stops that one email without signing in.

## What each install gets you

| Install | What you get | What you add |
| --- | --- | --- |
| `@adminigloo/digest` + `./schema` | The kinds (`defineEmailKinds`), each person's preferences (zone, hour, every kind on or off — all OFF until they say yes), the daily run (one email per person per local day, through a ledger), the staff preview, alert emails (`sendAlert`, at most once per key), signed unsubscribe links and RFC 8058 one-click headers, the HTTP handlers | The three tables in your drizzle schema and a migration you run. Your digests' sections. Two seams: `people` (who may be emailed) and `send` (how an email leaves: `@adminigloo/email` or your own). A cron that calls `run()`. One catch-all route for the handlers. An unsubscribe page. |
| `+ ./ui` | `<EmailPreferences>` (the preferences screen) and `<SignUpEmailChoice>` (the unticked opt-in beside sign-up) | A page that mounts each. |

create-app (0.40) wires all of it into a project whose customers are people
(`--audience consumers --email`).

## Not included

- **Sending through a provider.** `send` is yours; `@adminigloo/email` 0.5
  is what create-app passes (with `idempotencyKey`, so a retry never sends
  twice, and `headers` for List-Unsubscribe).
- **Per-company digests.** A person's choices are theirs, keyed by person,
  not by company. A section can read the person's companies itself.
- **More than one delivery hour per person.** Every digest a person chose
  comes at or after their one hour.
- **Batch sending.** One provider call per email, paced (`sendIntervalMs`,
  550 ms: Resend's 2 a second). A run that runs out of time says who is still
  waiting, and the next run sends them.

## Setup

```ts
// src/db/schema.ts
export * from "@adminigloo/digest/schema"; // digest_preferences, digest_subscriptions, digest_sends
```

Under a prefix, export the prefixed tables by name instead:
`const t = defineDigestTables({ prefix: "aig_" }); export const aigDigestSends = t.sends; …`

```ts
// src/digests.ts — your emails
import { defineEmailKinds, html } from "@adminigloo/digest";

export const EMAIL_KINDS = defineEmailKinds({
  digests: [
    {
      key: "morning", // permanent: stored on every choice and every send
      title: "Morning summary",
      description: "Yesterday's results for the cities you follow, and today's window.",
      sections: [
        {
          key: "results",
          render: async (person, day) => {
            const rows = await resultsFor(person.userId, day.start, day.end);
            if (rows.length === 0) return null; // nothing to say: no section
            return {
              title: "Yesterday's results",
              text: rows.map((r) => `${r.city}: ${r.high}°`).join("\n"),
              html: html`<ul>${rows.map((r) => html`<li>${r.city}: <b>${r.high}°</b></li>`)}</ul>`,
            };
          },
        },
      ],
    },
  ],
  alerts: [{ key: "price-alerts", title: "Price alerts", description: "When a price crosses the line you set." }],
});
```

A section returns `{ title, text, html }` or `null`. `html` must be made with
the `html` tag, which escapes every value (`raw()` for markup you vouch for).
A day where every section is null sends nothing ("empty" on the ledger). A
section that throws is left out and reported; the others still go.

```ts
// src/server/digest.ts
import { createDigests, createDigestHandlers } from "@adminigloo/digest";
import { digestTables } from "@adminigloo/digest/schema";

export const digests = createDigests({
  db,
  tables: digestTables,
  kinds: EMAIL_KINDS,
  people: async (ids) => /* the ones who may be emailed now, with their verified address */,
  send: async (m) => /* { status: "sent" } | { status: "skipped" } | { status: "failed", error, retryable } */,
  idempotentSends: true,            // your provider drops a repeat of m.idempotencyKey (Resend does)
  siteName: "Alma",
  siteTimeZone: "America/New_York", // for a person with no zone of their own
  secret: process.env.EMAIL_LINK_SECRET, // 32+ characters: signs every unsubscribe link
  baseUrl: "https://alma.example.com",
});

// app/api/email/[...path]/route.ts
const handlers = createDigestHandlers({ digests, person: signedInUserId, staff: mayPreview });
export const GET = handlers.handle, POST = handlers.handle, PUT = handlers.handle;

// app/api/cron/digest/route.ts (hourly where your host allows it)
await digests.run({ timeBudgetMs: 45_000 });
```

## How the day works

A person's digest for day D may go from their hour on D (in their zone)
until their hour on D+1. The windows are back to back:

- run every hour and each person gets theirs within the hour after their
  hour;
- run once a day (Vercel Hobby) and everyone still gets one a day, in
  whichever window that run falls (late for some zones, never twice);
- after an outage only the window open now is sent, never a backlog;
- a window for a day before the person said yes is never theirs: someone who
  ticks the box at 5 AM gets that day's at 7, not the day before's at once and
  another at 7 (after their hour, that day's goes at once).

An hour the clocks jump over is the first moment after the jump; an hour
that happens twice is the first.

## The ledger

Before a section is built, `(person, kind, day)` is claimed with an insert
into a unique index. A replayed cron, two instances at once, a retried
request: nobody gets two. With `idempotentSends`, a failure the provider may
take later (`retryable`) and a send a crash cut off are tried again while the
day lasts (three times in all, backing off from 5 minutes) with the same
`idempotencyKey`; without it, each is tried once. **No provider configured**
is `skipped`: recorded once, never retried, never reported.

## Unsubscribing

Every email carries:

- `List-Unsubscribe: <https://…/api/email/v1/unsubscribe?t=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058): Gmail's and
  Yahoo's own Unsubscribe button POSTs it, and that one email stops.
- A link in the footer to your unsubscribe page (`/unsubscribe?t=…`), which
  works without signing in, asks first (a GET never unsubscribes: link
  scanners open every link), and offers an undo.

The token is the person and the kind under an HMAC of your secret: change
either half and it is refused, so a link can only ever stop the email it came
with, for the person it went to. Unsubscribing one digest leaves every other
email alone. A link never expires; rotating the secret retires the old ones.

## The preview

`GET /api/email/v1/preview?person={id}&digest=morning&day=2026-10-21` — staff
only (your `staff` seam) — renders that person's digest for that day exactly
as it would go, and sends nothing (`&format=json` for the parts: each
section, whether it had anything to say, what the ledger says).

## Alerts

```ts
await digests.sendAlert({
  userId, kind: "price-alerts",
  dedupeKey: `nyc:${day}:80`, // the fact it reports: a second call with it sends nothing
  subject: "NYC hit 80°", text, html: html`<p>…</p>`,
});
// → sent · skipped · failed · not-subscribed · no-person · duplicate
```

## The sign-up opt-in

`<SignUpEmailChoice digests={…} />` beside the sign-up form shows one
unticked box per digest and writes a first-party cookie
(`aig_email_choice`, a day) with this browser's time zone and what was
ticked. The page a new account lands on first reads it once:
`digests.applySignUpChoice(userId, parseSignUpChoice(cookie))` — the zone
only if they have none, each digest only if they never chose it either way —
and deletes it.
