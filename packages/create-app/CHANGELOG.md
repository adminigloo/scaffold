# create-adminigloo-app

## 0.9.0

### Minor Changes

- Five things the generator emitted were wrong in ways nothing in this repository
  could see, because no workspace package typechecks the template.
  
  - **The admin sidebar shipped live 404s, and stranded two pages doing it.**
    `AdminNav.tsx` was a hand-written list inside the `admin-minimal` overlay, so
    it could see neither the `admin-full` pages layered on top of it nor the
    `catalog-admin` pages beside it. It argued that permission gating made a
    hardcoded list safe — true of `catalog.products.view`, which exists only once
    the catalog package is installed, and false of `staff.people.view` and
    `staff.roles.view`, which every project declares and `seed-roles.ts` grants to
    `admin` and `cs_lead`. A seeded administrator on an `--admin minimal` project
    saw People and Roles & permissions and got a 404 from both. Avoiding that trap
    is why `/admin/errors` and `/admin/support` had no entry at all: real pages, in
    every `--admin full` project, reachable only by typing the URL. The sidebar is
    now generated from `answers`, like `src/nav.ts`. Which items exist is settled
    at generation; who sees them is still settled at runtime by the permission
    filter, which is doing different work and is not a substitute.
  - **The dangling-link test had a hole the shape of the pattern it recommends.**
    It scanned `href="/…"` in every emitted file and `href: "…"` only inside
    `src/nav.ts`, so a const array of link objects in any other file fell between
    the two — which is exactly what `AdminNav.tsx` was. The `href:` scan now covers
    every emitted `.ts` and `.tsx`, and fails four configurations against the old
    sidebar.
  - **Commerce and billing permissions were spread into the wrong catalog.** Both
    fragments are written for the tenant ladder — every `defaultFor` in them names
    `owner`, `admin`, `member` or `viewer` — and both were pushed into the staff
    catalog, which has none of those but `admin`. So twelve keys quietly granted to
    the admin of the wrong ladder, and `plans.manage` and `subscriptions.manage`,
    being owner-only, reached no role at all. Which catalog a fragment goes into is
    now a column in one table, `renderPermissionsCatalog` groups by it, and
    `assertPermissionScopes` re-reads the emitted file on every generation to check
    each spread landed in its declared scope. A new test opens each package on disk
    and requires its defaults to name the ladder its row claims.
  - **`/products` returned a 500 on a project with no credentials.** It is linked
    from the header and the footer of every page, so on a fresh clone it was the
    first thing anyone clicked. It did try to handle a missing database — it caught
    the read and matched the error's name against `DatabaseNotConfiguredError` —
    but the read goes through `api()`, and a tRPC caller wraps whatever a procedure
    throws in a `TRPCError` and hangs the original off `.cause`. The name never
    arrived, the rethrow fired. `/products/[slug]` and `/checkout` had the same
    hole; the admin product pages had the same dead check behind a real guard.
    Every page now asks `isDbConfigured(db)` before it reads, which is what the
    other admin pages already did.
  - **`pino` was an undeclared peer.** It belongs to `@adminigloo/observability`,
    which every project installs, and `createLogger` imports it at the top of the
    module. It resolved only because pnpm and npm auto-install peers by default;
    with `auto-install-peers=false` a generated project did not build. A new test
    walks every package a project can install, in every configuration, and requires
    each of their peers to be named in the generated manifest.
  - **`src/versions.ts` pinned versions that predate the exports the template
    uses.** The drift test compared each pin against the version currently in the
    workspace manifest — which under changesets is the version already published,
    and therefore always one release behind the code the template is written
    against. `@adminigloo/observability` sat pinned at `^0.1.1` with a pending
    minor for `createErrorReporter`, an export every generated project imports, so
    a project generated against the registry resolved a release without it and did
    not compile. The pin is now checked against the version each package will carry
    once the pending changesets are applied, and it is a range check rather than an
    equality check: a patch needs no edit because a caret already admits it, and a
    minor below 1.0.0 forces one because a caret does not. A second assertion
    requires create-app to be released alongside any package whose minor it now
    depends on. `@adminigloo/testing` was the one range written out inline, where
    no drift test looked; it goes through the same table now.
