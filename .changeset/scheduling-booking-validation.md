---
"@adminigloo/scheduling": minor
---

Guard the direct booking path. `validateBookingSlot` now also refuses a slot
outside the resource's working window (a day off, or a time like 3am the finder
would never offer), not just overlaps and drive-buffer conflicts — and
`createBooking` runs that validation before it writes, so an out-of-hours or
double-booked slot can no longer be inserted by a caller supplying its own times
(a public request form, a reschedule). Trusted callers pass `{ skipValidation: true }`
for seeds and staff overrides; unassigned bookings (no resource) skip it. Also
fixes the drive-time buffer for a job scheduled AFTER the new one to measure the
correct direction (job → next), which matters with a real asymmetric provider.
