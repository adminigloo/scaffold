---
"@adminigloo/booking": patch
---

A busy server no longer empties a host's booking page. The calendar feed's
wall-clock backstop is one second, not 100 ms: at 100 ms it refused ordinary
feeds whenever the server was slow (GitHub's runner took longer than that over
a 4,000-event calendar), and a refused feed fails closed, so the page offered
no times. The step budget still stops runaway feeds; the clock only catches a
walk that runs away anyway.
