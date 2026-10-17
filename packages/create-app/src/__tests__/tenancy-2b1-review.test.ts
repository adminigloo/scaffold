/**
 * TENANCY 2b-1, AFTER ITS REVIEW: the create-app half of the four reviews'
 * findings (owner BO-*, buyer BUY-*, security SEC-*), each held to what the
 * generator now writes. Read from the PLAN as text, as tenancy-2b1.test.ts
 * does; the emitted proofs these add (company-alerts case 14, company-files
 * cases 9, 10 and 10b) run for real in a generated project.
 */

import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { nextSteps } from "../cli.js";
import { planEmit, renderVercelJson, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR, TENANCY_2B1_CONFIGURATIONS as C } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, path: string): string {
  const contents = p.files.get(path.split("/").join(sep));
  if (contents === undefined) throw new Error(`the plan has no ${path}`);
  return contents;
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("BO-11: a page with its own header draws no second title", () => {
  it("passes hideTitle to the inbox and the settings, and title={false} to the Files screen, in both modes", async () => {
    const co = await plan(C.companyAll);
    expect(code(file(co, "app/(site)/app/alerts/page.tsx"))).toContain("<AlertsInbox baseUrl={`/api/app/${company.id}/alerts`} hideTitle />");
    expect(code(file(co, "app/(site)/app/alerts/settings/page.tsx"))).toContain("<AlertSettings baseUrl={`/api/app/${company.id}/alerts`} hideTitle ");
    expect(code(file(co, "app/(site)/app/files/page.tsx"))).toContain("title={false}");
    const single = await plan({ ...C.singleAll, adminShell: "full" });
    expect(code(file(single, "app/admin/alerts/page.tsx"))).toContain('<AlertsInbox baseUrl="/api/admin/alerts" hideTitle />');
    expect(code(file(single, "app/admin/alerts/settings/page.tsx"))).toContain('<AlertSettings baseUrl="/api/admin/alerts" hideTitle />');
    expect(code(file(single, "app/admin/files/page.tsx"))).toContain("title={false}");
  });
});

describe("BO-5 and BO-6: who to ask for more room", () => {
  it("a single business is never told to ask itself: the person who set up the site, in the meter and in the alert", async () => {
    const single = await plan({ ...C.singleAll, adminShell: "full" });
    const files = code(file(single, "src/server/files.ts"));
    expect(files).toContain('platformName: "the person who set up this site"');
    expect(files).toContain("supportEmail: undefined");
    expect(code(file(single, "app/admin/files/page.tsx"))).toContain("platformName={FILES_MORE_ROOM.platformName}");
    expect(code(file(single, "app/admin/files/page.tsx"))).not.toContain("SITE_NAME");
    const alerts = code(file(single, "src/server/alerts.ts"));
    expect(alerts).toContain("platformName: FILES_MORE_ROOM.platformName");
    expect(alerts).not.toContain("platformName: SITE_NAME");
  });

  it("a company is told where to write: the platform's name and SUPPORT_EMAIL, on the Files screen and in the alert", async () => {
    const co = await plan(C.companyAll);
    const files = code(file(co, "src/server/files.ts"));
    expect(files).toContain("platformName: SITE_NAME");
    expect(files).toContain("supportEmail: env.SUPPORT_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL ?? undefined");
    const page = code(file(co, "app/(site)/app/files/page.tsx"));
    expect(page).toContain("supportEmail={FILES_MORE_ROOM.supportEmail}");
    const alerts = code(file(co, "src/server/alerts.ts"));
    expect(alerts).toContain("supportEmail: FILES_MORE_ROOM.supportEmail");
  });

  it("reports a full company to /admin/errors in words, by name, never in bytes", async () => {
    const files = code(file(await plan(C.companyAll), "src/server/files.ts"));
    expect(files).toContain("is out of storage (${used}); a file was refused.");
    expect(files).toContain("formatBytes(event.usage.usedBytes)");
    expect(files).toContain("tenancy.companyProfile(event.tenantId)");
    expect(files).not.toContain("bytes); a file was refused");
  });
});

describe("where the business email is set is this project's own page, in its own word", () => {
  it("names the companies project's settings page to <AlertSettings>, by its noun; a single business, whose alerts never name a business email, passes nothing", async () => {
    const co = code(file(await plan(C.companyAll), "app/(site)/app/alerts/settings/page.tsx"));
    expect(co).toContain('<AlertSettings baseUrl={`/api/app/${company.id}/alerts`} hideTitle businessEmailSettings="company settings" />');
    const team = code(file(await plan({ ...C.companyAll, tenantNoun: "Team" }), "app/(site)/app/alerts/settings/page.tsx"));
    expect(team).toContain('businessEmailSettings="team settings"');
    // The single business has no business-email seam (src/server/alerts.ts
    // passes no ownerEmail), so the sentences never show and nothing is named.
    const single = await plan({ ...C.singleAll, adminShell: "full" });
    expect(code(file(single, "app/admin/alerts/settings/page.tsx"))).not.toContain("businessEmailSettings");
    expect(code(file(single, "src/server/alerts.ts"))).not.toContain("ownerEmail:");
  });
});

describe("FH-11: where the logo is changed is this project's own page", () => {
  it("names company settings to the files handlers and the Files screen in a companies project, and nothing in a single business", async () => {
    const co = await plan(C.companyAll);
    expect(code(file(co, "src/server/files-routes.ts"))).toContain('logoSettings: "company settings"');
    expect(code(file(co, "app/(site)/app/files/page.tsx"))).toContain('logoSettings="company settings"');
    const single = await plan({ ...C.singleAll, adminShell: "full" });
    expect(code(file(single, "src/server/files-routes.ts"))).not.toContain("logoSettings");
  });
});

describe("SEC-03: a copied link ends with its maker's access to the file", () => {
  it("re-runs the file's own rule for the maker on every open, in both modes", async () => {
    const co = code(file(await plan(C.companyAll), "src/server/files.ts"));
    expect(co).toContain("async ({ tenantId, userId, mayView }) =>");
    expect(co).toContain("return mayView((permission) => tenancy.hasPermission({ userId, tenantId, permission }));");
    const single = code(file(await plan(C.singleAll), "src/server/files.ts"));
    expect(single).toContain("async ({ tenantId, userId, mayView }) =>");
    expect(single).toContain('const { filesStaffKeyFor } = await import("./files-routes");');
    expect(single).toContain("return mayView((permission) => {");
  });

  it("proves it in the project: a demoted maker's link and a crew member's taken off the visit both stop", async () => {
    const proof = file(await plan(C.companyAll), "src/server/__tests__/company-files.test.ts");
    expect(proof).toContain("10. a copied link ends with its maker's access to the file (review SEC-03)");
    expect(proof).toContain("10b. a crew member's link to a visit's photo stops once the visit moves to another crew (review SEC-03)");
    // Without scheduling there is no Crew role: the access is taken away by override instead.
    const noCrew = file(await plan({ ...C.companyAll, includeScheduling: false }), "src/server/__tests__/company-files.test.ts");
    expect(noCrew).toContain("their access taken away");
    expect(noCrew).not.toContain("10b.");
  });

  it("proves it in a single business too (files-staff.test.ts): the demoted staff member's link, the removed one's and the crew member's", async () => {
    const proof = file(await plan(C.singleAll), "src/server/__tests__/files-staff.test.ts");
    expect(proof).toContain("a staff member moved to a role that doesn't see invoices: their link to an invoice's file stops at once");
    expect(proof).toContain("a staff member removed from the staff: their link stops");
    expect(proof).toContain("a crew member's link to a visit's photo stops once the visit moves to another crew");
    // Through the project's OWN member check: the files instance its routes
    // use, never a stand-in `stillValid` that would pass whatever files.ts says.
    expect(code(proof)).toContain("actual.createFilesStorage(");
    expect(code(proof)).not.toContain("stillValid");
    expect(code(proof)).toContain('await staffRole(lee, "cs_agent");');

    // Without invoices, an estimate's file, taken away by override (the agent sees estimates too).
    const estimates = file(await plan({ ...C.singleAll, includeInvoicing: false, includeScheduling: false }), "src/server/__tests__/files-staff.test.ts");
    expect(estimates).toContain("a staff member whose access to estimates is taken away: their link to an estimate's file stops at once");
    expect(code(estimates)).toContain('for (const permission of ["estimator.view","estimator.estimates.manage"])');
    expect(estimates).not.toContain("crew member");
    // Files with no record at all: one of the business's files, and the agent role that doesn't see them.
    const alone = { tenantNoun: "none", adminShell: "minimal", includeEstimator: false, includeScheduling: false, includeInvoicing: false, includeComms: false, includeStorage: true } as const;
    const library = file(await plan(alone), "src/server/__tests__/files-staff.test.ts");
    expect(library).toContain("a staff member moved to a role that doesn't see the business's files: their link to one of the business's files stops at once");
    expect(code(library)).toContain('withFile("v1/admin/files", name)');

    // Never in a companies project (company-files.test.ts is its proof), and not without files.
    expect((await plan(C.companyAll)).files.has(join("src", "server", "__tests__", "files-staff.test.ts"))).toBe(false);
    expect((await plan({ ...C.singleAll, includeStorage: false })).files.has(join("src", "server", "__tests__", "files-staff.test.ts"))).toBe(false);
  });
});

describe("SEC-02: staff's estimate photos are kept apart from customers'", () => {
  it("registers the staff purpose, exports its store, and hands it to the staff handlers in both modes", async () => {
    const co = await plan(C.companyAll);
    const files = code(file(co, "src/server/files.ts"));
    expect(files).toContain("estimatorPhotoPurpose, estimatorStaffPhotoPurpose]");
    expect(files).toContain('export const estimatorStaffPhotoStore: StoragePurposeStore | undefined = files.purposeStore("estimator.staff-photo");');
    expect(code(file(co, "src/server/estimator-services.ts"))).toContain('export { estimatorPhotoStore, estimatorStaffPhotoStore } from "@/server/files";');
    expect(code(file(co, "src/server/estimator.ts"))).toContain("staffPhotoStore: estimatorStaffPhotoStore,");
    const single = await plan(C.singleAll);
    expect(code(file(single, "app/api/admin/estimator/[...path]/route.ts"))).toContain("staffPhotoStore: estimatorStaffPhotoStore,");
    // Without file storage both are undefined, and the package keeps 0.4's one store.
    const noFiles = code(file(await plan(C.companyFieldNoFiles), "src/server/estimator-services.ts"));
    expect(noFiles).toContain("export const estimatorStaffPhotoStore: EstimatorPhotoStore | undefined = undefined;");
  });
});

describe("SEC-04: who hears about new work, in the audit log", () => {
  it("passes the audit seam to the alerts handlers and declares the package's actions in the registry, in both modes", async () => {
    for (const config of [C.companyAll, C.singleAll]) {
      const p = await plan(config);
      const routes = code(file(p, "src/server/alerts-routes.ts"));
      expect(routes).toContain("audit: auditAlertRouting,");
      expect(routes).toContain("auditEntry(auditRegistry, {");
      const registry = code(file(p, "src/server/audit.ts"));
      expect(registry).toContain('import { notificationsAuditedActions } from "@adminigloo/notifications";');
      expect(registry).toContain("...notificationsAuditedActions");
    }
    expect(code(file(await plan(C.companyFilesAlone), "src/server/audit.ts"))).not.toContain("notificationsAuditedActions");
  });
});

describe("BUY-02: the Blob limits on Vercel Hobby are said before they bite", () => {
  it("says, in DEPLOYMENT.md, that Hobby's Blob is 1 GB and 2,000 uploads a month for the whole site, and what to set instead", async () => {
    const deployment = flat(file(await plan(C.companyAll), "DEPLOYMENT.md"));
    expect(deployment).toContain("Hobby's Blob is 1 GB of storage and 2,000 uploads a month for the WHOLE site, every company together");
    expect(deployment).toContain("until 30 days have passed");
    expect(deployment).toContain("assumes Vercel Pro");
    expect(code(file(await plan(C.companyAll), "src/server/files.ts"))).toContain("(env.FILES_ALLOWANCE_MB ?? 5120) * 1024 * 1024");
    expect(file(await plan(C.companyAll), "src/server/files.ts")).toContain("THE DEFAULT ASSUMES VERCEL PRO (review BUY-02)");
  });
});

describe("BUY-03: one person in two companies is proven, not assumed", () => {
  it("emits the two-company case for the alerts and for the files", async () => {
    const p = await plan(C.companyAll);
    const alertsProof = file(p, "src/server/__tests__/company-alerts.test.ts");
    expect(alertsProof).toContain("14. one person in two companies (review BUY-03)");
    expect(alertsProof).toContain('roleKey: "admin"');
    expect(alertsProof).toContain("expect((await asPatIn(quarry, `v1/admin/alerts/${encodeURIComponent(id)}/read`, \"POST\")).status).toBe(404);");
    const filesProof = file(p, "src/server/__tests__/company-files.test.ts");
    expect(filesProof).toContain("9. one person in two companies (review BUY-03)");
    expect(filesProof).toContain("expect(inQuarry.map((file) => file.id)).not.toContain(mine);");
  });
});

describe("BUY-04 and BUY-05: an older version's public files", () => {
  it("moves 0.1's library files with the estimator's photos", async () => {
    expect(file(await plan(C.companyAll), "src/server/files.ts")).toContain('["library.file", "estimator.photo"]');
  });

  it("moves them in batches until none are left, and reports a run that didn't finish", async () => {
    const cron = code(file(await plan(C.companyAll), "app/api/cron/files/route.ts"));
    expect(cron).toContain("const MOVE_BATCH = 1000;");
    expect(cron).toContain("if (!batch.stoppedEarly || batch.moved === 0) break;");
    expect(cron).toContain("if (moved.some((entry) => entry.stoppedEarly)) {");
    expect(cron).toContain("const left = await filesStillPublic();");
    expect(cron).toContain("void reportError({");
  });

  it("says on /setup how many are still public", async () => {
    const setup = code(file(await plan(C.companyAll), "src/components/SetupFilesSlot.tsx"));
    expect(setup).toContain("const stillPublic = await filesStillPublic().catch(() => 0);");
    expect(setup).toContain("Older files are still being made private");
  });

  it("writes the upgrade's by-hand step for the old Files page's uploads, per mode", () => {
    const single = upgradeNotesFor(answers(C.singleAll), "0.23.0").join("\n");
    expect(single).toContain("update stored_files set tenant_id = 'primary' where tenant_id = '*';");
    const companies = upgradeNotesFor(answers(C.companyAll), "0.23.0").join("\n");
    expect(companies).toContain("update stored_files set tenant_id = '<company id>' where tenant_id = '*';");
    // A project already past 2b-1 isn't told again.
    expect(upgradeNotesFor(answers(C.companyAll), "0.24.0").join("\n")).not.toContain("stored_files");
  });
});

describe("BUY-06: /setup doesn't spend an upload on every view", () => {
  it("shows a verdict kept for an hour, and the files cron refreshes it daily", async () => {
    const p = await plan(C.companyAll);
    const files = code(file(p, "src/server/files.ts"));
    expect(files).toContain("const PRIVATE_CHECK_TTL_MS = 60 * 60 * 1000;");
    expect(files).toContain("if (!options.fresh && privateCheck && Date.now() - privateCheck.at < PRIVATE_CHECK_TTL_MS) return privateCheck.verdict;");
    expect(code(file(p, "src/components/SetupFilesSlot.tsx"))).not.toContain("checkPrivateStore");
    expect(code(file(p, "app/api/cron/files/route.ts"))).toContain("privateStoreVerdict({ fresh: true, storage: files })");
  });
});

describe("BUY-07: the Pro crons block is the whole array", () => {
  for (const [name, config] of [
    ["companyAll", C.companyAll],
    ["singleAll", C.singleAll],
    ["companyFilesAlone", C.companyFilesAlone],
  ] as const) {
    it(`lists every cron vercel.json has (${name})`, async () => {
      const deployment = file(await plan(config), "DEPLOYMENT.md");
      const crons = (JSON.parse(renderVercelJson(answers(config))) as { crons: { path: string }[] }).crons;
      const block = deployment.slice(deployment.indexOf('"crons": ['));
      const array = block.slice(0, block.indexOf("```"));
      for (const cron of crons) expect(array, cron.path).toContain(`"path": "${cron.path}"`);
      expect(array).toContain('{ "path": "/api/cron/files", "schedule": "45 14 * * *" }');
      expect(deployment).toContain("That is the whole `crons` array: paste it over the one in `vercel.json`.");
    });
  }
});

describe("BUY-08: a new buyer creates both stores, and /setup says which is missing", () => {
  it("writes both steps for a fresh deployment, and the public store's warning", async () => {
    const p = await plan(C.companyAll);
    const deployment = file(p, "DEPLOYMENT.md");
    expect(deployment).toContain("set its access to **Public**");
    expect(deployment).toContain("set its access to Private");
    const setup = code(file(p, "src/components/SetupFilesSlot.tsx"));
    expect(setup).toContain("env.BLOB_READ_WRITE_TOKEN ? null : (");
    expect(setup).toContain(`title="Logos aren't kept yet"`);
    const page = await readFile(join(TEMPLATE_DIR, "app", "(site)", "setup", "page.tsx"), "utf8");
    expect(page).toContain("access Public");
  });
});

describe("a suspended company's event is a quiet skip", () => {
  it("asks whether the company is active before claiming an office email, and proves nothing is reported", async () => {
    const p = await plan(C.companyAll);
    const alerts = code(file(p, "src/server/alerts.ts"));
    const office = alerts.slice(alerts.indexOf("export async function officeRecipientsFor"));
    expect(office.indexOf('profile.status !== "active") return [];')).toBeGreaterThan(-1);
    expect(office.indexOf('profile.status !== "active") return [];')).toBeLessThan(office.indexOf("alerts.claimEmails("));
    const proof = file(p, "src/server/__tests__/company-alerts.test.ts");
    expect(proof).toContain("reports nothing — a quiet skip");
    expect(proof).toContain("expect(errors.mock.calls.map((call) => String(call[1] ?? call[0]))).toEqual([]);");
    // The single business has no suspension: no such check there.
    expect(code(file(await plan(C.singleAll), "src/server/alerts.ts"))).not.toContain('profile.status !== "active") return [];');
  });
});

describe("a companies project's next steps name the company's own pages", () => {
  it("never sends a company owner to the single business's /admin pages", () => {
    const steps = nextSteps(answers(C.companyAll), "/out");
    for (const path of ["/admin/schedule/settings", "/admin/estimator/settings", "/admin/estimates", "/admin/schedule/today", "/admin/schedule"]) {
      expect(steps, path).not.toContain(path);
    }
    for (const path of ["/app/schedule/settings", "/app/estimates/settings", "/app/estimates", "/app/price-book", "/app/schedule/today", "/t/{its web address}/book-visit"]) {
      expect(steps, path).toContain(path);
    }
    const single = nextSteps(answers(C.singleAll), "/out");
    expect(single).toContain("/admin/schedule/settings");
    expect(single).toContain("/admin/estimator/settings");
  });
});

describe("Windows: a short project path", () => {
  it("is in DEPLOYMENT.md's troubleshooting and in create-app's README", async () => {
    const deployment = file(await plan(C.companyAll), "DEPLOYMENT.md");
    expect(deployment).toContain("the build can't read a file whose full path is over 260 characters. This project's `.npmrc` already keeps those folders short");
    expect(deployment).toContain("if it still happens, move the project to a short folder");
    const own = flat(await readFile(join(__dirname, "..", "..", "README.md"), "utf8"));
    expect(own).toContain("On Windows, generate into a short folder");
  });
});

describe("BUY-01: how a Tenancy 2a project reaches 2b-1, written where it is read", () => {
  it("DEPLOYMENT.md §9 names the command, what it leaves for a person, and 2b-1's own steps, per mode", async () => {
    const co = flat(file(await plan(C.companyAll), "DEPLOYMENT.md"));
    expect(co).toContain("## 9. Upgrading to a newer create-app");
    expect(co).toContain("pnpm dlx @adminigloo/create-app upgrade");
    expect(co).toContain("Those `.new` files, any retired file you had changed, and your own files that import a removed one are the only hand edits");
    expect(co).toContain("### From Tenancy 2a (create-app 0.23) to Tenancy 2b-1 (alerts and files)");
    expect(co).toContain("`app/admin/files/page.tsx`");
    expect(co).toContain("update stored_files set tenant_id = '<company id>' where tenant_id = '*';");
    expect(co).not.toContain("<!-- adminigloo:upgrade-notes -->");
    const single = flat(file(await plan(C.singleAll), "DEPLOYMENT.md"));
    expect(single).toContain("update stored_files set tenant_id = 'primary' where tenant_id = '*';");
    expect(single).not.toContain("`app/admin/files/page.tsx`");
    expect(flat(file(await plan(C.companyFieldOnly), "DEPLOYMENT.md"))).toContain("Nothing more: this project has neither alerts nor files.");
  });

  it("the project's README says which create-app made it and how to upgrade", async () => {
    const readme = file(await plan(C.companyAll), "README.md");
    expect(readme).toContain("## Upgrading");
    expect(readme).toContain("run `pnpm dlx @adminigloo/create-app upgrade` in this folder");
  });

  it("create-app's own README has the 2a → 2b-1 steps and what stays a hand edit", async () => {
    const own = flat(await readFile(join(__dirname, "..", "..", "README.md"), "utf8"));
    expect(own).toContain("## Upgrading a project");
    expect(own).toContain("pnpm dlx @adminigloo/create-app@0.24 upgrade");
    expect(own).toContain("**What still needs a hand edit**, and nothing else");
    expect(own).toContain("### From Tenancy 2a (create-app 0.23) to Tenancy 2b-1 (0.24)");
  });
});

describe("BUY-01: the CLI names upgrade", () => {
  it("in its help, beside add", async () => {
    const { HELP } = await import("../cli.js");
    expect(HELP).toContain("pnpm dlx @adminigloo/create-app upgrade [--dir <path>]");
  });
});

describe("Windows: the packages sit 20 characters shallower in every project", () => {
  it("sets pnpm's store folder names to 40 characters in the project's .npmrc", async () => {
    const npmrc = file(await plan(C.companyAll), ".npmrc");
    expect(npmrc).toContain("virtual-store-dir-max-length=40");
    expect(npmrc).toContain("@adminigloo:registry=https://npm.pkg.github.com");
  });
});
