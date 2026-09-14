---
"@adminigloo/create-app": minor
---

`--feedback`: the feedback feature becomes a generation answer. A project
generated with it installs `@adminigloo/feedback` and
`@adminigloo/feedback-widget`, mounts the widget from the root layout behind a
runtime key check, emits the key-authenticated intake route at
`/api/igloo/[...path]` with Vercel Blob screenshot storage injected, mounts a
staff `feedback` router, and — when an admin shell was selected — copies in the
triage queue and Kanban board under `/admin/feedback` with sidebar entries.
`pnpm feedback:issue-key <tenant-slug>` issues the client key and prints it
once. Two new capability keys, `feedback.intake` and `feedback.triage`, with
evidence rows; two new optional env vars, `ADMINIGLOO_FEEDBACK_KEY` and
`BLOB_READ_WRITE_TOKEN`, both degrade-not-disable. `app/layout.tsx` moves from
the template to a generated file, because the widget mount is the first answer
that changes what wraps every page and overlays cannot touch base files.
