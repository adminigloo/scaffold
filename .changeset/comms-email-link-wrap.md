---
"@adminigloo/comms": patch
---

Long links in an email's HTML part wrap instead of widening the message
(`word-break: break-all` on every link), so a manage link reads on a phone.
Adds a README: the tables, senders for Resend and SMTP (with timeouts), sending,
the queue and the cron.
