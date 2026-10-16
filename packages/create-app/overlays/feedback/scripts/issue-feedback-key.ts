/**
 * Issue the website key for THIS SITE'S OWN feedback button — the one the
 * template mounts on every page (src/components/FeedbackWidget.tsx). Its
 * tickets land on the site's own board at /admin/feedback. Prints the key
 * ONCE; only its hash is stored.
 *
 *   pnpm feedback:issue-key [label]
 *
 * (A company's own website keys are made by the company, on its feedback
 * settings page. This script is only for this site's own button.)
 *
 * DELIBERATELY WILLING TO RUN AGAINST A DEPLOYED DATABASE, unlike the seed
 * scripts beside it. Seeding invents fixtures, which have no business in
 * production; this writes the one row a real deployment needs before its
 * button can appear, and refusing here would leave no supported way to do it.
 */
import { FEEDBACK_PLATFORM_BOARD, issueClientKey } from "__SCOPE__/feedback";
import { db } from "../src/db";

const label = process.argv[2] ?? "This site's feedback button";

const issued = await issueClientKey(db, { tenantId: FEEDBACK_PLATFORM_BOARD, label });

console.log("");
console.log(`  label  : ${issued.label}`);
console.log("");
console.log(`  ${issued.key}`);
console.log("");
console.log("This is the only time the key is shown. Put it in");
console.log("ADMINIGLOO_FEEDBACK_KEY in .env.local, and in the deployment's");
console.log("environment settings. Feedback sent with it appears at /admin/feedback.");
process.exit(0);
