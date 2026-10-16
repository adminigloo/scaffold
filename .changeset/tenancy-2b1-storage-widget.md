---
"@adminigloo/storage-widget": minor
---

First release (Tenancy 2b-1): the photos and files screens for
`@adminigloo/storage`, under `./admin`. React is the only peer.

- **`RecordFiles`**: the photos and files of one visit, estimate or invoice.
  Photos as thumbnails, documents (and iPhone HEIC photos) as rows, each
  opening in a new tab. On a phone, "Take a photo" (the camera) and "Add photos
  or files"; on a desktop, one button and drop-on-the-card. Photos are made
  smaller before they're sent (a HEIC becomes a JPEG), with a progress bar. A
  photo that doesn't send is never lost: it stays as a card with "Try again"
  and "Save to phone", a dropped signal is retried once by itself, and leaving
  the page asks first. Every reason is in plain words: a site error page
  or a timeout reads "It didn't send. Try again in a minute; the photo is
  still here.", never a status code.
- **`FilesManager`**: the company Files screen, with how much room is left,
  filters by what files are attached to (visits, estimates, invoices, not
  attached, the logo), "Largest first", "Upload a file", "Copy a link (works
  for 1 hour)" and Remove (after a question), and where to change a file that
  is removed where it's used. `title={false}` for a page with its own
  heading, `logoSettings` for where the logo is changed.
- **`UsageMeter`**: "Using 120 MB of 5 GB", warning at 90 %, and what to do
  when it's full (with who to ask for more room and, with `supportEmail`,
  where to write); someone who can't remove files is told to ask the owner,
  and right after a file is refused for room it says full.
- `createFilesClient`, `shrinkPhoto`, the wire types, `filesWidgetCss` and
  `injectFilesStyles`. Follows the host page's light or dark theme, AA in
  both, 44 px targets on a phone, safe to render on the server, never throws.
