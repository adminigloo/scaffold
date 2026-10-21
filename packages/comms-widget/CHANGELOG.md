# @adminigloo/comms-widget

## 0.2.1

### Patch Changes

- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.
- Updated dependencies [ed86e90]
  - @adminigloo/comms@0.6.0

## 0.2.0

### Minor Changes

- 3c427cc: The showroom: with email off, an owner reads one plain sentence ("Email isn't switched on for this site yet …"); `showTechnical` adds the server's reason for staff. Dates default to en-US. An empty log says what it will hold.

## 0.1.2

### Patch Changes

- Updated dependencies [452e94a]
  - @adminigloo/comms@0.5.0

## 0.1.1

### Patch Changes

- 786a643: Released with `@adminigloo/comms` 0.4 (Tenancy 2b-1): the optional peer is now
  `^0.4.0`. The staff alert email (`team_alert`) is listed under "Other" as
  "Team alert", and the console's names match the server's `templateLabel`. No
  screen or wire change.
- Updated dependencies [786a643]
  - @adminigloo/comms@0.4.0

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
