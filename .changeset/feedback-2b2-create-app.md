---
"@adminigloo/create-app": minor
---

Tenancy 2b-2a: a feedback board per company.

With `--feedback` in a companies project (`--tenant-noun Company`):

- **Each company's board** at `/app/feedback` (in the company's nav, on
  `feedback.view`), over `/api/app/{company id}/feedback/…` through the same
  company check every feature uses (membership, suspension, plan). Its columns,
  categories, feedback page address and website keys at
  `/app/feedback/settings` (changes on `feedback.settings.manage`, owners and
  admins). The board is `@adminigloo/feedback`'s `FeedbackWorkspace`.
- **A public feedback page** at `/t/{web address}/feedback`, branded with the
  company (the gate every /t page uses), where its customers send feedback with
  their name and email and follow their ticket under "My reports". It's on the
  company's public home too. A suspended company, or one whose plan ended,
  takes no new feedback and still lets customers read and answer theirs.
- **Reporter emails** (with `--comms`): the team's reply and a ticket moving
  are emailed to the reporter in the company's name with its reply-to, logged
  in its Messages and editable there. **Alerts** (with `--notifications`): a
  new ticket and a reporter's answer, to everyone who can see the board.
- **This site's own board** stays at `/admin/feedback` for the site's staff,
  fed by the feedback button the template mounts on every page
  (`pnpm feedback:issue-key` now issues that button's key, with no company).
- `feedbackPermissions` joins the company roles (owner and admin all; member
  sees and answers; viewer sees; crew none). Each company's first-time setup
  gives its board its columns and categories (and its two reporter emails).
- The project's isolation proof drives every feedback route — the company's
  board, its public page and the keyed intake — as another company.

In both modes:

- The feedback tRPC router is retired: the board runs on the package's own
  handlers (`src/server/feedback.ts`, generated), on staff keys of its own
  (`staff.feedback.view`, `.manage`, `.settings`) instead of the shell's
  `staff.dashboard.view`. `/admin/feedback` is the board (the old queue page
  and `/admin/feedback/board` lead there), and `/admin/feedback/settings`
  holds the columns, categories and website keys (the old `/statuses` and
  `/categories` pages lead there).
- A single-business project (`--tenant-noun none`) keeps its one board, the
  site's own, working as before.

Upgrading a project: run feedback's `sql/upgrade-0.9-to-0.10.sql` (or let
`pnpm db:generate` and `pnpm db:migrate` add the column), then re-run the
permission seed so staff get the new feedback keys.

After review:

- **Upgrading keeps the site's own board**: DEPLOYMENT.md and `upgrade` say to
  replace the generated migration's feedback statements with feedback's
  upgrade SQL, which moves every old ticket and the site's key onto the site's
  own board.
- **A company's screenshots are private** with `--storage` (on their ticket, in
  the private store, opened by the company's people who can see its board);
  the site's own board, and a project without storage, use the public store
  under unguessable addresses. DEPLOYMENT.md says where they go. A company's
  feedback page takes no screenshots, and `/api/cron/feedback` deletes the
  ones no report used within a day.
- The intake is held to feedback's counts on the shared limiter (per visitor,
  across every company, and a feedback page's day).
- A reply's sender is the person's display name or the business's name, never
  their sign-in address.
- This site's own feedback button isn't shown on a company's public `/t`
  pages.