- The nav existed on one page, and the one link it hardcoded was a 404.
  
  - **`AuthHeader` linked to `/admin` unconditionally.** A project generated with
    `--admin none` emits no `app/admin` route at all, so every signed-in user in
    that configuration saw a link to a 404 — the exact bug `SITE_LINKS` was
    introduced to kill, in the file that introduced it. `src/nav.ts` now also
    emits `APP_LINKS`, which carries the admin entry only in projects that have
    one and is empty otherwise. No flag, no null, no `if` in an emitted file.
  - **The header was mounted inside `app/page.tsx` and nowhere else.** The
    storefront, product pages, the checkout, `/setup` and the Clerk pages all
    rendered with no navigation — arrive at a product from a link and there was no
    route to the rest of the site. New `app/(site)/layout.tsx` carries a real
    header and footer for every public page; a route group, so no URL changes.
    `app/admin` stays outside it, because the admin shell is already a full-height
    sidebar layout and a second header would push it off screen.
  - **`FOOTER_LINKS` is generated the same way.** The primary nav stays short;
    `/setup` is a diagnostics page rather than somewhere a customer goes, but it
    is the page you need after something else has broken, so it has to be
    reachable from everywhere. Every entry is justified in a comment in the
    generated file.
  - **The storefront built product URLs by hand** while `src/storefront.ts`
    documented itself as the single place that knows the route. Now routed through
    `productHref`, so a slug needing an escape cannot resolve in the admin and 404
    in the shop.
  
  A new test walks every href in a generated `nav.ts` and every literal `href` in
  every emitted page, and fails unless the route is in the same `planEmit` plan —
  the general form of all three, so it catches the next one.
- A generated project could not add a second person to a tenant. Now it can, and
  the two packages that existed to make that possible have a caller.
  
  - **An invitations router, on the right rungs.** `send`, `list`, `resend` and
    `revoke` are `requireTenant("members.invite")` — inviting somebody into an
    organisation is that organisation's business, not the firm's, and the key was
    already declared in `@adminigloo/tenancy`'s tenant fragment, so nothing new
    was added to the catalog. `accept` is one rung LOWER, on `protectedProcedure`,
    because an invitee is by definition not a member yet: built from
    `requireTenant` it would deny every invitee who ever followed a link, and the
    message would be "Not a member of tenant …". The token is the authorisation
    there, and that is stated at the procedure rather than implied.
  - **`accept` returns a discriminated union, and never throws.** Six outcomes —
    accepted, expired, revoked, already-a-member, wrong-email, unknown — each with
    its own screen and its own next step. A thrown error collapses all of them
    into one red box offering the same non-advice to somebody who has expired,
    somebody who is already in, and somebody signed in as the wrong person. The
    union is re-mapped at the router rather than returned raw: the invited
    address, the inviter and the invitation id all stay server-side, because
    whoever holds the link may not be who it was sent to.
  - **`/invite/[token]` resolves nothing before sign-in.** A GET carrying a bearer
    token is fetched by prefetchers, mail scanners and preview bots. Looking the
    token up on render would tell any of them that an invitation exists and who it
    is from; accepting on render would let a corporate mail scanner join the
    organisation on the invitee's behalf. So the signed-out screen says only that
    an invitation exists at this URL, which the visitor already knew, and an
    unknown token is indistinguishable from a real one until somebody presses a
    button. Sign-up and sign-in now honour `?redirect_url=`, through a
    `safeReturnPath` guard that refuses anything that could leave the site —
    without it a new account lands on the home page and the only copy of the token
    is gone, because only its hash was ever stored.
  - **Resend mints a NEW link, and the UI says why.** There is no old one: the
    database holds a SHA-256 and the plaintext exists only in the mail that was
    sent. Re-issuing rotates the hash and pushes the expiry out on the same row,
    which is what the schema's partial unique index was designed for.
  - **The invitation URL comes back to the inviter only when nothing was posted.**
    With no Resend key the send is recorded as `skipped` and the members page
    offers the link to copy, so the whole feature works on a laptop with no
    credentials. Once a provider accepts the message the link is withheld — the
    invitee has it, and there is no reason to put a bearer credential for somebody
    else's account in the inviter's browser history.
  - **A rank guard on who may be invited as what.** `members.invite` says you may
    invite; it does not say you may invite your equal or your superior. An admin
    who could issue an owner invitation would mail it to an address they control
    and collect `tenant.transfer`, which the catalog seals precisely so it cannot
    be handed to one person quietly. `canManageTemplateKey` is strictly greater,
    so admin-invites-admin fails too, and an actor with no role template at all
    fails closed.
  - **`revoke(id)` is bound to the tenant before it runs.** The service signature
    takes no tenant, so an id alone would cancel a stranger's invitation from
    inside your own organisation — an IDOR the procedure ladder cannot catch,
    because the caller really does hold `members.invite`, just somewhere else.
    Every id is resolved through `listForTenant(ctx.tenantId)` first.
  - **`src/server/audit.ts` is now generated, and there is one registry.** The
    admin router declared its own and the catalog router declared another; two
    registries cannot detect a collision between them, and `admin.recentAudit`
    could only label the keys it held — so catalog actions rendered in the audit
    viewer as raw strings. The fragments are composed with `contributedBy`, which
    throws at boot on a duplicate. `invitation.accepted` is the only one of the
    three new keys marked sensitive: sending grants nothing, accepting is the
    instant the data becomes readable to a stranger.
  - **`src/server/invitation-mail.ts` is generated in two variants with one
    signature**, so no emitted file holds an `if` asking whether `@adminigloo/email`
    was installed. With `--email` it renders the template, sends through
    `createEmailSender` and writes the row to `email_events` — including the
    skipped ones, which are exactly the rows somebody debugging "why did they not
    get the email" needs and the ones a provider dashboard by definition lacks.
    Without it, every send is a real `skipped` outcome and the link is handed
    back. `EMAIL_FROM` is deferred until deployment and `createEmailSender` throws
    at construction on a From it cannot parse, so the fallback is an RFC 2606
    reserved address rather than a module-scope crash on every laptop.
  - **A new `email` overlay** carries the invitation template and `/setup/email`,
    a preview rendered from sample data that reads no database, no session and no
    query parameters. An email template is the one piece of UI with no way to look
    at it; without a preview the loop is edit, deploy, invite somebody, wait, and
    the copy stays as first written. Linked from the footer exactly in the
    projects that have the page.
  - **`app/(site)/members/page.tsx`**, the surface all of this hangs off, with the
    roster, the invite form and the pending list. `src/server/tenant.ts` decides
    which tenant a page is looking at — the seam to replace with a subdomain, a
    slug segment or a switcher, and deliberately the dullest implementation that
    works, because the alternative was every page inventing its own answer.
  
  A new test walks the other way round the nav: every emitted page route must be
  reachable from a generated nav array or the admin sidebar, or be listed with the
  reason it is reached another way. That list is short and it is checked for stale
  entries. `/invite/[token]` is on it — the URL is a one-time secret, so there is
  nothing to put in a header — which is the whole point of writing the reason
  down rather than leaving the page quietly stranded.
