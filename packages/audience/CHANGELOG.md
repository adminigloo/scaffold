# @adminigloo/audience

## 0.1.0

### Minor Changes

- First release: keep staff, testers, automation and a named list of people out of an app's numbers, and clean the numbers already polluted. It was built for Rachel's requirement on Riddler Go and Riddler Road Rally.

  **The model**
  - Eleven rule kinds: `user`, `email` (Gmail dot and `+tag` folding), `email_domain`, `email_pattern` (substring or glob), `org`, `event`, `order`, `visitor`, `network` (IPv4/IPv6 CIDR), `host` (a production allow-list) and `user_agent`. The app's own rule in code, `isInternal(user)`, sits beside them.
  - Zero-config defaults: `+clerk_test@` and `+test@` addresses, the reserved domains, local hosts and `*.vercel.app`, the automation user agents, `navigator.webdriver`, a smoke-test header whose value is derived from `AUDIENCE_SECRET` (`audience.testHeader`), and crawlers counted apart as `bot`. Each group can be switched off.
  - A fixed reason precedence, so each session is counted under exactly one reason and the per-reason counts add up to the total. An automation user agent is never also called a bot.
  - Each reason marks what it is about. Reasons about the person (role, named user, email, domain, pattern, org membership) mark the device and the user. Reasons about one request (automation, bot, non-production, network) mark the **session** passed as `sessionId`, so one visit from the office network never wipes a customer's history. A test event or order marks the acting session, never the device.
  - An `org` rule's members are internal, at intake and in history (through `user.orgIds` from `listUsers`). Event and order rules mark the event or order itself and say plainly that session counts do not change.
  - A production-host miss is owned by the `host` rules that caused it, so removing a mistyped rule counts those visits again.

  **Storage and privacy**
  - Four tables under a configurable prefix (default `aig_audience_`): rules, marks, links, runs. A partial unique index makes every write idempotent.
  - Nothing is ever hard-deleted. Removing a rule disables it and clears its marks.
  - A mark can never outlive its rule: the Drizzle store inserts a rule's mark only while the rule is active, checked in the same statement with the rule row share-locked, so an instance still caching a removed rule writes nothing. `maintain()` clears any such mark a custom store let through.
  - There is no IP column anywhere. Network rules are matched in memory and the address is dropped.
  - Links store `HMAC(AUDIENCE_SECRET, tenant ‖ userId)` (pseudonymous), never the user id. There are two modes: `internal-only` (the default) and `pseudonymous`. A link is written only when the call says the browser did not opt out (`headers` or `privacyOptOut`), so Global Privacy Control and Do Not Track are honoured by `observe` and `classifyActor` alike.
  - `previousSecrets` keeps links readable across a rotation of `AUDIENCE_SECRET`. A secret must be 32+ characters and not a placeholder.
  - Ids from cookies and request bodies are cleaned (at most 200 characters, no control characters; numeric ids become their digits) before anything is written.

  **Reads**
  - Exclusion is a read-time `NOT EXISTS` anti-join: `countedVisitorSql` / `countedSubjectSql` as Drizzle `sql`, or `countedVisitorClause` as text with `?` or `$n` placeholders. App rows are never rewritten.
  - The visitor fragment requires `time` and `session` (null on purpose), so a rule's "only from" date and session marks cannot be dropped by omission, and "Excluded: N" always matches the report. Columns must be qualified with the app's alias (a bare `id` would resolve to the marks table). Identifiers take each dialect's own quoting.
  - `includeInternal` is a per-request switch, never stored.
  - `excludedBreakdown(window)` returns `{ total, byReason }`, and the parts sum to the total.
  - `indexMarks` / `excludedReasonOf` answer the same question in memory, for sessions built in JavaScript (Road Rally).

  **Cleaning history**
  - `preview` is a dry run over the last 30 days, 90 days and all time; it never writes.
  - `apply` writes in batches and is idempotent. The first run leaves a run row and an annotation sentence ("N sessions excluded back to <date>"); a repeat that finds nothing new writes neither.
  - `remove` restores the numbers exactly and re-applies the remaining rules to whatever lost a mark; a remove that failed half-way is finished by running it again.
  - `unmark({ …, sources: "all" })` restores a real customer a default, the code rule or a visit-only fact wrongly excluded. `maintain({ pruneRoleMarks: true })` optionally clears the code rule's marks for people it no longer names.
  - Also included: `backfill(adapter)` for joins only the app knows (its dry run and real run count the same thing: subjects newly excluded), a daily `maintain()`, hand marks, "mark this browser", and device links (at most `maxDevices` browsers each, the maker encrypted inside the token, no chart annotation per redemption). Two admins adding the same rule at once get `duplicate_rule`, never a database error.
  - Annotations and run summaries never carry a rule's free-text label or note; emails are masked and patterns and single IP addresses shortened.

  **The rest**
  - `observe()` and `classifyActor()` never throw. A failing store degrades to "counted, defaults still apply". Active rules are cached for 60 seconds, a load that lands after `invalidate()` never restores the old list, and `getUser` answers are cached for a minute.
  - Email matching normalises Unicode (NFKC), folds a dotted capital I, compares internationalised domains in punycode and caps an address at 254 characters. Email globs use a linear matcher: a pattern like `*a*a*a…b` cannot stall a request.
  - `visitorIds: "rotating"` for a cookieless visitor key: device marks refuse and preview says how far a person rule reaches.
  - The `./core` entry has no peer dependency, for MySQL or non-Drizzle apps, and the package no longer depends on `@adminigloo/db`. It defines the `AudienceStore` interface (its contract spells out the MySQL pattern) and ships the SQL builders for the two queries over the app's own rows. CommonJS consumers get their own `.d.cts` types.
  - `./ui` has `IncludeInternalToggle`, `ExcludedNote`, `AudienceRulesPanel` (preview before add, run history, `canEdit`, `maskEmails`, which defaults to masked for viewers who cannot edit), `MarkThisBrowserButton` and `UnfilteredSourcesNote`. They are display only and take plain data plus callbacks; a callback may resolve `{ error }` (how a server action keeps its reason in a production Next build) and the component shows it. The toggle follows only paths, queries, fragments and http(s) URLs. Tokens are zero-specificity `--aiu-*` properties; contrast is WCAG AA in both themes (measured per pair); every target is 44px; forced colours are supported.
  - `./testing` has `assertCountedReads`, a source guard that fails the build when a file reads the analytics tables without the counted predicate, unless an exemption gives a reason. It checks per file; the README says what that misses.
  - Masking for the analytics role happens on the server: `j***@gmail.com` with a per-response salted tag (`viewModel({ canSeeEmails: false })`), user and device ids, email patterns and single-address networks shortened. The add-rule schema's public type names no zod type, so it reads the same on zod 3 and 4.
  - An optional `@adminigloo/license` gate (feature `audience`) guards the cleaning work, never intake, reports or removal.
