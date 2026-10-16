import { tenantLabel, type Answers } from "./answers.js";

/** "1.2.3" → [1, 2, 3]; anything else → null. */
export function parseVersion(text: string): readonly [number, number, number] | null {
  const match = /^\^?~?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1; null when either isn't a plain version (or caret range). */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * What a person has to do about the versions crossed, beyond the files
 * (review BUY-01): the steps no file can take — a store to connect, rows to
 * hand to a business, lists to choose again. Keyed by the version that
 * brought them, so a project already past it isn't told again.
 */
export function upgradeNotesFor(answers: Answers, fromVersion: string): string[] {
  const notes: string[] = [];
  const companies = answers.tenantNoun !== "none";
  const noun = tenantLabel(answers).toLowerCase();
  const crossed = (version: string) => (compareVersions(fromVersion, version) ?? -1) < 0;
  // 0.26.0 — Tenancy 2b-2a: a feedback board per company (review H1: the
  // upgrade must keep the site's own board, its tickets and its key).
  if (crossed("0.26.0") && answers.includeFeedback) {
    notes.push(...feedbackUpgradeNotes(answers));
  }
  // 0.25.0 — billing 0.3: every company is charged a plan (review H4: an
  // upgraded project would otherwise close every company older than the
  // trial the moment it deploys).
  if (crossed("0.25.0") && companies && (answers.businessModel === "subscription" || answers.businessModel === "both")) {
    notes.push(
      `Every ${noun} now needs a plan. BEFORE you deploy this, set PLANS_ENFORCED_FROM to today's date (YYYY-MM-DD) ` +
        `in Vercel (Production and Preview): every existing ${noun} then gets a fresh free trial from today instead of ` +
        `being closed the moment this goes live. Give anyone who should keep going for free months with Give free months ` +
        `(Admin -> ${tenantLabel(answers)} plans), and set your prices in src/plans.ts.`,
    );
  }
  // 0.24.0 — Tenancy 2b-1: alerts and files.
  if (crossed("0.24.0")) {
    if (answers.includeStorage) {
      notes.push(
        "Photos and files are private now. In Vercel, connect a SECOND Blob store with access Private, " +
          "with the environment variable prefix BLOB_PRIVATE (it gives BLOB_PRIVATE_READ_WRITE_TOKEN), and redeploy " +
          '(DEPLOYMENT.md, "Photos and files"). Keep the store you have: it holds the logos. Until the private one is ' +
          "connected, new photos and files can't be added, and the screens say so.",
        "The files cron (/api/cron/files) moves the photos and files the old version kept at public addresses into " +
          "the private store, a batch every run; /setup says how many are left, and /admin/errors is told when a run " +
          "didn't finish. Same files, same links.",
        companies
          ? `Files your staff added on the old /admin/files page belong to no ${noun}, and no screen lists them now. ` +
              `To give them to one ${noun}, run once (its id is on /admin/companies): ` +
              `update stored_files set tenant_id = '<${noun} id>' where tenant_id = '*';  ` +
              `They are then on that ${noun}'s Files page. Either way the files cron makes them private.`
          : "Files staff added on the old Files page are the business's again after one statement, run once: " +
              "update stored_files set tenant_id = 'primary' where tenant_id = '*';  " +
              "Until then the Files page doesn't list them. Either way the files cron makes them private.",
      );
    }
    if (answers.includeNotifications) {
      notes.push(
        `Alerts are ${companies ? `each ${noun}'s own` : "each person's own"} now, and who hears about new work is chosen in Alert settings ` +
          `(${companies ? "/app/alerts/settings" : answers.adminShell !== "none" ? "/admin/alerts/settings" : "the admin panel"}). ` +
          "The old per-feature \"send new-request alerts to\" lists aren't read any more: choose the people again there. " +
          "The old inbox's entries aren't shown.",
      );
    }
  }
  return notes;
}

/** Where DEPLOYMENT.md's "Upgrading" section lists what each version crossed asks of a person. */
export const UPGRADE_NOTES_MARKER = "<!-- adminigloo:upgrade-notes -->";

/**
 * DEPLOYMENT.md §9's version notes, for this project's features (review
 * BUY-01): what `upgrade` prints, written down where the developer who runs
 * it will look again. Today one release: Tenancy 2a (create-app 0.23) to
 * Tenancy 2b-1.
 */
export function renderDeploymentUpgradeNotes(answers: Answers): string {
  // The 2b-1 section's own notes: the 0.26 (feedback) ones get a section of their own below.
  const later = new Set(upgradeNotesFor(answers, "0.25.0"));
  const notes = upgradeNotesFor(answers, "0.23.0").filter((note) => !later.has(note));
  const companies = answers.tenantNoun !== "none";
  const shell = answers.adminShell !== "none";
  // What 2a wrote that 2b-1 retires, for this project's answers (checked
  // against the real 2a generator's output by the upgrade run).
  const retired = [
    ...(answers.includeNotifications
      ? ["src/server/notify.ts", "src/server/routers/notifications.ts", ...(companies && shell ? ["app/admin/inbox/page.tsx"] : [])]
      : []),
    ...(answers.includeStorage
      ? ["src/server/blob-store.ts", "src/server/routers/files.ts", "app/api/files/route.ts", ...(companies && shell ? ["app/admin/files/page.tsx"] : [])]
      : []),
  ];
  return [
    "### From Tenancy 2a (create-app 0.23) to Tenancy 2b-1 (alerts and files)",
    "",
    `\`upgrade\` raises every package to its 2b-1 version${retired.length > 0 ? ` and removes the files 2b-1 retired (${retired.map((path) => `\`${path}\``).join(", ")}), replaced by this version's alerts and files` : ""}. After it:`,
    "",
    ...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ["- Nothing more: this project has neither alerts nor files."]),
    "",
    ...(answers.includeFeedback
      ? [
          "### From create-app 0.25 to 0.26 (a feedback board per business)",
          "",
          "`upgrade` raises feedback and the feedback widget and removes the retired feedback router (`src/server/routers/feedback.ts`). After it:",
          "",
          ...feedbackUpgradeNotes(answers).map((note) => `- ${note}`),
          "",
          // Feedback 0.11: additions only, so drizzle-kit's own migration is right.
          "### From create-app 0.26 to 0.27 (the complete feedback board)",
          "",
          "`upgrade` raises feedback to 0.11 and removes `src/components/FeedbackSettings.tsx`: the settings pages now show the package's own screens. After it:",
          "",
          "- Run `pnpm db:generate`, then `pnpm db:migrate`. It only adds: four ticket columns (who it's assigned to, where it came " +
            "from, who on the team filed it, whether the customer is emailed about it), the activity trail's table, and " +
            "a table that remembers each board was set up (so deleted defaults never come back). Without drizzle-kit, the same change is " +
            "node_modules/@adminigloo/feedback/sql/upgrade-0.10-to-0.11.sql.",
          "- Tickets assigned by a typed name before are linked to the person with that name the first time each board opens (when exactly one person has it); any other name stays its own choice in the Assigned-to filter, \"(not linked)\", until you pick a person.",
          "",
          // Feedback 0.12: additions only again.
          "### From create-app 0.27 to 0.28 (epics on the feedback boards)",
          "",
          "`upgrade` raises feedback to 0.12 and adds the epics pages (/app/feedback/epics for each " +
            (companies ? "company" : "business") +
            "'s board where there is one, /admin/feedback/epics for this site's own). After it:",
          "",
          "- Run `pnpm db:generate`, then `pnpm db:migrate`. It only adds: the epics table, a ticket's epic, and a column's " +
            "\"waiting on someone else\" flag (off for every column). Without drizzle-kit, the same change is " +
            "node_modules/@adminigloo/feedback/sql/upgrade-0.11-to-0.12.sql.",
          "- Mark a column like \"Waiting on customer\" as waiting in Feedback settings, and epics count its tickets as waiting.",
          "",
        ]
      : []),
  ].join("\n");
}

