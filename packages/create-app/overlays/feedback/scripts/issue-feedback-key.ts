/**
 * Issue a feedback-widget client key — the licence artifact of the feedback
 * feature. Prints the plaintext ONCE; only its hash is stored.
 *
 *   pnpm feedback:issue-key <tenant-slug> [label]
 *
 * The tenant is created if the slug does not exist yet, so issuing a key for a
 * brand-new client is one command.
 *
 * DELIBERATELY WILLING TO RUN AGAINST A DEPLOYED DATABASE, unlike the seed
 * scripts beside it. Seeding invents fixtures, which have no business in
 * production; this writes the one row a real deployment needs before its
 * widget can mount, and refusing here would leave no supported way to do it.
 */
import { eq } from "drizzle-orm";
import { issueClientKey } from "__SCOPE__/feedback";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "../src/db";

const slug = process.argv[2];
const label = process.argv[3] ?? "default";

if (!slug) {
  console.error("usage: pnpm feedback:issue-key <tenant-slug> [label]");
  process.exit(1);
}

const existing = await db
  .select()
  .from(tenants)
  .where(eq(tenants.slug, slug))
  .limit(1);
let tenant = existing[0];
if (!tenant) {
  const inserted = await db
    .insert(tenants)
    .values({ slug, name: slug, kind: "org" })
    .returning();
  tenant = inserted[0];
  console.log(`created tenant "${slug}" (${tenant?.id})`);
}
if (!tenant) throw new Error("tenant lookup and creation both came back empty");

const issued = await issueClientKey(db, { tenantId: tenant.id, label });

console.log("");
console.log(`  tenant : ${tenant.name} (${tenant.id})`);
console.log(`  label  : ${issued.label}`);
console.log(`  key id : ${issued.id}`);
console.log("");
console.log(`  ${issued.key}`);
console.log("");
console.log("This is the only time the key is shown. Put it in the consuming");
console.log("app's configuration — for this app: ADMINIGLOO_FEEDBACK_KEY in");
console.log(".env.local, and in the deployment's environment settings.");
process.exit(0);