- Three things were true only because somebody remembered them. Now they are
  mechanical.
  
  - **`adminigloo.json`, written into every generated project.** The answers, the
    installed packages with their ranges, the overlays applied, the capabilities
    the project expects to have, and which environment variables block boot as
    against which merely change documented behaviour. Until now "what is enabled
    here?" was answerable only by reading `package.json` and walking the directory
    tree, so every tool that needed to know re-derived it and they drifted — the
    hardcoded `/admin` link in a `--admin none` project was that drift reaching a
    customer. The manifest is the prerequisite for the generator matrix, for a
    `doctor` command, and for the component registry when it lands.
  
    It says in its own `//` key that nobody maintains it by hand, because JSON has
    no comments and people open this file. Every field is DERIVED, and that is the
    load-bearing property rather than a simplification: a manifest that is purely
    a function of the answers can be rebuilt and compared against the copy on
    disk, which is the only way drift becomes something a tool can find. One
    hand-written field anywhere would end that for the whole file. It is therefore
    also why there is nowhere in the manifest to record a forked module — forking
    is real, no tool can infer it, and it belongs somewhere that says plainly
    which part a person owns.
  
  - **`SCAFFOLD.md` is now generated FROM the manifest, not alongside it.** Both
    files state the same facts. Deriving each separately from `answers` is two
    implementations of one truth, and the day somebody adds a question and updates
    one renderer, the human-readable copy is the one people believe.
    `renderScaffoldRecord` takes a `ProjectManifest` rather than `Answers`, which
    is a breaking change for anyone calling it directly. It gained an overlay list
    and a capability list, and the fork section is now explicitly marked as the
    one section a person maintains.
  
  - **A nightly generator matrix.** `OverlayCollisionError` proves no two overlays
    write the same path, which is a far weaker statement than it sounds: it says
    the file sets are disjoint and says nothing about whether a combination
    typechecks or builds. Six combinations now go through
    `pnpm install && typecheck && build` against the real registry, chosen to
    cover six DISTINCT overlay sets rather than six plausible-looking products —
    including the degenerate corners nobody generates by hand, which is exactly
    where an additive-overlay system fails. Each run asserts the overlay set it
    actually produced against the one the matrix claims, so a combination cannot
    quietly stop covering what its comment says it covers.
  
  - **`capabilitiesFor` and `overlayNamesFor`** are exported from `answers.js`.
    Overlay selection used to live inside the emitter, where the manifest could
    not see it; it is an answers-derived structural decision like `packagesFor`
    and now sits beside it.
  
  - **A missing overlay directory is an error rather than a silent skip.** It was
    survivable while the only record of what a project had was the project. It is
    not now that `adminigloo.json` states it: a skipped overlay would make the
    manifest claim a capability nothing on disk provides.
  
  - **`@trpc/client`, `@trpc/react-query` and `@trpc/server` are pinned to
    `^11.18.0`** in a generated project rather than to `@adminigloo/trpc`'s peer
    floor of `^11.0.0`. The floor says what still works; the pin says what was
    actually tested. A new test binds these and every other shared dependency to
    the workspace catalog, because the generated project is not a workspace member
    and nothing else would notice it falling behind.
  
  - **The governing rules are in `README.md`**, with the failure each one prevents
    attached — including the restatement that earned its own heading, that
    conditionals are allowed in the generator and forbidden in the artifact, and
    the explicit prohibition on Clerk's `has()`, Clerk Plans and Clerk Billing.
