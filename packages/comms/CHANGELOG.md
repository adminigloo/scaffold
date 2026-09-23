# @adminigloo/comms

## 0.2.0

### Minor Changes

- 0c17095: Harden the send path and the queue after a sweep against the source system:
  SMS compliance, a queue that always makes forward progress and never sends the
  same message twice or days late, cancellable entity-linked messages, recipient
  validation, and an honest sender contract.
  
  **SMS compliance (A2P 10DLC / TCPA).** An `sms` sender now requires
  `smsCompliance: { senderName, optOutText? }` — a type error without it. Every
  text is sent as `SenderName: …` with the opt-out line (`Reply STOP to opt out.`,
  or your `optOutText`) appended unless the text already contains that exact line,
  case-insensitive (`enforceCompliance`, exported, with the source's tests
  ported). Stricter than the source on purpose: the source skipped the line when
  "reply stop", "opt out" or "unsubscribe" appeared anywhere, and the check runs
  on the RENDERED text — so a customer's own "please unsubscribe me from the
  newsletter" in a notes field dropped the STOP instruction. Other wording no
  longer counts; a duplicate line is harmless, a missing one is not. Code that
  gets past the type (plain JS, a cast) sends nothing: each SMS is logged `failed`
  with "sms compliance not configured". The delivery log's `body` is now the text
  actually sent. Send through a Twilio Messaging Service registered to your
  campaign (`messagingServiceSid`).
  
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
  maxAttempts, retryBaseMs, staleClaimMs, timeBudgetMs, maxLatenessMs,
  beforeSend }` — the old `(db, senders, now, limit)` form still works — and
  reports every outcome (`sent`, `skipped`, `failed`, `retrying`, `cancelled`,
  `expired`, `reclaimed`, `stoppedEarly`) alongside `processed`.
  
  **Never the same message twice.**
  - A row whose provider accepted it but whose log write failed is recorded
    `sent`, never retried into a duplicate.
  - A row whose send WAS logged but whose final queue write failed used to sit in
    `sending` until the reclaim put it back to `pending` — and the next tick sent
    it again. Every log entry the queue writes now carries the queue row's id
    (`comms_messages.scheduled_id`); after claiming a row and before sending it,
    the queue checks for a `sent` entry for that row and, if there is one, records
    the row `sent` ("already sent … not sent again") without calling the sender.
    The final write is also retried twice in-run before the row is left to the
    reclaim.
  - The final write is guarded on the claim's attempt count, not only on
    `status = 'sending'`: a worker that stalled past `staleClaimMs` used to
    overwrite the row a newer worker had reclaimed and was mid-send on, putting
    it back to `pending` to send yet again.
  - Senders receive `idempotencyKey` on `OutboundEmail` / `OutboundSms` — the
    queue row's id, the same on every retry and reclaim (and, for `sendNow`, the
    new optional `SendInput.idempotencyKey`, e.g. `booking:${id}:confirmation`).
    Resend takes it as its `Idempotency-Key` header —
    `resend.emails.send(payload, { idempotencyKey: m.idempotencyKey })` — and
    drops a repeat within 24 hours. `@adminigloo/email` does not forward it yet;
    Twilio's Messages API takes no such key, so for SMS the queue's own check is
    the protection. Both fields are optional additions: no existing sender or
    caller needs to change.
  
  **Never days late.** Nothing used to bound how late a queued message could go
  out, so a queue nobody drained (a cron never registered, an upgrade) flushed
  every stale "see you tomorrow" at once. `runDueMessages` now takes
  `maxLatenessMs` (default 48 hours, exported as `DEFAULT_MAX_LATENESS_MS`): a
  row more than that past its `sendAt` with no `expiresAt` of its own ends
  `expired`, with "more than 2 days late (due …) — not sent" on the row and in
  the log. A row's own `expiresAt` overrides it. 48 hours rides out a
  once-a-day cron missing a run.
  
  **Cancellable, entity-linked messages.** `enqueueMessage` takes `refType`/`refId`
  ("booking", id); `cancelScheduled(db, { tenantId, id })` or `{ tenantId,
  refType, refId, templateKey? }` cancels `pending` AND `sending` rows
  (tenant-scoped; rows are kept, marked `cancelled`). `sending` too, because a
  claimed row can return to `pending` (a transient failure, a reclaim) and would
  then send after the booking was cancelled; the worker's final write and the
  reclaim match only `sending`, so the cancel sticks. A send already in the
  provider's hands still completes, and the delivery log says so. An optional
  `beforeSend(row)` hook on `runDueMessages` re-checks live data at send time:
  `"send"`, `"skip"` / `{ skip: true, reason }` (row → `cancelled`, logged with
  the reason), or `{ to?, vars? }` for fresh values. A hook that returns
  `null`/`undefined` means "send" (a `null` used to throw a TypeError and retry
  the row to `failed`).
  
  **Also:**
  - `normalizePhone()` (E.164, US default; `null` when it cannot be a number) and
    per-channel recipient validation — `enqueueMessage` rejects a bad address with
    a ZodError at enqueue time; `sendNow` logs it `failed`. Every `+1` result must
    be a real NANP shape (area code and exchange start 2-9): ten digits that
    cannot be — `0207946095`, a UK number typed without its country code — are
    `null` instead of being forced to `+10207946095`. A `(0)` trunk marker in
    international input is dropped (`+44 (0)20 7946 0958` → `+442079460958`).
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
  - SMS text changes: a template that says "text UNSUBSCRIBE to stop" (or any
    opt-out wording other than the configured line) now also gets the configured
    line appended.
  - `normalizePhone` returns `null` for ten digits that are not NANP, so
    `enqueueMessage` throws and `sendNow` logs `failed` for them.
  - Queue rows that previously looped as `pending` on a permanent failure end
    `failed` on their next run; a `pending` row more than 48 hours past its
    `sendAt` (no `expiresAt`) ends `expired` instead of sending (pass a larger
    `maxLatenessMs` to keep sending them); `cancelScheduled` also cancels
    `sending` rows.
  
  **Schema — run your db:generate + db:migrate.** `comms_scheduled` gains
  `ref_type`, `ref_id`, `dedupe_key`, `min_interval_ms`, `expires_at`,
  `attempts` (int, default 0), `last_error`, `claimed_at`, plus indexes
  `comms_scheduled_ref_idx` and the partial unique
  `comms_scheduled_dedupe_idx (tenant_id, dedupe_key) WHERE dedupe_key IS NOT
  NULL`. `comms_messages` gains `missing_vars` (jsonb), `scheduled_id` (text,
  nullable — NULL for a `sendNow`) and indexes `comms_messages_recipient_idx` and
  `comms_messages_scheduled_idx`. The unique index is on a new column, so
  existing rows (all NULL) cannot violate it; to verify before migrating a table
  you have backfilled yourself: `select tenant_id, dedupe_key, count(*) from
  comms_scheduled where dedupe_key is not null group by 1, 2 having count(*) > 1;`
  must return no rows.
  
  **Upgrading from 0.1.x — look before the first drain.** The first run after the
  upgrade settles what 0.1.x left behind instead of sending it:
  - A row 0.1.x left in `sending` (NULL `claimed_at`) ends `failed` with "state
    unknown from 0.1.x … possibly already delivered — not re-sent". 0.1.x
    stranded rows there when anything after the claim threw, including the log
    write after the provider had accepted the message, and its log has no
    `scheduled_id` to check — so re-sending could duplicate. Find them with
    `select id, to_address, template_key, send_at from comms_scheduled where
    status = 'failed' and last_error like 'state unknown from 0.1.x%';` and
    re-enqueue any you know did not arrive.
  - A `pending` row more than 48 hours past its `send_at` with no `expires_at`
    ends `expired`. Preview how many:
    `select count(*) from comms_scheduled where status = 'pending' and
    expires_at is null and send_at < now() - interval '48 hours';` — to send a
    backlog anyway, run that one drain with a larger `maxLatenessMs`.
  
  **Scheduling the drain.** A project generated by this release's create-app with
  `--comms` gets `/api/cron/comms` in its `vercel.json` `crons`, once a day
  (`0 14 * * *`) — the only cadence Vercel's Hobby plan accepts; a more frequent
  schedule (`*/5 * * * *`) fails a Hobby deploy. On Pro, tighten it
  (`*/15 * * * *` is a good resolution for appointment reminders), or point any
  external scheduler at the URL with the secret. Either way set `CRON_SECRET` in
  the Vercel project: the route refuses every call without it, and queued
  reminders wait (and, past 48 hours, expire). A project generated before this
  release has `"crons": []`; add `{ "path": "/api/cron/comms", "schedule":
  "0 14 * * *" }` yourself. See DEPLOYMENT.md, "`vercel.json` crons". Immediate
  messages (a booking confirmation) should use `sendNow` in the request, not
  `enqueueMessage` with `sendAt = now` — on a daily cron that would wait a day.
