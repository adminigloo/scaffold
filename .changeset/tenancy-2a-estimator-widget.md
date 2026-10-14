---
"@adminigloo/estimator-widget": minor
---

Company features (Tenancy 2a).

- **Pattern hrefs**: `estimateHref` (on the queue, the editor and the admin
  shell) accepts a string with `{id}` ("/app/estimates/{id}") as well as a
  function, so a server page can pass it.
- **Company-owned fields read-only** in estimator settings (name, contact
  details, time zone, brand colour), under "These come from your company
  settings." with the link. The first-run form asks only for what is still
  the estimator's.
- **The site's ceiling** on photo-reading spend: the daily budget's hint says
  "Up to $x.xx a day on this site." and a budget above it is refused before
  saving.
- **The closed message**: when the business isn't taking estimates online, the
  estimate tool and the quote page show the server's sentence, with how to
  reach them.
- The company's **logo** beside its name on the estimate tool and the quote
  page, and a `#embed` deep link that focuses the website embed keys.
- **Read-only for people who can look but not change** (`canManage={false}`
  on `PriceBook`, `EstimatorSettings` and `EmbedKeys`): a company member who
  quotes from the price book sees it with no add, edit, retire or sample
  button, and estimate settings read-only, instead of controls the server
  would refuse. `EstimatesQueue` and `EstimateEditor` take it too, for a
  company's viewer: the estimates listed with no "New estimate", and each
  estimate shown in full with no action, edit or photo change ("You can see
  this estimate. Your role can't change it."). Without the prop nothing
  changes.
- **Fixed**: the website embed's two snippet boxes scroll sideways but
  couldn't take keyboard focus, so someone without a mouse couldn't read the
  end of the line to copy. Each now takes focus and is named by the line
  above it.
- **Fixed**: the accepted quote's "Pick a time for the work" button was
  painted in the banner's green on the business's colour, which nobody could
  read. A button in a banner now keeps its own colours.

After review:

- **Your website, no code**: with `publicPageUrl` (and `buttonColor`),
  `EmbedKeys` leads with a button and a page frame any website takes — Wix,
  Squarespace, WordPress — and folds the keyed React snippet under "For
  developers", saying what it needs.
- `notices={false}` on any staff screen, for the second screen on a page that
  already shows them.
- The sample price book asks which trade (lawn care, cleaning or ramps); a new
  product starts as "A count"; examples are no longer about ramps; the time
  zone is shown by name; an empty Lead alerts list says where alerts go.
