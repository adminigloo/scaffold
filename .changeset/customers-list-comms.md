---
"@adminigloo/comms": minor
---

`onSent`: told once a message has gone — from `sendNow`, `deliverNow` and the queue's drain — after its log row is written, with the row, the address and the template. Never told about a skip or a failure; awaited, and a throw is swallowed, so it can never fail a send. The customer list puts each message on its customer's timeline from here.