- The observability work had shipped as two parallel implementations of the same
  thing, and the manifest claimed a capability no generated file provided.
  
  **Rate limiting: the package's implementation survives, the template's is
  deleted.** `src/server/rate-limit.ts` held its own Upstash REST adapter — the
  same two commands, the same `PEXPIRE … NX` reasoning, the same fallback to an
  in-process Map — written out beside the one already published in
  `createRateLimiter`. Two copies of a limiter is the arrangement where a fix to
  the timeout, the pipeline body or the malformed-reply guard lands in one of them
  and the endpoint protected by the other keeps the bug. The file is now two
  `createRateLimiter` calls and nothing else: `limiter`, which fails open, and
  `failClosedLimiter`, which does not. The "dependency-free" argument for the
  local copy did not apply — it imported `@adminigloo/observability` and `@/env`
  already, so it could never have run on the edge.
  
  **The ladder is actually limited now.** `createProcedures(t, loaders)` was
  called with two arguments, so the `rateLimit` option, `RATE_LIMIT_POLICIES` and
  `enforceRateLimit` were shipped, tested and installed on nothing. Every
  procedure in every generated project was unmeasured. It takes the third
  argument now; the 61st anonymous call to `health` is refused, which is the
  documented budget of 60.
  
  **Both webhook routes and the error-report endpoint are bounded.** Webhooks are
  keyed by provider — Stripe and Clerk deliver from a pool of addresses, so a
  per-address limit bounds nothing — and the check runs **after** signature
  verification, because limiting first would let anyone on the internet spend the
  budget and have genuine payment events refused. The error-report endpoint moves
  from `checkRateLimit` plus a hand-written try/catch to `failClosedLimiter`,
  which carries the fail-closed decision as a construction argument. One
  behavioural narrowing, stated plainly: an unreachable store now answers 429
  rather than 503, because nothing the client could do differs between "you are
  over budget" and "we cannot tell", and the distinction is in the warning the
  limiter logs.
  
  **Request id: the package's implementation survives here too, and
  `src/request-id.ts` is deleted.** That copy existed because the barrel drags
  `pino` into an edge bundle; the answer is the new
  `@adminigloo/observability/request` subpath, which imports nothing, rather than
  a second implementation. The local copy never validated the inbound header — a
  newline in `x-request-id` went straight into every log line for that request.
  
  **The loop closes.** `createScaffoldContext` was called with no headers, so
  `ctx.requestId` was a fresh UUID per request rather than the one the proxy
  stamped, `ctx.ipAddress` was always null (which also left every anonymous
  procedure unlimited, since the key is the address), and no emitted file read
  either. `createContext` now takes the request's headers — from `req.headers` in
  the fetch handler and from `headers()` in the RSC caller — and the tRPC
  `onError` reads `ctx.requestId` for both the log line and the `error_log` row.
  A new `src/server/logger.ts` gives the project the `createLogger` it never had,
  with `requestLog(id)` as the child that puts the id on every line. Verified
  live: one id in the response header, in `procedure failed`, and in the reporter.
  
  **`ai.streaming` is now true.** `--ai` contributed `aiServer()` to the
  environment, `aiPermissions` to the catalog and `ai_usage` to the schema, and
  nothing that ever called a model, while `adminigloo.json` told the matrix CI the
  project could stream. A new `ai` overlay ships `app/api/ai/chat/route.ts`, built
  on `createStreamRoute` so authorization cannot drift below the first flushed
  byte, metered through `meterStream` so a cancelled request still costs what it
  cost, and rate-limited per minute **and** per day against `failClosedLimiter` —
  an unthrottled model route is the one omission that produces a same-day invoice.
  With no key it answers 503 with the empty provider list. The `ai_usage` rows it
  writes are readable through `ai.spend`, priced in integer micros from a rate
  table the app owns.
  
  **And the manifest is self-checking.** `CAPABILITY_EVIDENCE` names, for every
  key `capabilitiesFor` can emit, the file in the generated project that provides
  it; `assertCapabilitiesAreProvable` runs at the end of every `planEmit` against
  the files actually written, and refuses to produce a project whose manifest
  claims something absent. Reading the output rather than the answers is the
  load-bearing half — a predicate over `answers` would restate `capabilitiesFor`
  and pass for ever. Two honest findings are recorded rather than papered over in
  `UNDISTINGUISHED_CAPABILITIES`: `--tenant none` and `--tenant Workspace` emit
  identical bytes, and so do all three money-taking models — so a `--model
  one-time` project ships every line of the subscription path and merely declines
  to claim it.
