# Feedback as a sellable component — design

Two packages turn Ask Lou's proven bug-report flow into AdminIgloo's first
licensed component. The split follows one question: **whose resources does the
code consume?** Code that runs in the buyer's browser goes in the widget; code
that touches our database, our blob store, and our keys stays on our platform.

```
buyer's React app                        AdminIgloo platform (our Next.js app)
┌──────────────────────────┐             ┌─────────────────────────────────────┐
│ @adminigloo/feedback-    │  HTTPS +    │ @adminigloo/feedback                │
│ widget                   │  client key │  createFeedbackHandlers({db, ...})  │
│  <FeedbackProvider>      │ ──────────▶ │   GET  /v1/config                   │
│  screenshot · annotate   │             │   POST /v1/upload  → Vercel Blob    │
│  session recorder        │             │   POST /v1/submit  → feedback_ticket│
│  submit client           │             │  key utils · ./schema (drizzle)     │
└──────────────────────────┘             └─────────────────────────────────────┘
```

## Why this split is the $15k architecture

- **The widget's only peer is React.** No tRPC, no Drizzle, no Tailwind, no
  Next.js APIs. A buyer on any React stack integrates in minutes — the "few
  hours per sale" promise is a dependency-list decision, not a hope.
- **The key is the license.** `aik_`-prefixed secret, SHA-256 hash stored in
  `feedback_client_keys` with a tenant id. Issue on sale, revoke on churn,
  meter later. Tenants are ordinary Company rows — the platform app is itself
  adminigloo-generated.
- **Improvements ship server-side.** Categories, storage, processing, triage
  all live on the platform. Most product improvements never require the buyer
  to update anything.

## Package 1: `@adminigloo/feedback-widget` (the sellable artifact)

Ported from Ask Lou (`askLou\SquireSolutions`), with its five couplings broken:
tRPC hooks → injected fetch transport; `useParams`/`usePathname` →
`window.location` + a `tenantRef` config prop; `EpicSelect`, admin-permission
and chat-context reads → dropped (platform-side concerns).

- **Capture**: `modern-screenshot` `domToCanvas` port of `screenshotService.ts`
  — sensitive-input redaction (`••••••••` + `finally` restore), modal excluded
  via `[data-aif-modal]`, crop to viewport, JPEG 0.92. Ask Lou's file lives
  under `src/server/` but is browser-pure; here it lives honestly in the
  client package.
- **Annotate**: canvas port of `AnnotationCanvas`/`AnnotationToolbar`/
  `useAnnotationCanvas` (freehand, rectangle, circle, arrow, text; undo/redo).
  Icons become inline SVGs — no `lucide-react` dependency.
- **Record**: `useSessionRecorder` port — click-trail ring buffer,
  `window.onerror` / `unhandledrejection` / patched `console.error`.
- **Style**: one prefixed stylesheet (`aif-*` classes) injected as a `<style>`
  tag by the provider. Zero assumptions about the host app's CSS.
- **API**: `<FeedbackProvider config={{ baseUrl, clientKey, reporter?,
  tenantRef?, metadata? }}>`, `<FeedbackButton />`, `useFeedback()` for custom
  triggers, `Ctrl+Shift+B` shortcut.
- `"use client"` banner via tsup config (first client-shipping package; the
  one sanctioned deviation from CLI-only tsup, precedent: create-app).

- **Overlays (0.3.0)**: the full-page capture drops `position: fixed` content,
  so an open modal / AI chat / toast was missing from the shot — the deferral
  below turned out to be the headline defect, not an extra. `captureOverlays`
  now finds every fixed layer on screen by computed style (not Ask Lou's
  opt-in markers — a buyer's markers are unknowable), captures each as a
  transparent PNG with the transform family neutralised (centred dialogs came
  out corner-only otherwise), paints backdrops in their real colour, and
  `stitchOverlays` composites them in paint order. The feedback modal is a
  native `<dialog>` (top layer) and contains its own presses/focus/wheel, so it
  works while a host (Radix) modal is open. Proven with pixels in real Chromium:
  `scaffold/e2e` (`cd e2e && pnpm install && pnpm test`).

Deferred from Ask Lou's version, deliberately: Capacitor native screenshot
detection, file attachments, epic picker. All are additive later.

## Package 2: `@adminigloo/feedback` (platform, ours)

Framework-light: handlers are `(req: Request) => Promise<Response>` (web
standard), mountable as Next route handlers in one line. Exports:

- `./schema` — `feedback_client_keys` (id, tenantId, keyHash unique, label,
  createdAt, revokedAt) and `feedback_tickets` (id, tenantId, ticketNumber
  `FB-XXXXX`, title, description, priority, category, status, screenshotUrl,
  annotatedScreenshotUrl, reporterName/Email, clientMetadata json,
  recentErrors json, pagePathname, createdAt). Host-pinned blob-URL
  validation, per Ask Lou's anti-phishing rule.
- `.` — `createFeedbackHandlers({ db, tables, blobToken?, limiter? })`,
  `generateClientKey()` / `hashClientKey()` / `verifyClientKey()`.

### The wire contract (v1)

Auth on every call: `x-adminigloo-key: aik_<hex>`. CORS is part of the
contract — the widget calls from the buyer's origin, so handlers answer
`OPTIONS` preflight and set `Access-Control-Allow-Origin` (key does the
gating, not origin).

| Endpoint | In | Out |
| --- | --- | --- |
| `GET /v1/config` | — | `{ categories: [{key, label, description}] }` |
| `POST /v1/upload` | multipart `file`, `kind: screenshot\|annotated` | `{ url }` — blob path `feedback/{tenantId}/{epochMs}-{kind}.jpg` |
| `POST /v1/submit` | JSON: description (min 10), priority, category?, screenshotUrl?, annotatedScreenshotUrl?, reporter?, clientMetadata, recentErrors? | `{ ticketNumber }` |

Degradation follows scaffold rule 4: no `blobToken` → upload answers 503
`{skipped}`, the widget submits without the image, and nothing throws.
Uploads stay ≤ 4 MB (Vercel serverless body limit).

## The test (be our own first client)

The adminIgloo testbed plays both roles: mounts the platform handlers +
schema + a key-issuance script (`scripts/issue-feedback-key.ts`, prints the
key once), and installs the widget from a packed tarball — the same artifact
a buyer would receive. Acceptance: issue key → open app → Ctrl+Shift+B →
screenshot → annotate → describe → submit → ticket row scoped to the right
Company, blob under the tenant prefix (when the token exists).

## Later, not now

Entitlements on keys (which features, expiry), usage metering, the admin
triage view as an overlay, error-log auto-linking (needs the platform's
observability tables), email notification, npm-registry read tokens as the
distribution channel for the widget itself.
