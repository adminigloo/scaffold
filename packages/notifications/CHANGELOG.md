# @adminigloo/notifications

## 0.1.0

### Minor Changes

- The in-app inbox, and the first events that ring it. `@adminigloo/
  notifications` first release: durable per-recipient rows in the app's own
  database — `notify` fans out at write time (read-time fan-out re-answers an
  authorization question on every poll), reads are recipient-scoped in the
  where clause so a guessed id settles nothing, and `unreadCount` is its own
  query because the badge renders on every shell. Feedback 0.6.0 grows the
  producer side: an optional `onEvent` hook on `createFeedbackHandlers`,
  fired on `ticket.created` and `reporter.replied` — awaited so serverless
  cannot truncate the listener's write, caught so a broken listener can never
  fail the submit it announces. create-app rides along for the pin.