- Generated projects had no error boundaries and nothing that recorded a failure.
  
  - **No `error.tsx`, `global-error.tsx`, `not-found.tsx` or `loading.tsx`
    anywhere.** An unhandled render error reached a client's customer as
    "Application error: a client-side exception has occurred" on a blank page with
    no way back, and a throw in the root layout was caught by nothing at all. The
    boundaries are now placed by what fails and how it recovers, rather than one
    of each at the root: `app/global-error.tsx` renders its own `<html>` and
    `<body>` because it replaces the root layout; `app/error.tsx` catches a
    segment LAYOUT throwing, which no boundary beside that layout can;
    `app/(site)/error.tsx` sits inside the route group so the header and footer
    stay on screen; `app/admin/*` gets its own set so the sidebar survives; and
    the storefront gets two, because `/checkout/success` is reached only after
    Stripe has taken the money and must never inherit "nothing was charged".
  - **Every boundary offers a route that exists.** The way back is `/`, `/setup`,
    or a route from the overlay that owns the boundary — never a link a
    configuration may not have installed. The 404 reads its map from the generated
    `src/nav.ts` rather than writing one out.
  - **Nothing reported.** `createErrorReporter` is now wired at every producer:
    both webhook routes, the tRPC handler's `onError` (internal faults only — a
    FORBIDDEN is the permission ladder working), and the React boundaries through
    a new rate-limited `POST /api/error-report`, since a client component cannot
    reach the database. The request id is attached everywhere; `proxy.ts` mints
    one so a page, its tRPC call and the error either produces share a value.
    Next's `digest` is carried from the boundary and kept out of the normalised
    message, so digest-bearing reports do not all collapse into one row.
  - **`observabilityServer()` was never spread into the generated `src/env.ts`.**
    It was the one installed package whose fragment was missing, so `SENTRY_DSN`,
    `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` existed in no
    project's contract: `/setup` could not report on them and the rate limiter had
    no way to be pointed at a shared store. Now spread unconditionally, surfaced
    on `/setup` from `OBSERVABILITY_ENV_GROUPS`, and listed in `.env.example`
    under a new optional section — a variable absent from that file is one nobody
    discovers exists.
  - **A new `src/server/rate-limit.ts`** picks Upstash when both variables are
    set and an in-process store when they are not, so the app still boots with no
    credentials. `DEPLOYMENT.md` says plainly that the fallback multiplies the
    limit by the instance count.
  
  Requires the `@adminigloo/observability` release that adds `createErrorReporter`
  — bump `PACKAGE_VERSIONS` in `emit.ts` when it lands, which
  `versions.test.ts` will insist on anyway.
