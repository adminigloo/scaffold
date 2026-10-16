# @adminigloo/notifications-widget

## 0.1.0

### Minor Changes

- 786a643: First release: `AlertsBell`, `AlertsInbox`, `AlertSettings`.
  
  - **`<AlertsBell>`**: the bell in the header with the person's unread alerts
    in the company they are working in. The count is checked every minute while
    the page is in view (every 10 minutes after 15 idle minutes), hidden for
    someone who can't get alerts, a popover on a desktop and a sheet on a
    phone, and a read in one tab updates the others.
  - **`<AlertsInbox>`**: every alert, All or Unread, by day, with "Load more"
    and "Mark all as read".
  - **`<AlertSettings>`**: "In the app" or "In the app and by email" for each
    kind of alert, with the reason when email can't go and where the emails go
    (the business email, for the owner's copies of new work), and, for the
    owner, who in the company hears about new estimate requests, visit requests
    and invoices, saying which of them send no email at all because of the
    owner's own "In the app" choice.
  - **`hideTitle`** on `<AlertsInbox>` and `<AlertSettings>`, for a page whose
    own header already shows the title (and, on the inbox, the Alert settings
    link).
  - **`businessEmailSettings`** on `<AlertSettings>`: where your app sets the
    business email, in a few words, for the sentences that say the owner's
    emails go there (default "company settings").
  
  An alert opens only a page on this site, and what a customer typed is always
  shown as text. An answer the screens can't read (a timeout page, a crash) is
  a plain sentence with "Try again", never a status code. Talks to
  `@adminigloo/notifications`'s handlers; React is its only peer.

### Patch Changes

- Updated dependencies [786a643]
  - @adminigloo/notifications@0.2.0
