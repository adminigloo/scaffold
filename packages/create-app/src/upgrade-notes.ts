import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { cardPaymentsSetup } from "./payments-emit.js";

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
  // 0.37.0 — history and housekeeping: deleting a company, past records with
  // their real dates, past visits brought in, and sales recorded by hand. New
  // nullable columns only; the files carry the rest.
  if (crossed("0.37.0")) {
    const columns = [
      ...(answers.includeEstimator ? ["estimator_estimates.entered_at/entered_by"] : []),
      ...(answers.includeInvoicing ? ["invoices.entered_at/entered_by"] : []),
      ...(answers.includeScheduling ? ["scheduling_bookings.entered_at/entered_by"] : []),
      ...(answers.includeAnalytics ? ["analytics_sessions.import_key (and its index)"] : []),
      ...(answers.includeStore || answers.businessModel !== "none" ? ["orders.payment_method/payment_reference/recorded_by"] : []),
    ];
    notes.push(
      `Delete a ${noun} for good from its page under /admin/companies (staff with "Delete ${tenantLabelPlural(answers).toLowerCase()} for good" — ` +
        "administrators by default — typing its web address again; one still paying for a plan needs \"delete it anyway\" and a reason). " +
        "**src/server/forget-company.ts** is new: it runs every installed package's `forgetTenant` on the deletion's transaction and deletes the " +
        `${noun}'s files after it commits; **src/server/tenancy.ts** hands it to the tenancy service as \`deletion\`. If you added a package that keeps ` +
        `${noun} rows, add its forget there — src/server/__tests__/forget-company.test.ts plants a row in every table with a ${noun} column and fails, ` +
        "naming the table, until you do. Run `pnpm db:seed` so administrators get the new staff key.",
    );
    if (columns.length > 0) {
      notes.push(
        `Run \`pnpm db:generate\` and \`pnpm db:migrate\`: new nullable columns only (${columns.join(", ")}), every existing row unchanged. ` +
          "They hold past records' real dates (staff entering a business's old quotes, invoices, payments and visits give the day each happened; " +
          "when and by whom it was typed in is kept beside it)" +
          (answers.includeAnalytics ? ", past visits brought in with `importVisits`" : "") +
          (answers.includeStore ? ", and how a sale recorded by hand was paid" : "") +
          ".",
      );
    }
  }
  // 0.36.1 — the dashboard keeps its numbers while setup is unfinished, and
  // lists the day's work under them. No database change; the files carry it.
  if (crossed("0.36.1") && companies) {
    const lists = [
      ...(answers.includeScheduling ? ["today's visits"] : []),
      ...(answers.includeEstimator ? ["the newest leads"] : []),
      ...(answers.includeInvoicing ? ["the overdue invoices"] : []),
    ];
    const listed = lists.length < 2 ? (lists[0] ?? "") : `${lists.slice(0, -1).join(", ")} and ${lists[lists.length - 1]}`;
    notes.push(
      `The ${noun} dashboard no longer hides its numbers while setup is unfinished: what's left is one card above them ` +
        `("2 things left to set up") that opens into the list (@adminigloo/tenancy-widget 0.4, \`<SetupChecklist collapsible>\`), and it's gone ` +
        `once everything is done or skipped.` +
        (lists.length > 0
          ? ` Under the numbers, up to five lines each of ${listed}, for whoever may open their pages, read by \`dashboardOverview\` in ` +
            "src/server/dashboard.ts (`dashboardNumbers` still answers the numbers alone) and drawn by src/components/Dashboard.tsx." +
            (answers.includeEstimator ? " New leads now counts exactly what the Estimates page's Leads shows." : "")
          : "") +
        " No database change.",
    );
  }
  // 0.36.0 — the showroom: how every screen looks to an owner and their
  // customers. No database change; the files carry it.
  if (crossed("0.36.0")) {
    notes.push(
      "The showroom (0.36): one calm \"things to finish\" card per page instead of a stack of banners; owners read plain words and never a " +
        "setting's name, a file path or a link to /setup (staff of the site still see the detail); every work page has the same width and header; " +
        "empty lists say what the screen does once it's in use; buttons are 44px. No database change.",
    );
    if (answers.includeMarketing) {
      notes.push(
        "The landing page is rewritten for business owners, and every word of it is now in **src/marketing-copy.ts** — edit `TRADE` there first " +
          "so it speaks your trade. Product screenshots appear by themselves once you save them in public/screenshots/ under the names " +
          "`SCREENSHOTS` lists (dashboard.png first). If you had edited src/components/marketing/Features.tsx or SocialProof.tsx, move those " +
          "words into src/marketing-copy.ts: the page no longer uses them.",
      );
    }
    if (companies) {
      notes.push(
        `${noun.charAt(0).toUpperCase()}${noun.slice(1)} settings gain two sections: **Your public page** (a one-line tagline, where you work, ` +
          `your hours — shown on /t/{web address} and given to search engines) and **Dates and money** (en-US unless a ${noun} picks another). ` +
          `Each ${noun}'s /t/{web address} is now a small website: its name and tagline, one big button${answers.includeEstimator ? " (Get an instant estimate)" : ""}, ` +
          `${answers.includeEstimator ? "its price book's website products with \"from $X\", " : ""}the other pages it offers customers, and how to reach it.`,
        `The ${noun} dashboard shows Today, New leads, Money owed and Paid this week ` +
          "(src/server/dashboard.ts, generated for your features) — no more grid of links that repeats the sidebar.",
      );
    }
    if (answers.businessModel !== "none") {
      notes.push(
        "Plans read in owner language: each plan's description is its one-line promise (src/plans.ts), the plans pages lead with " +
          "\"Everything included\" and the few numbers in `HEADLINE_FEATURES` (src/plans.ts), and the rest sit under \"What's included\". " +
          "The plans pages open on US dollars where the record prices in them (`DEFAULT_CURRENCY`). Run `pnpm db:seed:plans` if you changed the record.",
      );
    }
    if (companies && answers.includeComms) {
      notes.push(
        `With no email provider set up, a ${noun}'s emails no longer use up its sending allowance (they are logged as skipped, never held or failed, ` +
          "and raise no alerts): src/server/comms-senders.ts asks the allowance only when email can actually leave.",
      );
    }
  }
  // 0.35.0 — the customer list (`create-app add customers`). A project made
  // before it has no customer list until it is added; one that has it gets the
  // tables and the backfill.
  if (crossed("0.35.0") && answers.includeCustomers) {
    notes.push(
      "One customer list (@adminigloo/customers 0.1, with @adminigloo/invoicing 0.6 and @adminigloo/comms 0.5). **Before you deploy, run " +
        "node_modules/@adminigloo/customers/sql/customers-0.1.0.sql** (or the statements `pnpm db:generate` writes; safe twice): it adds the customers, " +
        "customer_addresses, customer_links and customer_merges tables and changes nothing else.",
      `Then run \`pnpm customers:backfill\` once against each database: it puts every quote, visit, invoice, call, order and message ${companies ? `each ${noun}` : "the business"} already has on its customer's timeline, finding or creating each customer by email, else phone${companies ? ` — always inside its own ${noun}` : ""}. Safe to run again. New ones are linked as they happen; customers are at ${companies ? "/app/customers" : "/admin/customers"}.`,
    );
  } else if (
    crossed("0.35.0") &&
    (answers.includeEstimator || answers.includeScheduling || answers.includeInvoicing || answers.includeBooking || answers.includeStore || answers.includeComms) &&
    (companies || answers.adminShell !== "none")
  ) {
    notes.push(
      "New in 0.35: one customer list — each customer once, with every quote, visit, invoice, call, order and message of theirs on one timeline, " +
        "search, merge, and CSV import and export. `npx @adminigloo/create-app add customers`, then `pnpm customers:backfill`.",
    );
  }
  // 0.34.0 — getting paid, part 2: a store of its own (`create-app add store`).
  // Any project with commerce gets the 0.2 columns on orders; one with the store
  // gets the steps to take its first order.
  if (crossed("0.34.0") && (answers.includeStore || answers.businessModel !== "none")) {
    notes.push(
      "@adminigloo/commerce 0.2 adds a store of its own for every business. **Before you deploy, run " +
        "node_modules/@adminigloo/commerce/sql/upgrade-0.1-to-0.2.sql and node_modules/@adminigloo/catalog/sql/upgrade-0.2-to-0.3.sql** (or the statements `pnpm db:generate` writes; both safe twice): they add product_variants.held, " +
        "orders.refunded_minor, the order flags and email marks, and the store_checkouts, store_alerts and store_settings tables, and keep every existing order and product." +
        (answers.businessModel !== "none" ? " This site's own plans and products stay in the catalog under \"*\"; its checkout now refuses any product that isn't one of them." : ""),
    );
    if (answers.includeStore) {
      notes.push(
        (companies
          ? `Each ${noun} adds its products at /app/store and connects its own Stripe account at /app/payments; its store is /t/{web address}/store. `
          : "Add products at /admin/store; the store is /store. ") +
          "The store needs no new Stripe webhook events: it reads the ones card payments already listen to" +
          (answers.includeInvoicing ? "." : " — set up the endpoint as below."),
      );
      if (!answers.includeInvoicing) notes.push(cardPaymentsSetup(answers, "####").trim());
    }
  }
  // 0.33.0 — getting paid, part 1: customers pay invoices and deposits online.
  if (crossed("0.33.0") && answers.includeInvoicing) {
    notes.push(
      "Invoices can be paid by card now (@adminigloo/invoicing 0.5, @adminigloo/stripe 0.4). **Before you deploy, run " +
        "node_modules/@adminigloo/invoicing/sql/upgrade-0.4-to-0.5.sql and node_modules/@adminigloo/stripe/sql/upgrade-0.3-to-0.4.sql** " +
        "(or the statements `pnpm db:generate` writes; both safe twice): they add the deposit columns, the payment flag, invoice_checkouts " +
        "and stripe_connected_accounts, and keep every row. Existing invoices ask no deposit until you set one.",
      // The whole setup, the same words as README and DEPLOYMENT ("Taking card payments").
      cardPaymentsSetup(answers, "####").trim(),
    );
  }
  // 0.32.0 — Tenancy 2b-4c: book a call, a new answer (`create-app add booking`).
  // Nothing to move for a project that didn't have it; one that wired
  // @adminigloo/booking 0.1 by hand gets the steps.
  if (crossed("0.32.0") && answers.includeBooking) {
    notes.push(
      "Book a call runs on @adminigloo/booking 0.2's own handlers (src/server/booking.ts). If you had booking 0.1 tables already, " +
        "**run node_modules/@adminigloo/booking/sql/upgrade-0.1-to-0.2.sql BEFORE you deploy** — 0.2 on a 0.1 database fails every booking " +
        "request — in place of the booking statements `pnpm db:generate` wrote (safe twice): it adds booking_hosts.user_id, " +
        "booking_bookings.reminded_at and booking_bookings.reminder_attempts and keeps every row. A site that passed a fixed tenantId to 0.1 keeps passing " +
        "the same one; this project's calls are written for " +
        (companies ? `each ${noun}'s own id.` : '"primary" (BOOKING_TENANT in src/server/booking.ts).'),
      (companies
        ? `Each ${noun} sets up its calls at /app/calls: add someone from the team to take calls (they must already be a member), their weekly ` +
          `hours and a call type, then share /t/{web address}/book. Only owners and admins change hours, people and call types.`
        : "Set up calls at /admin/calls: add who takes calls, their weekly hours and a call type, then share /book.") +
        (answers.includeEmail
          ? " Confirmations, moves, cancellations and a reminder the day before go out with RESEND_API_KEY set; the reminder runs from /api/cron/booking (it needs CRON_SECRET)."
          : " This project has no email, so nobody is emailed about a call (`create-app add email`); the confirmation page's private link is the one to keep."),
    );
  }
  // 0.31.0 — Tenancy 2b-4b: the search check and AI mentions, per company, on
  // their packages' own handlers (the tRPC seo and aeo routers are gone).
  if (crossed("0.31.0") && answers.includeSeoReports) {
    notes.push(
      "The search check runs on @adminigloo/seo-reports 0.2's own handlers now; the tRPC `seo` router is gone. After `pnpm db:generate`, " +
        "replace the seo_reports statements in the migration it wrote with node_modules/@adminigloo/seo-reports/sql/upgrade-0.1-to-0.2.sql " +
        "(safe twice): your old reports become this site's own, at /admin/seo, on the new staff keys staff.seo_reports.view and staff.seo_reports.run.",
      ...(companies
        ? [
            `Each ${noun} now checks its own pages and websites from /app/website (owners and admins press Check now)` +
              (answers.businessModel === "subscription" || answers.businessModel === "both"
                ? ', with its plan\'s "Check now presses a month" (src/plans.ts; run `pnpm db:seed:plans` after setting them). The weekly check is free.'
                : " (20 a month)."),
          ]
        : []),
      "A check only reads public addresses: on a laptop, NEXT_PUBLIC_APP_URL=http://localhost:3000 is refused on purpose. The weekly re-check is " +
        "/api/cron/search-check (in vercel.json; it needs CRON_SECRET).",
    );
  }
  if (crossed("0.31.0") && answers.includeAeo) {
    notes.push(
      "AI mentions runs on @adminigloo/aeo 0.2's own handlers now; the tRPC `aeo` router and src/server/aeo-asker.ts are gone (move anything " +
        "you wired there into src/server/ai-mentions.ts). After `pnpm db:generate`, replace the aeo statements in the migration it wrote with " +
        "node_modules/@adminigloo/aeo/sql/upgrade-0.1-to-0.2.sql (safe twice). The questions you kept under the old fixed business become this " +
        "site's own (at /admin/aeo) with: `update aeo_queries set tenant_id = '*' where tenant_id = 'primary'; update aeo_checks set tenant_id = '*' " +
        "where tenant_id = 'primary'; update aeo_profiles set tenant_id = '*' where tenant_id = 'primary';`",
      answers.includeAi
        ? "Each check asks Claude Haiku 4.5 with web search — its cost is estimated; see /admin/aeo for the measured average. Every check is held " +
            "against the month's AI, AI_MENTIONS_DAILY_CENTS and AI_SITE_DAILY_CENTS before it's asked, and recorded in ai_usage as aeo_check, web " +
            "searches priced in (@adminigloo/ai 0.3). Each tracked question is re-asked weekly by /api/cron/ai-mentions (it needs CRON_SECRET)" +
            (answers.businessModel === "subscription" || answers.businessModel === "both"
              ? '; plans now sell "questions tracked by AI mentions" and "AI mention checks a month" (run `pnpm db:seed:plans`).'
              : ".")
        : "This project has no AI, so questions are kept but never asked: `create-app add ai` switches checks on.",
    );
  }
  // 0.29.0 — Tenancy 2b-3: an assistant per company. The tables gain a
  // company column; 0.8's one assistant becomes the site's own ("*").
  if (crossed("0.29.0") && answers.includeAssistant) {
    notes.push(
      "The assistant's tables gain a company on every row (assistant 0.9). After `pnpm db:generate`, replace the " +
        "assistant statements in the migration it wrote with node_modules/@adminigloo/assistant/sql/upgrade-0.8-to-0.9.sql " +
        "(safe twice): your one assistant becomes this site's own, at /admin/assistant. If your own chat route used " +
        "another assistant id, run `select set_config('assistant.upgrade_tenant', '<that id>', false);` first, in the same session.",
      ...(companies
        ? [
            `Each ${noun} now has its own assistant: the button on its pages, and what it knows at /app/assistant. Its ` +
              "monthly allowance is ASSISTANT_MONTHLY_MESSAGES and ASSISTANT_MONTHLY_CENTS in src/server/assistant.ts" +
              (answers.businessModel === "subscription" || answers.businessModel === "both"
                ? ', or "AI assistant messages a month" on its plan (src/plans.ts).'
                : "."),
          ]
        : []),
      ...(answers.includeAi
        ? [
            "AI now calls Claude Haiku 4.5 by default (src/server/ai.ts, AI_MODEL; the assistant's is ASSISTANT_MODEL), and " +
              "the whole site's AI stops for the day at AI_SITE_DAILY_CENTS. Raise it as you grow.",
          ]
        : []),
    );
  }
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