- `next.config.ts` is generated, and a `--email` project keeps its email renderer
  out of the React Server Component graph on purpose rather than by luck.
  
  **The setting.** `@adminigloo/email/emails` renders the message bodies with
  React Email, so it imports `react-dom/server` — and React ships a `react-server`
  export condition for that module whose entire body is
  `throw new Error("react-dom/server is not supported in React Server
  Components")`. Everything a bundler pulls into the RSC graph resolves under that
  condition, route handlers included, so the renderer cannot be in the graph. In a
  `--email` project it is reached from `src/emails/invitation.ts` through
  `src/server/invitation-mail.ts`, the invitations router and `_app.ts` into
  `src/trpc/server.ts`, which every server component that calls `api()` imports:
  one template, and the trace covers the application. Naming the package in
  `serverExternalPackages` moves the module out of the bundle and into a runtime
  `require`, where node conditions apply and `react-dom/server` is the real
  renderer. Nothing about where the render happens changes — composing an email is
  server work, it stays on the server, and it stays synchronous.
  
  **Why the config file is now emitted rather than copied.** The list depends on
  which packages were installed, and a static `template/next.config.ts` could only
  carry that as an `if`. Conditionals belong in the generator; the artifact states
  its answer as a literal array, with the reasoning above written above it.
  
  **What was actually happening, measured rather than assumed.** Without the
  setting, a `--email` project installed normally still builds: Turbopack does not
  apply its `react-dom/server` rule to files under `node_modules`, bundles the
  real Node build of the renderer into the RSC chunks, and everything works. That
  is a heuristic about a path, not a contract, and it is the definition of passing
  because the bundler declined to look. With the setting, `renderToStaticMarkup`
  is absent from `.next/server` entirely and the module is loaded by Node at
  request time — the same behaviour, obtained on purpose.
  
  The one topology it cannot rescue is a package **linked** rather than installed.
  Next matches an external on a resolved path containing `node_modules/<name>/`,
  so a `link:` dependency pointing at a checkout is bundled regardless, is treated
  as project source, and fails the build with "You're importing a component that
  imports react-dom/server". `transpilePackages` does not help either, because
  transpiling is bundling. That is the topology a local `link:`-based harness
  produces and no configuration fixes it; `scripts/verify-generated.mjs` now packs
  and installs instead, which is what both CI jobs already did.
  
  **A test that tested nothing, and the guard for the class.** The email overlay's
  `expect(source).toContain("escapeHtml")` was meant to prove the invitation body
  escapes what it interpolates. The only `escapeHtml` left in that file is inside
  the comment recording that the helper was deleted, so the assertion passed on
  its subject's obituary and would have gone on passing had the body been replaced
  with raw string concatenation. It is now three assertions about the emitted
  code: the three composition calls that make the file a seam, the absence of any
  markup or entity to escape, and the synchronous signature the mailer depends on.
  The Clerk header's `toContain("<SignedIn>")` was the same shape — satisfied by
  the warning telling you never to use one — and now reads the comment through
  `commentsIn` while asserting the code does not contain it.
  
  Because this is a suite whose whole method is grepping generated source, the
  failure is systemic: a new describe block reads the suite's own text and fails
  if any `toContain` literal is satisfied only by comments in the emitted project,
  with a two-row allowlist for the assertions whose subject genuinely is prose.
  
  **And the check that would have caught a project that cannot serve a page.**
  `.github/scripts/route-sweep.sh` boots a generated project and requests every
  page the build emitted, reading the route list off `app/**/page.tsx` so an
  overlay's pages are covered the day they are added. A 3xx passes — with no
  credentials every `/admin` route redirects to sign-in — and a 4xx or 5xx does
  not. The nightly generator matrix sweeps `next start`; the per-PR `generate` job
  sweeps `next start` and `next dev`, which compile by different paths. `tsc
  --noEmit` and `vitest run` were both green on a configuration where every route
  but `/` answered 500, because neither one crosses Next's RSC boundary.

## 0.8.0

### Minor Changes

- Tailwind, the product builder, in-app checkout — and three bugs that made the
  whole thing unusable.
  
  - **commerce could never create its tables.** `minSubtotalMinor.default(0n)`
    crashed drizzle-kit with "Do not know how to serialize a BigInt" during
    `generate` — while still leaving a journal behind, so the next `migrate`
    reported "applied successfully" having applied nothing. Now `sql\`0\``.
  - **The generated schema barrel omitted commerce and billing.** Orders, plans,
    subscriptions and entitlements were absent from every migration.
  - **catalog's permissions were tenant-scoped but gated with `requireStaff`.**
    Defining what is for sale is an operator activity; declared under "tenant"
    those keys could never match, so the whole Products section was invisible with
    no error anywhere. Now staff-scoped with staff defaults, and a test asserts no
    key names a non-staff template.
  
  Also: Tailwind v4 with a token set both themes share, a real admin shell, the
  product builder with a Stripe sync plan shown before you publish, embedded
  Payment Element checkout, and `src/permissions/catalog.ts` is now generated so
  package fragments land in the scope their callers actually read.

