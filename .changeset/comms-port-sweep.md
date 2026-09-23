---
"@adminigloo/comms": minor
---

Harden the send path and the queue after a sweep against the source system:
SMS compliance, a queue that always makes forward progress, cancellable
entity-linked messages, recipient validation, and an honest sender contract.

**SMS compliance (A2P 10DLC / TCPA).** An `sms` sender now requires
`smsCompliance: { senderName, optOutText? }` — a type error without it. Every
text is sent as `SenderName: …` with `Reply STOP to opt out.` appended unless it
already carries opt-out language (`enforceCompliance`, exported, with the
source's tests ported). Code that gets past the type (plain JS, a cast) sends
nothing: each SMS is logged `failed` with "sms compliance not configured". The
delivery log's `body` is now the text actually sent. Send through a Twilio
Messaging Service registered to your campaign (`messagingServiceSid`).

**The queue always moves.** A failed row used to go back to `pending` with the
same `sendAt`, so 200 poison rows at the head of the queue were retried every
tick forever and nothing behind them ever sent; a row that threw aborted the
whole batch and stayed `sending` forever. Now: attempts are counted at claim
time; a transient failure backs off (5, 10, 20, 40 min) and ends `failed` after
5 attempts; a permanent one (missing template, invalid recipient, compliance
not configured, channel changed) ends `failed` at once; every row is handled in
its own try/catch; a `sending` row whose claim is over 10 minutes old (a killed
worker) is reclaimed; `timeBudgetMs` stops a run cleanly before the platform
timeout. `runDueMessages(db, senders, options)` takes `{ now, limit,
maxAttempts, retryBaseMs, staleClaimMs, timeBudgetMs, beforeSend }` — the old
`(db, senders, now, limit)` form still works — and reports every outcome
(`sent`, `skipped`, `failed`, `retrying`, `cancelled`, `expired`, `reclaimed`,
`stoppedEarly`) alongside `processed`. A row whose provider accepted it but
whose log write failed is recorded `sent`, never retried into a duplicate.

**Cancellable, entity-linked messages.** `enqueueMessage` takes `refType`/`refId`
("booking", id); `cancelScheduled(db, { tenantId, id })` or `{ tenantId,
refType, refId, templateKey? }` cancels pending rows (tenant-scoped; rows are
kept, marked `cancelled`). An optional `beforeSend(row)` hook on
`runDueMessages` re-checks live data at send time: `"send"`, `"skip"` /
`{ skip: true, reason }` (row → `cancelled`, logged with the reason), or
`{ to?, vars? }` for fresh values.

**Also:**
- `normalizePhone()` (E.164, US default; `null` when it cannot be a number) and
  per-channel recipient validation — `enqueueMessage` rejects a bad address with
  a ZodError at enqueue time; `sendNow` logs it `failed`.
- `enqueueMessage` options: `skipIfPast` (default true — a sendAt more than 5
  minutes in the past queues nothing and returns `null`), `expiresAt` (a row
  past it ends `expired` instead of sending late), `dedupeKey` (idempotent:
  a replay returns the first row's id; keys are permanent, so include a version
  for things that move, e.g. `booking:${id}:reminder:${startsAt}`),
  `minIntervalMs` (at send time, skip — logged with the reason — if the template
  reached that recipient within the window; also on `sendNow`), `channel`.
- Email templates require a subject (`upsertTemplate`; `requireEmailSubject` is
  exported for hosts deriving their own input schema), and `sendNow` falls back
  to `defaultEmailSubject` (on the senders object) when the rendered subject is
  empty.
- Template kill switch: `setTemplateActive(db, tenantId, key, active)`.
  `upsertTemplate` no longer switches an inactive template back on; a queued
  message for an inactive template ends `skipped`.
- The queue passes its channel to the send: a template whose channel changed
  since enqueue fails the row as "channel changed".
- A sender that RESOLVES with `{ error }` (Resend's SDK), `{ ok: false }` or
  `{ status: "failed" }` (@adminigloo/email) is now a failure, not `sent`;
  `{ status: "skipped" }` is a skip. The email sender receives `html` (escaped)
  alongside `body`; `plainTextToEmailHtml` is exported.
- `renderTemplate` reads own properties only — `{{constructor}}` rendered
  `function Object() { [native code] }` into a customer's message. The log
  records placeholders that rendered blank (`missingVars`).

**Breaking within 0.x:**
- `CommsSenders` is now a union: `sms` without `smsCompliance` does not typecheck.
- `enqueueMessage` returns `Promise<string | null>`, skips past sendAts by
  default (pass `skipIfPast: false` for the old behaviour), and throws on an
  invalid recipient.
- `upsertTemplate` throws for an email template with no subject.
- `sendNow` log changes: an inactive template is `skipped` (was `failed`); a
  missing template's error reads `no template "key"` (was `no active template
  "key"`); a no-provider skip now carries its reason in `error`; SMS recipients
  are logged in E.164.
- Queue rows that previously looped as `pending` on a permanent failure end
  `failed` on their next run.

**Schema — run your db:generate + db:migrate.** `comms_scheduled` gains
`ref_type`, `ref_id`, `dedupe_key`, `min_interval_ms`, `expires_at`,
`attempts` (int, default 0), `last_error`, `claimed_at`, plus indexes
`comms_scheduled_ref_idx` and the partial unique
`comms_scheduled_dedupe_idx (tenant_id, dedupe_key) WHERE dedupe_key IS NOT
NULL`. `comms_messages` gains `missing_vars` (jsonb) and index
`comms_messages_recipient_idx`. The unique index is on a new column, so
existing rows (all NULL) cannot violate it; to verify before migrating a table
you have backfilled yourself: `select tenant_id, dedupe_key, count(*) from
comms_scheduled where dedupe_key is not null group by 1, 2 having count(*) > 1;`
must return no rows. Rows left in `sending` by the previous version have a NULL
`claimed_at` and are reclaimed on the first run.

**Not yet automatic — register the cron.** A generated project's `vercel.json`
ships `"crons": []`, and the comms overlay cannot add to it; until
`{ "path": "/api/cron/comms", "schedule": "*/5 * * * *" }` is added (and
`CRON_SECRET` set), queued reminders never send. The overlay route says so.
Immediate messages (a booking confirmation) should use `sendNow` in the
request, not `enqueueMessage` with `sendAt = now`.