/**
 * Feedback's steps from create-app 0.25 to 0.26 (Tenancy 2b-2a, review H1):
 * the old board — every ticket and the site's feedback key — becomes this
 * site's own, through feedback's shipped upgrade SQL, because drizzle-kit's
 * generated migration can't tell which rows are the site's.
 */
export function feedbackUpgradeNotes(answers: Answers): string[] {
  const companies = answers.tenantNoun !== "none";
  const noun = tenantLabel(answers).toLowerCase();
  return [
    "Feedback boards belong to a business now, and your old board becomes this site's own. Run `pnpm db:generate`, " +
      "then open the migration it wrote and replace its feedback_* statements with the contents of " +
      "node_modules/@adminigloo/feedback/sql/upgrade-0.9-to-0.10.sql: that file moves every old ticket and the site's " +
      "feedback key onto this site's own board (/admin/feedback), whatever business the old issue-key command filed " +
      "them under, so the feedback button keeps working and no business sees reports that weren't sent to it. Then " +
      "`pnpm db:migrate`, and `pnpm db:seed` for the new staff.feedback.* keys.",
    ...(companies
      ? [
          `The old \`pnpm feedback:issue-key <slug>\` made a ${noun} for the slug you gave it if none existed. If that ` +
            `${noun} is only there because of the key, delete it from the operator console.`,
        ]
      : []),
  ];
}
