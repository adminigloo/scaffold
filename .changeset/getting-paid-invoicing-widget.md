---
"@adminigloo/invoicing-widget": minor
---

The customer's invoice page shows "Pay the deposit" or "Pay $X now" when the business takes card payments (an amount box only when it allows part payments), sends the customer to Stripe's secure page, and says thank you when they come back (`returned`). The ledger's invoice screen sets the deposit (the usual, none, a percent or a fixed amount) and marks a card payment that was disputed or partly refunded. Needs @adminigloo/invoicing 0.5.

It also says "A bank payment of $X is on its way (started …)", offers only what's left, asks the customer to contact the business below the card minimum, and marks a lost dispute.

A part refund shows "Partly refunded $X", only a full refund or a lost dispute "Reversed"; the admin transport gains `attention` and `resolveAttention`.
