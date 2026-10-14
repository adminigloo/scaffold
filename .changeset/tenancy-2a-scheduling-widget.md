---
"@adminigloo/scheduling-widget": minor
---

Company features (Tenancy 2a).

- **`accentColor`** on the booking picker and the manage-your-visit page: the
  company's colour on buttons and highlights, with a text colour that stays
  readable (and a darker or lighter shade where the colour itself wouldn't be).
- **The closed message**: when the business isn't taking bookings online, the
  picker says so in its own words, with how to reach them, instead of an error.
- **Company-owned fields read-only** in schedule settings (name, time zone,
  contact details), with a link to company settings.
- **`inviteHref`**: "invite them on the Team page" where a crew needs someone
  to open its route.
- **Deep links** to a settings section (`#hours`, `#crews`, …) focus it.

After review: Today's route remembers the picked crew per schedule (so one
person in two companies never carries a crew between them), forgets a crew
that isn't there and shows the person's own route, and offers no other day to
a crew member; notices can carry a "where to fix it" link; an empty alerts
list says where alerts go.