## 0.7.0

### Minor Changes

- A product catalog both commerce and billing can sell from.
  
  There was nowhere to define a product. `commerce` stores `orderItems.productRef`
  as a bare string, and `billing.plans` models recurring subscriptions only — so a
  project selling a physical thing had no catalog at all.
  
  - `products` / `product_variants` / `product_grants`. The grant is the seam that
    lets one checkout serve a deck of cards and a SaaS seat without either knowing
    about the other.
  - `planStripeSync()` is a PLANNER, not a caller, because Stripe prices are
    immutable: you cannot change an amount, currency or interval on an existing
    Price. A sync that tries to patch one silently no-ops and the customer is
    charged the old amount forever. Currency comparison is case-normalised —
    case-sensitive, a hand-typed `USD` reads as a change and archives-and-recreates
    the price on every run, orphaning subscriptions across a trail of prices.
  - `formatMinor()` never converts through `number`. JPY has no minor unit, so
    dividing by 100 is wrong, and a large bigint loses its last digit.
  - Archived is not deleted: an archived product must still render on the order
    that bought it.

## 0.6.0

### Minor Changes

- Sign-in actually exists now.
  
  - Adds `/sign-in` and `/sign-up` as Clerk catch-all routes. The `[[...sign-in]]`
    segment is required, not decorative: Clerk routes verification, second factor
    and reset as sub-paths, so a plain `sign-in/page.tsx` renders the first screen
    and 404s the moment anyone needs a second step. Previously there was no
    sign-in page at all — `/sign-in` was a 404.
  - Adds a header with sign-in / user button / admin link, written as a SERVER
    component reading `auth()`. Clerk Core 3 removed `<SignedIn>` / `<SignedOut>`,
    and they throw at render rather than at build — the code looks correct until
    the page 500s.
  - `drizzle.config.ts` loads `.env.local` itself. drizzle-kit is a standalone
    binary and does not read it the way Next does, so `pnpm db:migrate` failed
    with "url: ''" while the app connected fine — which reads as a broken config
    rather than an unloaded file. `db:seed` gets `--env-file` for the same reason.

## 0.5.2

### Patch Changes

- A generated project now boots with no credentials at all.
  
  Three separate places threw before anything could render, each of them before
  the setup page that would explain what was missing:
  
  - `proxy.ts` called `clerkMiddleware()` unconditionally. It runs on the EDGE,
    before layout and before any page, so a project with no Clerk account 500s on
    every request — the first thing you see after generating is a stack trace.
  - The Clerk webhook route assumed a signing secret. It now answers 503, not 200:
    a 200 would make Clerk record the delivery as successful and never retry it
    once the secret is set.
  - The setup page reported "Everything is configured" while nothing was, because
    `report.ok` means "valid for the environment you are in" and locally these are
    deferred. It now counts what is still outstanding for a deployment.
  
  Verified with an empty `.env.local`: home 200, /setup 200, and tRPC returns
  `{"ok":true}` through the full client-server chain.

## 0.5.1

### Patch Changes

- Generated projects install the CURRENT package versions.
  
  Every dependency was pinned at `^0.1.0`. A caret range on a 0.x version means
  `>=0.1.0 <0.2.0`, so the moment `@adminigloo/env` shipped 0.2.0 a freshly
  generated project quietly installed the old one — everything resolved,
  everything built, and the feature the release added simply was not there.
  
  Versions are now explicit and a test reads the workspace manifests, so the build
  fails if the list drifts.

## 0.5.0

### Minor Changes

- A generated project now runs before its credentials exist.
  
  Requiring Neon, Clerk and Stripe accounts before `pnpm dev` works once is
  backwards for a scaffold whose point is starting fast. Strictness now scales
  with environment instead.
  
  - `defineEnv({ optionalUntilDeployed })` relaxes a variable ONLY when it is
    absent and only on a laptop. A value that is present but malformed still fails
    at boot everywhere — a mistyped connection string is not a deferred
    credential. Deployments relax nothing.
  - The relaxed keys widen to `| undefined` in the type, so a consumer cannot read
    one as a definite string and get undefined at runtime.
  - `describeEnv()` returns a serialisable report of what is configured, what is
    missing, and which feature each gap disables. It never returns a value — a
    setup page that echoes a secret is worse than no setup page.
  - `createDb()` accepts an absent connection string and returns a handle that
    throws a typed error naming `DATABASE_URL` and `.env.local` on first query,
    rather than crashing at import with "cannot read property select of null".
  - The generator writes a ready-to-run `.env.local`, mounts ClerkProvider only
    when Clerk is configured, and ships a `/setup` page reading the same schemas
    boot validation uses — so it cannot drift the first time a package is added.
  
  The key-mode assertion is untouched. A live key still refuses to run outside
  production, in every environment, and neither `SKIP_ENV_VALIDATION` nor listing
  that key as deferrable can switch it off.

