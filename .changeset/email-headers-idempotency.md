---
"@adminigloo/email": minor
---

Extra headers and an idempotency key on a message. `headers` adds message headers — RFC 8058's `List-Unsubscribe` and `List-Unsubscribe-Post` pair, which Gmail and Yahoo ask bulk senders for — sent to Resend in the body; names are letters, digits and hyphens, each value one line (a CR or LF would start a header the caller never wrote) of at most 2,000 characters, at most 20, and a header the message's own fields write (From, To, Cc, Bcc, Subject, Reply-To, Sender, Date, Message-ID, the MIME headers) is refused with `EmailMessageInvalidError` (`field: "headers"`), on an unconfigured deployment too. `idempotencyKey` is sent as Resend's `Idempotency-Key`, so a retry of the same message within 24 hours is never a second email (`field: "idempotencyKey"` for anything but 1 to 256 visible ASCII characters). A custom transport receives both on `OutboundEmail`; a message with neither reaches it exactly as before. create-app 0.40's digests send with both.
