# @adminigloo/create-app

Generates a Next.js project with auth, tenancy, permissions, tRPC, optional
Stripe and staging/production environments already wired.

```
pnpm dlx @adminigloo/create-app <name> [options]
```

Run `create-adminigloo-app --help` for the flags. Every flag given is used
verbatim and only the rest are prompted for, so a specific project can be
reproduced from a single command — which is the first thing you want when a
generated app misbehaves.

---

## The rules

These governed the scaffold from the beginning and lived in nobody's head but
ours. Violating one is worse than not shipping. Each is followed by the failure
it exists to prevent, because a rule with no failure attached is one the next
person negotiates away.

### 1. Conditionals are allowed in the generator and forbidden in the artifact

`emit.ts` branches on `answers` constantly, and that is correct — it is the only
place that knows what was asked for. **No emitted file may contain an `if`
asking whether a feature was installed.**

Absence is a generated array with no entry in it, or an overlay directory that
was not copied. Never a flag, never a `null` some page has to remember to test.

A generated project carrying `if (features.stripe)` is a template with extra
steps. The branch is dead code in every project that answered one way, so
nothing exercises it, and the moment one client edits around it the two halves
rot independently. `src/nav.ts` is the shape to copy: it emits `SITE_LINKS`,
`APP_LINKS` and `FOOTER_LINKS` as lists, consumers map over them, and
`APP_LINKS` is simply `[]` in a project generated with `--admin none`.

The bug that earned this its own heading: `AuthHeader` linked to `/admin`
unconditionally, so every signed-in user of a `--admin none` project saw a link
to a 404 — in the very file that had been introduced to stop exactly that.

### 2. Overlays are strictly additive

An overlay ADDS files. It never rewrites one the base template owns, and
`OverlayCollisionError` fails the build rather than trusting anybody to
remember.

This is what makes the combination space tractable: overlays compose because
they cannot interfere. It is also why an overlay cannot patch a link into the
base header — the header is a base file — and therefore why the nav is
generated instead.

`OverlayCollisionError` proves that no two overlays write the same path. That is
**not** the same as proving a given combination typechecks and builds, and the
failure mode of additive overlays is precisely the combination nobody generated.
The nightly [generator matrix](../../.github/workflows/generator-matrix.yml)
exists for that, and its six combinations are chosen to cover the corners nobody
produces by hand.

### 3. Base modules are runtime npm dependencies; the admin panel is copied source

The base packages are installed and upgraded. The admin shell is copied into the
project, because every client restyles it.

Copied source stops receiving upstream fixes the moment it is copied, so only
**presentation** goes in an overlay. Routers, permission checks and audit calls
stay in the runtime packages, which is what lets a security fix reach every
project without a re-copy.

`SCAFFOLD.md` records the generator version for this reason: a year later, the
only way to tell a deliberate edit from a stale default is to diff against the
version that produced it.

### 4. Everything must boot with no credentials

A missing key degrades to a documented no-op **with a real return value**. Never
a throw. Never an early return that callers have to remember to check.

`createEmailSender` is the pattern: with no `RESEND_API_KEY` a send is recorded
as outcome `'skipped'` and written to `email_events` anyway, so the feature
works end to end on a laptop and the rows a person debugging "why did they never
get the email" needs are the ones a provider dashboard by definition lacks.
Copy that shape.

The rate limiter is the same idea pointing the other way: with no Upstash pair
it counts in one process's memory, and it says so on the limiter rather than
pretending the two cases are equivalent.

The thing that must never degrade quietly is a **live key outside production**.
That throws at boot and no environment variable turns the check off.

### 5. The firm owns the tenant table; Clerk is identity only

Clerk owns credentials and sessions. It owns nothing else. The local `user` row,
the tenant, the membership, the role template and every permission assignment
live in our database, and the permission engine reads them from there.

**Never read Clerk's `has()`. Never configure a Clerk Plan. Never enable Clerk
Billing.** Not as a shortcut, not for one check, not behind a flag.