## 0.4.0

### Minor Changes

- A signed-in user now always has a local row, so local development works.
  
  The `users` row is created by the Clerk webhook, and a webhook needs a public
  URL — which localhost is not. On a laptop you signed in successfully, no row was
  ever written, every `currentPrincipal()` returned null, and the app treated you
  as a stranger while Clerk's UI showed you as signed in. There was no error to
  search for.
  
  `currentPrincipal` now mirrors the user from the session it already holds, and
  mints their personal workspace. Deliberately NOT gated on NODE_ENV: webhook
  delivery is best-effort everywhere, and a dropped delivery in production leaves
  a paying customer permanently locked out of a product they can see. The webhook
  still keeps the row fresh; this only guarantees it exists. The unique index on
  (identity_provider, external_id) makes the two safe to race, and a soft-deleted
  row is never resurrected.

## 0.3.1

### Patch Changes

- A clean first build.
  
  - `middleware.ts` becomes `proxy.ts`, Next 16's rename. The old name still works
    and warns on every single build, which is exactly the kind of noise you learn
    to scroll past — and then miss the warning that matters.
  - Pins `turbopack.root` to the generated project. Next walks up looking for a
    lockfile, so a project created below another one infers the wrong workspace
    root and warns forever.

## 0.3.0

### Minor Changes

- The generated app can now actually call its own API.
  
  - Adds `src/trpc/client.tsx` (typed React client + provider, wired into the root
    layout) and `src/trpc/server.ts` (RSC caller). Without these the server route
    existed and no component could reach it — `@trpc/react-query` was a dependency
    with nothing importing it.
  - Both clients are created inside `useState` initialisers. A module-level
    QueryClient is shared across every request the server handles, so one user's
    cached data can render for the next.
  - Authorization failures are never retried: the answer will not change, and
    retrying turns one 403 into four in the log.
  - Adds `tsx` (the seed script is run, not built) and `server-only`, plus a
    `db:seed` script — `scripts/seed-roles.ts` told you to run `pnpm tsx` with tsx
    absent from devDependencies.

## 0.2.0

### Minor Changes

- The generator now wires the whole base.
  
  - Re-exports a schema for EVERY installed package that owns a table. It omitted
    `ai`, `email` and `observability`; `drizzle.config` points at that one file, so
    their tables were absent from every migration — the app compiled, booted, and
    failed on the first insert against a table nobody created.
  - Composes an env fragment per installed package, and asks only for variables
    those packages declare. It listed `RESEND_FROM_EMAIL`, which nothing reads,
    while `EMAIL_FROM`, which is required, went unmentioned and the app refused to
    boot.
  - Admin shell as copied source, layered additively. Overlays collide loudly
    rather than overwriting a base file. The permission checklist has three states
    per row — inherit / allow / deny — because a checkbox cannot distinguish
    "inherited from the template" from "set for this person", and sealed rows say
    so instead of silently refusing to stick.
  - Stripe webhook route implementing the full claim protocol, including
    release-on-failure — the step whose absence wedges an event forever.
  - `--model`, `--admin`, `--tenant-noun`, `--ai`, `--email` make it scriptable,
    and reject an unknown value rather than silently defaulting.
  - Seeds role templates idempotently, and never rewrites a template someone has
    customised.

## 0.1.0

### Minor Changes

- The generator. `npx create-adminigloo-app <name>` emits a Next.js project with
  auth, tenancy, permissions, tRPC and the environment contract already wired.
  
  - Answers resolve at generation time into a different set of files and
    dependencies. Nothing becomes a conditional in the emitted app.
  - Plans every file before writing any, so a failure leaves an empty directory
    rather than a half-generated project that looks complete.
  - Non-interactive whenever stdin is not a TTY, so it cannot hang inside CI
    waiting on a prompt nobody can answer.
  - Only depends on packages that are actually published — a generated project
    whose first `pnpm install` 404s is worse than one missing a feature.
  - Writes `SCAFFOLD.md` recording every answer and the packages installed, so a
    later fork can be diffed against the version that produced it.
