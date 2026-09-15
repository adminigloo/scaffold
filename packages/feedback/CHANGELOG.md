# @adminigloo/feedback

## 0.5.0

### Minor Changes

- The support console half-step: the board's columns become editable and the
  reporter's replies become visible without opening every ticket. Platform:
  `createStatus`/`updateStatus`/`deleteStatus`/`reorderStatuses` (a key is
  permanent — tickets reference it as text; deletion refuses while a column
  holds tickets and says how many), `markTicketRead`, and `listBoardData` now
  computes `hasUnreadReporterReply` per ticket in one grouped query — the
  board card wears a "reply" pill until the workspace is opened. One
  migration: `feedback_tickets.last_staff_read_at`. create-app: the feedback
  overlay's router grows the five procedures, the board page clears the pill
  by looking, the feedback-admin overlay gains `/admin/feedback/statuses`
  (the column editor) and the sidebar's Feedback group gains its entry.

## 0.4.1

### Patch Changes

- The glacier re-skin. Both embedded surfaces — the widget's `aif-` styles and
  the board's `aib-` styles — now carry their own complete token set as custom
  properties, including a dark theme decided by `prefers-color-scheme`: they
  render inside apps whose themes they cannot know, and a hardcoded white
  dialog in a dark host reads as a foreign object. Visuals move to the glacial
  teal brand accent (the FAB now wears it), softer radii, a real shadow scale,
  and status chips as pills. Class names are unchanged, so nothing consuming
  either surface needs to change.

## 0.4.0

### Minor Changes

- Reporter-side replies — the support loop closes. The platform mints a
  per-ticket reporter token at submit (`aft_…`, returned once, hash stored),
  and two new key-authenticated endpoints serve the follow-up: `POST
  /v1/thread` returns the ticket with its reporter-visible conversation
  (system messages withheld) and the board's configured status label; `POST
  /v1/reply` appends a reporter message attributed to the ticket's own
  reporter — the request body cannot claim a name. All failures on the pair
  answer one indistinguishable 404, so a client key is not an enumeration
  oracle. The widget grows a "My reports" view: reports this browser sent
  (localStorage, capability-model — no reporter accounts), each opening its
  thread with staff replies and a reply box. Against a pre-0.4 platform the
  widget degrades to exactly its old behaviour. Consumers need only the
  migration for `feedback_tickets.reporter_token_hash`; the staff board
  renders reporter replies with no changes.