The reason is specific and it is a security failure rather than an architectural
preference. `has()` answers from Clerk's own plan and feature model. Enabling
Billing makes permission visibility **plan-gated**: a permission the firm's
tables grant starts returning `false` because a subscription lapsed, a plan was
renamed in a dashboard by someone who did not know it was load-bearing, or a
webhook was late. The application would then deny access that its own database
says is allowed, silently, with no row anywhere recording the decision — and the
audit log would show nothing at all, because nothing in our code made a choice.
The two-layer engine in `@adminigloo/permissions` is the only authority on what
a principal may do.

### 6. These are published packages, and every export is a permanent API commitment

Prefer a smaller surface. An export is far easier not to add than to remove.

Add a changeset for every package you touch. `@clerk/break-check` runs on every
pull request and posts a table of what the public type surface gained and lost,
so a `patch` that quietly deletes an exported type is visible before it ships
rather than in a client's build afterwards.

---

## How a project is assembled

In order, all of it planned in memory before a single file is written, so a
failure halfway through leaves an empty directory rather than a half-generated
project that looks complete enough to start editing:

| Source | What it contributes |
| --- | --- |
| `template/` | Every file every project gets. Token substitution only — `__SCOPE__`, `__PROJECT_NAME__`, `__TENANT_LABEL_PLURAL__`. Deliberately not a templating language: a template that can branch is a template that will grow branches. |
| `overlays/*` | Directories copied in whole when the answers select them. Additive; see rule 2. `answers.ts` decides which, in `overlayNamesFor`. |
| `emit.ts` | Files whose CONTENT depends on the answers: `package.json`, `src/env.ts`, `src/db/schema.ts`, `src/nav.ts`, `src/server/_app.ts`, the audit registry, the landing page. Strings here interpolate `answers` directly, because this is the generator and rule 1 permits it. |
| `manifest.ts` | `adminigloo.json`, then `SCAFFOLD.md` **from** it. |

## `adminigloo.json`

Written into every generated project. It records the answers, the installed
packages with their ranges, the overlays applied, the capabilities the project
expects to have, and which environment variables block boot as against which
merely change documented behaviour.

Before it existed, "what is enabled here?" was answerable only by reading
`package.json` and walking the directory tree — so every tool that needed to
know re-derived it, and they drifted.

Two properties matter more than the contents:

- **Nobody hand-maintains it.** The file says so itself, in a `//` key, because
  JSON has no comments and people open this file.
- **Every field is derived.** That is what lets the manifest be rebuilt from the
  answers and compared against the copy on disk, which is the only way drift
  becomes something a tool can find. One hand-written field anywhere would end
  that for the whole file — which is why there is nowhere in it to record a
  forked module. Forking is legitimate and worth writing down, and no tool can
  infer it, so it goes in `SCAFFOLD.md` under a heading that says plainly which
  part a person owns.

`SCAFFOLD.md` is generated **from** the manifest rather than alongside it. Both
files state the same facts; deriving each separately from `answers` is two
implementations of one truth, and the day somebody adds a question and updates
one renderer, the human-readable copy is the one people believe.

## Versions

`versions.ts` hardcodes the version of each base package a new project installs,
and `versions.test.ts` fails the build if it drifts from the workspace. That
test is the only reason a hardcoded list is safe: a caret range on a `0.x`
version means `>=0.x.0 <0.(x+1).0`, so leaving a package at `^0.1.0` after it
ships `0.2.0` makes every new project install the old one. It resolves, it
builds, and the feature the release added is simply absent.

Shared third-party versions live in the workspace catalog in
`pnpm-workspace.yaml`, in two blocks: the default catalog is the single version
this workspace builds and tests against, and the `peers` catalog is the wider
range published packages promise their consumers. `catalog.test.ts` requires the
ranges `emit.ts` writes into a generated project to match the default catalog
exactly — the generated project is not a workspace member, so nothing else
would notice it falling behind.
