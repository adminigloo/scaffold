---
"@adminigloo/scheduling": minor
---

Alerts and files (Tenancy 2b-1): a company hears about its visits in the app,
and keeps photos and files against a visit.

- **Alert kinds and mappers**: `schedulingAlertKinds` (a visit asked for or
  booked, moved, cancelled, about to lapse, lapsed; one "Visit requests and
  customer changes" group) and `schedulingAlertsFor`, which writes an alert
  exactly when the office notice goes, under the same kind and key, in the
  visit's own time zone. A crew member hears about a customer moving or
  cancelling their own crew's visit, with where the job is and a link to
  today's route or the visit's photos. When a move puts the visit on another
  crew, the people who were only on the old one are told it is off their
  route ("Pat Rivera's visit is off your route: moved to …", "It's now with
  South."), with no link to a page they can no longer open.
- **The expiring sweep**: `listExpiringRequests` (deadline in the next 26
  hours, asked more than 6 hours ago, one query) and `schedulingExpiringAlert`
  ("Answer Pat Rivera's visit request by …, or it lapses").
- **Office emails through the one alert setting**: the comms listener's
  `officeRecipients` decides who gets each office notice (the saved list is no
  longer read), each goes through comms' `deliverNow`, and `officeSent` hears
  how each address ended, so a failed office email is sent again by the alerts
  cron. A send that timed out is never handed over. Without
  `officeRecipients`, 0.5's behaviour exactly.
- **`alertsHref`** on the staff handlers: Schedule settings points to Alert
  settings (`SettingsWire.alertRecipients`), and a save drops the old list.
- **File records**: `schedulingFileRecords`, the visit as something files
  belong to, its permissions deciding who sees them.
- **The same event twice tells the customer once**: the comms listener
  claims each customer email with a link (asked, confirmed, moved, given to
  another crew) once per event, so a retried delivery sends nothing again and
  the reminder it queued stays queued. An email that didn't go is tried again.
- **Bodies read with a cap**: every route counts a body's bytes as they
  arrive and stops at its limit, so a self-hosted server is never made to
  hold a huge request.
- **Same origin only**: a POST from another subdomain of the same domain
  (`Sec-Fetch-Site: same-site`) is refused like one from another site; a
  business's own website that posts the booking form names its origin in
  `cors`. `isCrossSiteRequest` says so too.
- The comms peer is now `^0.4.0`.
