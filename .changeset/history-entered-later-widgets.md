---
"@adminigloo/invoicing-widget": patch
"@adminigloo/scheduling-widget": patch
---

Past records say so (invoicing 0.7, scheduling 0.7): an invoice, a payment or a visit typed in later from the business's records shows "Entered from past records on {day}" — on the invoice under its title, beside the payment, and in the visit's panel (the company's own calendar day) — read from the server's `enteredLater`, and parsed (a malformed one is dropped).
