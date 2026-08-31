# @adminigloo/email

## 0.2.0

### Minor Changes

- React Email, on a new `@adminigloo/email/emails` entry point, with the
  invitation as the first template.
  
  The invitation body was a template literal in every generated project: a whole
  HTML document assembled by string concatenation, with an `escapeHtml` helper
  applied by hand at each interpolation. That is correct for exactly as long as
  nobody forgets one, and the cost of forgetting one is stored HTML injection
  carried by a message sent from the deployment's own authenticated domain — the
  highest-trust delivery path the product has. An organisation name is typed by a
  customer.
  
  - **`InvitationEmail`, `invitationSubject`, `invitationPlainText`,
    `renderInvitationHtml`, `renderInvitationEmail`.** React escapes children and
    attributes by construction, so escaping stops being a discipline. The
    components also carry the table scaffolding and the MSO conditionals that keep
    a button rectangular in Outlook, which is the other half of what a hand-rolled
    template maintains badly.
  - **Rendering is synchronous.** `renderEmailHtml` sits directly on
    `react-dom/server`'s `renderToStaticMarkup` rather than on
    `@react-email/render`, whose `render` returns a promise so that it can run
    Prettier over output no inbox reads. The one call site composes a message
    inside a function whose signature is fixed; an async body would ripple through
    every caller for pretty-printed HTML. The doctype is prepended, because React
    will not emit one and without it Outlook falls into quirks mode and
    reinterprets the table widths the layout rests on.
  - **Plain text is written by hand, per template, and is not derived from the
    markup.** A message with no text part scores as spam at most providers, so the
    text part is the difference between the invitation arriving and the invitation
    never being seen. The URL appears in full in both bodies: a link whose visible
    text and target differ is the strongest phishing signal a filter looks for.
  - **A separate entry point, for the same reason `./schema` is one.** Importing
    `createEmailSender` must not drag React, `react-dom/server` and the whole of
    `@react-email/components` in behind it — a webhook route or a queue worker
    that only sends would pay for a renderer it never calls. `react` and
    `react-dom` are peer dependencies; nothing on the root entry needs them.
  - **Nothing about the no-credential behaviour moved.** A send with no
    `RESEND_API_KEY` is still recorded as `skipped` with a real outcome and a real
    row in `email_events`, and the delivery event is still written on the failure
    path by hand where there is no outcome to take a log row from.

### Patch Changes

- Shared dependency versions moved to pnpm's `catalog:` protocol.
  
  `drizzle-orm` was written out in eleven manifests and `zod` in nine, so bumping
  either was a bulk edit nobody could review — and the failure mode of a missed
  line is silent: two packages built against two different minors of drizzle emit
  .d.ts files whose column types are structurally incompatible, and the error
  surfaces in a generated project as an unreadable mismatch between two packages
  that each look correct on their own. `pnpm-workspace.yaml` now names each
  version once.
  
  **Nothing changes in the published tarballs.** pnpm rewrites `catalog:` to the
  literal range when a package is packed, and the packed manifests were compared
  against the previous ones to confirm it: every dependency, devDependency and
  peerDependency range is byte-for-byte what it was. This is recorded because the
  manifests changed and because the replacement is a publish-time behaviour worth
  being able to find in a changelog, not because a consumer will see anything.
  
  There are TWO catalogs on purpose. The default names the single version this
  workspace builds and tests against; the `peers` catalog names the wider range
  published packages promise their consumers — `drizzle-orm` is built against
  `^0.45.2` and accepts `^0.45.0`, `zod` is built against v4 and still accepts
  v3.25+. Collapsing them into one entry would silently narrow every published
  peer range, which is a breaking change for every consumer one patch behind.
  
  A new test in `@adminigloo/create-app` fails if any workspace manifest goes back
  to spelling a catalogued range out, and if the ranges the generator writes into
  a new project drift from the catalog.
- `./emails` now says what a Next.js app has to do with it, at the top of the
  file that would otherwise take the app down.
  
  Everything on this entry point reaches `renderToStaticMarkup`, so it imports
  `react-dom/server`, and React's `react-server` export condition for that module
  is a file whose entire body is a throw. Every module a bundler pulls into the
  React Server Component graph — server components and route handlers alike —
  resolves under that condition. Reached from a tRPC router, as the invitation
  template is, that is not a broken email, it is every page in the application.
  
  The remedy is one line in the consuming app — name `@adminigloo/email` in
  `serverExternalPackages` — and it belongs in this doc comment because the
  symptom names `react-dom/server` and gives no hint that the fix is a config
  entry three directories away. `@adminigloo/create-app` emits it for any project
  generated with `--email`.
  
  Two things are recorded alongside it, both measured. Turbopack exempts
  node_modules from its react-dom/server rule, so an installed copy of this
  package is bundled into the RSC chunks and works without the setting — which
  is a heuristic about a path, not a contract, and is what the setting replaces.
  And an external has to be **installed**: Next matches on a resolved path inside
  `node_modules`, so a `link:` to a checkout is treated as project source and
  fails the build with "You're importing a component that imports
  react-dom/server". `transpilePackages` does not help, because transpiling is
  bundling.
  
  No behaviour change; this is documentation on a module whose failure mode is
  disproportionate to its size.
- Updated dependencies
  - @adminigloo/db@0.2.1
  - @adminigloo/env@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0

## 0.1.0

### Minor Changes

- Transactional email with a delivery log that degrades to a no-op instead of
  throwing when it is not configured.
  
  - `parseSenderAddress` accepts both `hello@x.com` and `Name <hello@x.com>`.
    riddler-go validated this with `z.string().email()`, which rejected the
    display-name form — including the exact string its own code used as a
    fallback — so setting the correct value took the server down at boot with an
    error that said only "Invalid email".
  - With no API key a send is recorded as `skipped` and the intent logged, so a
    developer can see what would have gone out. Throwing instead makes every
    feature that sends mail unusable until someone finds a key.
  - An unset webhook secret REFUSES to process delivery events rather than
    trusting the payload — without it the route cannot tell a real bounce from
    anyone on the internet POSTing JSON.
