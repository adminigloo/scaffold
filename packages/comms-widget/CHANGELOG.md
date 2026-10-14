# @adminigloo/comms-widget

## 0.1.0

### Minor Changes

- 2df95e8: First release: `MessagesConsole`, the staff screen for a company's messages.
  What's set up (email, text), the message templates (edit, turn on or off),
  recent messages with who they went to and whether they were delivered, and a
  "send due messages now" button. Talks to `@adminigloo/comms`'s
  `createCommsAdminHandlers`; React is its only peer.
  
  After review: every email the features send has a written name and a line on
  when it goes out ("Visit reminder — to the customer, the day before the
  visit"), never its key; subjects are previewed with example values instead of
  `{{…}}`; and the console says when queued messages missed their run.

### Patch Changes

- Updated dependencies [2df95e8]
  - @adminigloo/comms@0.3.0
