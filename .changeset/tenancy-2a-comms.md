---
"@adminigloo/comms": minor
---

Messages per company (Tenancy 2a).

- **`identity(tenantId)`** on the delivery config: who each company's messages
  come from (its name) and where replies go. Read once per company per drain; a
  failure to read it fails that message for a retry, never sends it unsigned.
- **`OutboundEmail`** gains `tenantId`, `fromName` and `replyTo`;
  **`OutboundSms`** gains `tenantId` (and the SMS sender name comes from the
  identity).
- **Two log columns**, `from_name` and `reply_to`, on `comms_messages`. An
  existing database needs:
  `alter table comms_messages add column if not exists from_name text, add column if not exists reply_to text;`
- **`runDueMessages({ tenantIds })`** drains only those companies (an empty
  list drains none).
- **`createCommsAdminHandlers`**: the staff console's routes (status,
  templates, recent messages, send due now), each scoped to the company in the
  path, with `commsPermissions` (`comms.view`, `comms.manage`) and the route
  table `COMMS_ADMIN_ROUTES`.

After review:

- **Companies take turns** in a drain given `tenantIds`: every company's
  oldest due message, then every company's second, and so on, so one
  company's backlog of hundreds never holds back another company's one
  reminder when the run's limit or time runs out.
- **A run given `tenantIds` touches only those companies' rows**, the
  clean-up of stuck messages included, and reports only their counts: one
  company's "Send what's due now" can no longer move another company's
  messages.
- **`allowance`**: a business's sending allowance, asked right before each
  message would leave. A held message is logged "held: …" so the owner sees
  it, and a queued one is tried again later, never dropped.
- **A message's own `replyTo`**: a notice to a business's office can reply to
  the customer it is about.
- The console's status says how many queued messages **missed their run**
  (`scheduled.behind`).
