---
"@adminigloo/scheduling-widget": minor
---

Alerts and files (Tenancy 2b-1).

- **The alert list managed elsewhere**: when the server says who gets
  new-request alerts is chosen in Alert settings, Schedule settings shows that
  sentence with "Open Alert settings" instead of the address list, and a save
  never sends the list.
- **`initialVisitId`** on `<ScheduleCalendar>`: an alert's link opens its
  visit. One from another week is fetched and the calendar moves to its day;
  one that's gone shows a plain notice.
- **Photos and files links**: `visitFilesHref` on `<ScheduleCalendar>` adds
  "Photos and files" to the visit panel, and `filesHref` on `<CrewDay>` adds a
  "Photos" button to each stop of today's route.
