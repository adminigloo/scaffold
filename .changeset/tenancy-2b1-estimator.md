---
"@adminigloo/estimator": minor
---

Alerts and files (Tenancy 2b-1): a company hears about its leads in the app,
and keeps its estimate photos privately with the estimate.

- **Alert kinds and mapper**: `estimatorAlertKinds` (someone asks for an
  estimate; a customer accepts or declines a quote; a quote lapses; one "New
  estimate requests and quote answers" group) and `estimatorAlertsFor`
  ("New estimate request: Pat Rivera, $480 – $620 + tax (EST-2026-0001)":
  the price and number the office email and the customer were given),
  written exactly when the office email goes, under the same kind and key.
  Staff-made changes alert nobody.
- **Office emails through the one alert setting**: `officeRecipients` and
  `officeSent` on the comms listener, office emails through comms'
  `deliverNow`, as scheduling's. Without them, 0.4's behaviour exactly.
- **`alertsHref`** on the staff handlers: the Lead alerts panel points to Alert
  settings (`EstimatorSettingsWire.alertRecipients`), and a save drops the old
  list.
- **File records**: `estimatorFileRecords`, the estimate as something files
  belong to, its permissions deciding who sees them.
- **The photo purpose**: `estimatorPhotoPurpose`, a customer's estimate photo
  kept privately, counted but never refused because the company is full, and
  never more than a fifth of the company's storage.
- **Staff's own photos kept apart**: `estimatorStaffPhotoPurpose` and the
  admin handlers' `staffPhotoStore`, so a share filled by strangers' leads
  never refuses the business's own estimate photos. Without it, 0.4's single
  store.
- **Customers' photos count toward the day's caps once sent**: the per
  visitor and per business caps count every customer photo of the last 24
  hours, on a lead or not, so junk leads can't refill the store each day.
- **Photos named in plain words**: "Customer photo.jpg", "Estimate
  photo.jpg", never a hash.
- **Bodies read with a cap**: every route counts a body's bytes as they
  arrive and stops at its limit, so a self-hosted server is never made to
  hold a huge request.
- **Same origin only**: a POST from another subdomain of the same domain
  (`Sec-Fetch-Site: same-site`) is refused like one from another site.
- **Photos attached to their estimate**: the photo store's optional `attach`
  is called once a lead with photos is saved and when staff add a photo; a
  refusal is reported and changes nothing.
- **A full store answered in the estimator's own words**: a storage refusal
  becomes "You've added as many photos as we can take today…" (or the right
  sentence for a wrong type, a file too big, or storage switched off), never
  an error page. Staff are told where room can be made: estimates' photos
  when the share is full, the Files screen or estimates when the company
  is. A photo reading keeps going without the copy, and the lead still goes
  in.
- The comms peer is now `^0.4.0`.
