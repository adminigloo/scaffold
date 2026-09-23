---
"@adminigloo/create-app": minor
---

Wire the gs-glass port-sweep releases into generated projects:

- Pins move to estimator 0.2.0, invoicing 0.2.0 and comms 0.2.0 (the emitted
  routers and pages call their new tenant-scoped and public-safe APIs).
- `vercel.json` is now generated: a project with `--comms` gets the queue drain
  (`/api/cron/comms`) in `crons`, daily — the one schedule Vercel's Hobby plan
  accepts; DEPLOYMENT.md says how to tighten it on Pro. Until now every comms
  project queued reminders that nothing ever sent. The `comms.messaging`
  capability now requires the schedule as evidence, not just the route.
- The scheduling overlay's guidance: SEND a booking confirmation in the request
  (`sendNow`) and QUEUE only the reminder, tagged with `refType`/`refId` so a
  cancelled or moved booking can `cancelScheduled` it.
