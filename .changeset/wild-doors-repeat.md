---
"@adminigloo/create-app": patch
---

A generated project now builds with credentials, as well as booting without them.

`create-adminigloo-app --email` produced a project that could not run `next build`
at all once Clerk keys were in `.env.local`:

```
Error occurred prerendering page "/setup/email"
Error: Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware()
```

`/setup/email` declared `dynamic = "force-static"` and was the only prerendered
page in the app. A prerender happens at BUILD time, where `proxy.ts` has not run
and there is no request — and the page sits under `app/(site)/layout.tsx`, whose
header reads the Clerk session. Nothing about the page was wrong; it was the only
route in a position to expose the layout above it.

**Why five configurations were reported green.** `AuthHeader` returns before it
reads a session when Clerk is unconfigured, so the prerender succeeded — and every
check in this repository generated a project with no credentials. 0.5.2 made the
scaffold boot with nothing configured and that promise has been checked ever since;
the other half of it never was. The asymmetry was the defect. The crash was a
symptom of it.

Three changes, in the three places the class can be closed:

- **`AuthHeader` survives a prerender.** A new `viewerId` helper reads
  `headers()` first and answers `null` when the set is empty, which is how Next
  renders a forced-static route — so the header degrades to the signed-out nav
  instead of throwing. It is deliberately not a `try`/`catch` around `auth()`:
  that would also swallow a deployment whose proxy has stopped matching a route,
  where every signed-in visitor would silently be handed the wrong header. The
  public links still render, as they do in all three states.
- **The email preview renders per request.** It is a developer surface — the
  sibling of `/setup`, in the same footer group, deleted with it at launch — and
  its value is showing what this deployment renders now. `force-static` also made
  it the one route whose output depended on which credentials were present.
- **The generator refuses to emit the shape.**
  `assertNoPrerenderedAuthRoutes` runs inside `planEmit`, walks the import graph
  of every emitted layout to find the ones that reach a session read, and rejects
  any page beneath one that declares `dynamic = "force-static"` or
  `dynamic = "error"`. It names the page, the layout and the module doing the
  read, which is three more facts than Clerk's message carries. It reads the plan
  rather than a build, so credentials are not part of the question. The walk
  ignores `import type` edges and stops at `"use client"` modules, which is what
  keeps it a rule about two layouts rather than a ban on static rendering: the
  root layout reaches `@/server/auth` through both, and through neither at
  render.

`scripts/verify-generated.mjs` now ends with a second `next build` against a
synthetic-but-well-formed Clerk key pair, so the configured path is exercised
locally rather than only on somebody's deployment.
