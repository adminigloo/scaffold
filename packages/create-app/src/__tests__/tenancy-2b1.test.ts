/**
 * TENANCY 2b-1, AS THE GENERATOR WRITES IT (contract section 13.11).
 *
 * With `--notifications` and `--storage`, every company — and in a
 * single-business project, the one business — hears about its work in the
 * app and by email (`src/server/alerts.ts` over @adminigloo/notifications),
 * and keeps photos and files privately against its visits, estimates and
 * invoices (`src/server/files.ts` over @adminigloo/storage).
 *
 * Read from the PLAN as text, as the 2a test does: the emitted modules reach
 * `@/db` and the packages, so they run for real in a generated project (its
 * own feature-isolation, company-alerts, company-files, company-email and
 * glue-imports tests, scripts/verify-generated.mjs) and in the browser
 * scenario (e2e/tests/tenancy-2b1-scenario.spec.ts).
 */

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, capabilitiesFor, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { CAPABILITY_EVIDENCE } from "../capabilities.js";
import { planEmit, versionRangeFor, type EmitPlan } from "../emit.js";
import { TENANCY_2A_SUPERSEDED, TENANCY_2B1_NOT_INCLUDED } from "../readme-emit.js";
import { ROUTER_SCOPES } from "../tenancy-proofs-emit.js";
import { TEMPLATE_DIR, TENANCY_2B1_CONFIGURATIONS as C } from "./configurations.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const OVERLAYS_DIR = join(TEMPLATE_DIR, "..", "overlays");

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

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

function has(p: EmitPlan, ...segments: string[]): boolean {
  return p.files.has(join(...segments));
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** A plan's paths, `/`-separated. */
function pathsOf(p: EmitPlan): string[] {
  return [...p.files.keys()].map((path) => path.split(sep).join("/"));
}

function contentsAt(p: EmitPlan, path: string): string {
  return p.files.get(path.split("/").join(sep)) ?? "";
}

/** The TypeScript a project runs (its tests and test helpers apart). */
function isProjectSource(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !path.includes("__tests__") && !path.startsWith("src/test/");
}

/** A package's declared permission keys, from its own fragment. */
async function packagePermissionKeys(pkg: string): Promise<string[]> {
  const source = await readFile(join(PACKAGES_DIR, pkg, "src", "permissions.ts"), "utf8");
  return [...source.matchAll(/^\s{2}"([a-z][a-z.]+)":\s*\{/gm)].map((m) => m[1]!);
}

/** Every permission a package's alert kinds or file records ask for, from its own source. */
async function permissionsNamedBy(pkg: string, module: "alerts" | "files"): Promise<string[]> {
  const path = join(PACKAGES_DIR, pkg, "src", `${module}.ts`);
  if (!existsSync(path)) return [];
  const source = code(await readFile(path, "utf8"));
  return [
    ...new Set([
      ...[...source.matchAll(/permission:\s*"([a-z][a-z.]+)"/g)].map((m) => m[1]!),
      ...[...source.matchAll(/(?:view|manage):\s*Object\.freeze\(\[([^\]]*)\]/g)].flatMap((m) =>
        [...m[1]!.matchAll(/"([a-z][a-z.]+)"/g)].map((k) => k[1]!),
      ),
    ]),
  ];
}

/** The fragments `defineAlertRegistry([…])` is given. */
function registryFragments(alerts: string): string[] {
  const m = alerts.match(/defineAlertRegistry\(\[([^\]]*)\]\)/);
  if (!m) throw new Error("alerts.ts has no defineAlertRegistry([…])");
  return m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The record types `createStorage({ records: [ … ] })` is given. */
function recordFactories(files: string): string[] {
  const m = files.match(/records:\s*\[([\s\S]*?)\]\s*,\s*\n\s*allowanceBytes/);
  if (!m) throw new Error("files.ts has no records list");
  return [...m[1]!.matchAll(/\.\.\.(\w+FileRecords)\(/g)].map((x) => x[1]!);
}

const ALL = Object.entries(C) as ReadonlyArray<readonly [string, Partial<Answers>]>;
const COMPANIES = ALL.filter(([, o]) => o.tenantNoun !== "none");
const WITH_ALERTS = ALL.filter(([, o]) => o.includeNotifications);
const WITH_FILES = ALL.filter(([, o]) => o.includeStorage);

// ---------------------------------------------------------------------------

describe("rule 1: no emitted file asks which mode or feature it is in", () => {
  it.each(ALL)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    for (const path of pathsOf(p)) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const source = code(contentsAt(p, path));
      for (const word of [
        "tenantNoun",
        "includeNotifications",
        "includeStorage",
        "includeScheduling",
        "includeEstimator",
        "includeInvoicing",
        "includeComms",
      ]) {
        expect(source.includes(word), `${path} contains ${word}`).toBe(false);
      }
      expect(source, path).not.toMatch(/\bmode\s*===\s*"(companies|personal|single)"/);
    }
  });

  it("chooses each slot's variant at generation: the bell's three, the record files' two, the setup row's two", async () => {
    const bell = async (o: Partial<Answers>) => code(file(await plan(o), "src", "components", "AlertsBellSlot.tsx"));
    // Companies: the company's own alerts route, for someone who can see alerts.
    expect(await bell(C.companyAll)).toContain("<AlertsBell baseUrl={`/api/app/${props.session.company.id}/alerts`} />");
    expect(await bell(C.companyAll)).toContain('props.can.includes("alerts.view")');
    // One business: the staff's route, for staff.
    expect(await bell(C.singleAll)).toContain('<AlertsBell baseUrl="/api/admin/alerts" />');
    expect(await bell(C.singleNoShell)).toContain('<AlertsBell baseUrl="/api/admin/alerts" />');
    // No alerts: nothing, and no widget import.
    expect(await bell(C.companyFilesAlone)).not.toContain("AlertsBell ");
    expect(await bell(C.companyFilesAlone)).not.toContain("notifications-widget");
    expect(await bell(C.companyFilesAlone)).toContain("return null;");

    const record = async (o: Partial<Answers>) => code(file(await plan(o), "src", "components", "RecordFilesSlot.tsx"));
    expect(await record(C.companyAll)).toContain("<RecordFiles ");
    expect(await record(C.companyFieldNoFiles)).not.toContain("storage-widget");
    expect(await record(C.companyFieldNoFiles)).toContain("return null;");
    // No record feature: no slot at all.
    expect(has(await plan(C.companyFilesAlone), "src", "components", "RecordFilesSlot.tsx")).toBe(false);

    const setup = async (o: Partial<Answers>) => code(file(await plan(o), "src", "components", "SetupFilesSlot.tsx"));
    // The private store's verdict, kept for an hour (review BUY-06), never a live check per view.
    expect(await setup(C.companyAll)).toContain("await privateStoreVerdict()");
    expect(await setup(C.companyAll)).not.toContain("files.checkPrivateStore()");
    expect(await setup(C.companyAlertsAlone)).not.toContain("@/server/files");
    expect(await setup(C.companyAlertsAlone)).toContain("return null;");
  });
});

describe("no fixed business in a companies project (2a D12, plus ALERTS_TENANT and FILES_TENANT)", () => {
  it.each(COMPANIES)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    for (const path of pathsOf(p)) {
      const source = contentsAt(p, path);
      for (const name of ["ALERTS_TENANT", "FILES_TENANT"]) expect(source.includes(name), `${path} names ${name}`).toBe(false);
    }
    for (const path of ["src/server/alerts.ts", "src/server/alerts-routes.ts", "src/server/files.ts", "src/server/files-routes.ts"]) {
      if (pathsOf(p).includes(path)) expect(code(contentsAt(p, path)), path).not.toContain('"primary"');
    }
  });

  it("and the single business has its one (the control)", async () => {
    const p = await plan(C.singleAll);
    expect(file(p, "src", "server", "alerts.ts")).toContain('export const ALERTS_TENANT = "primary";');
    expect(file(p, "src", "server", "files.ts")).toContain('export const FILES_TENANT = "primary";');
  });
});

describe("retired (13.2): nothing of 0.1's alerts and files is left behind", () => {
  it.each(ALL)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    const paths = pathsOf(p);
    for (const gone of [
      "src/server/routers/notifications.ts",
      "src/server/routers/files.ts",
      "src/server/notify.ts",
      "src/server/blob-store.ts",
      "app/api/files/route.ts",
    ]) {
      expect(paths, gone).not.toContain(gone);
    }
    for (const path of paths) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const source = code(contentsAt(p, path));
      for (const word of ["notifyStaff", "getBlobStore", "storeFile("]) expect(source.includes(word), `${path} uses ${word}`).toBe(false);
      // The one public store is the logo's, chosen in files.ts.
      if (isProjectSource(path) && path !== "src/server/files.ts") {
        expect(source.includes('access: "public"'), `${path} makes a public store`).toBe(false);
      }
    }
    const appRouter = code(file(p, "src", "server", "routers", "_app.ts"));
    expect(appRouter).not.toContain("notificationsRouter");
    expect(appRouter).not.toContain("filesRouter");
  });

  it("drops the two routers from the procedure-scope table, and the overlays that carried them", () => {
    expect(ROUTER_SCOPES.map((row) => row.key)).not.toContain("notifications");
    expect(ROUTER_SCOPES.map((row) => row.key)).not.toContain("files");
    // The old notifications overlay holds no file any more.
    const legacy = join(OVERLAYS_DIR, "notifications");
    expect(existsSync(legacy) ? readdirSync(legacy, { recursive: true }).filter((e) => String(e).includes(".")) : []).toEqual([]);
    expect(existsSync(join(OVERLAYS_DIR, "storage", "src", "server", "blob-store.ts"))).toBe(false);
    expect(existsSync(join(OVERLAYS_DIR, "storage", "app", "api", "files", "route.ts"))).toBe(false);
  });
});

describe("producers (13.6): every installed feature's events reach the alerts", () => {
  it.each([
    ["companies", C.companyAll],
    ["single", C.singleAll],
  ] as const)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    // FIRST in LISTENERS, before the comms listener, so the office email finds its rows to claim.
    expect(code(file(p, "src", "server", "scheduling-notify.ts"))).toMatch(
      /const LISTENERS: readonly SchedulingEventListener\[\] = \[\(event\) => alertOnSchedulingEvent\(event\), schedulingComms\.onEvent\];/,
    );
    expect(code(file(p, "src", "server", "estimator-notify.ts"))).toMatch(
      /const LISTENERS: readonly EstimatorEventListener\[\] = \[\(event\) => alertOnEstimatorEvent\(event\), estimatorComms\.onEvent\];/,
    );
    const invoicing = code(file(p, "src", "server", "invoicing.ts"));
    expect(invoicing.split("onEvent: (event) => alertOnInvoicingEvent(event)").length - 1).toBe(2);
    // A customer's email that failed for good, by a dynamic import (13.10 rule 4).
    expect(code(file(p, "src", "server", "comms-senders.ts"))).toContain(
      'onFailed: (failure) => import("./alerts").then((m) => m.alertOnCommsFailure(failure))',
    );
    // Storage's almost-full and full, the same way.
    expect(code(file(p, "src", "server", "files.ts"))).toContain(
      'onUsage: (event) => import("./alerts").then((m) => m.alertOnStorageUsage(event))',
    );
  });

  it("tells the alerts about the team in a companies project, and sets the team alert email up", async () => {
    const setup = code(file(await plan(C.companyAll), "src", "server", "company-setup.ts"));
    expect(setup).toContain("await alertOnTenancyEvent(event);");
    expect(setup).toContain('{ name: "alerts", run: (tenantId) => ensureTeamAlertTemplate(tenantId) }');
    // Alerts alone: the team's alerts still ride tenancy's events.
    expect(code(file(await plan(C.companyAlertsAlone), "src", "server", "company-setup.ts"))).toContain("await alertOnTenancyEvent(event);");
  });

  it("wires none of it without alerts", async () => {
    const p = await plan(C.companyFieldOnly);
    expect(has(p, "src", "server", "alerts.ts")).toBe(false);
    expect(code(file(p, "src", "server", "scheduling-notify.ts"))).not.toContain("alertOn");
    expect(code(file(p, "src", "server", "comms-senders.ts"))).not.toContain("onFailed");
    expect(code(file(p, "src", "server", "company-setup.ts"))).not.toContain("alertOnTenancyEvent");
  });
});

describe("one email per lead (D6): the office emails go to the people Alert settings name", () => {
  it.each([
    ["companies", C.companyAll, "/app/alerts/settings"],
    ["single", C.singleAll, "/admin/alerts/settings"],
  ] as const)("%s", async (_label, overrides, settingsHref) => {
    const p = await plan(overrides);
    for (const module of ["scheduling-notify.ts", "estimator-notify.ts"]) {
      const source = code(file(p, "src", "server", module));
      expect(source, module).toContain("officeRecipients: (notice) => officeRecipientsFor(notice),");
      expect(source, module).toContain("officeSent: (notice, result) => officeSentFor(notice, result),");
      // Kept, as the fallback for a claim that throws (review BO-02) — and said so.
      expect(source, module).toContain("staffEmails:");
      expect(file(p, "src", "server", module), module).toMatch(/`staffEmails` above is\s+(?:\/\/\s+)?read ONLY when/);
    }
    expect(file(p, "src", "server", "alerts-links.ts")).toContain(`export const ALERTS_SETTINGS_HREF: string | null = "${settingsHref}";`);
    const builders = overrides.tenantNoun === "none"
      ? [contentsAt(p, "app/api/admin/schedule/[...path]/route.ts"), contentsAt(p, "app/api/admin/estimator/[...path]/route.ts")]
      : [file(p, "src", "server", "scheduling.ts"), file(p, "src", "server", "estimator.ts")];
    for (const builder of builders) expect(code(builder)).toContain("alertsHref: ALERTS_SETTINGS_HREF,");
  });

  it("keeps 2a's lists where there is no Alert settings: no alerts, or one business with no shell", async () => {
    expect(file(await plan(C.companyFieldOnly), "src", "server", "alerts-links.ts")).toContain(
      "export const ALERTS_SETTINGS_HREF: string | null = null;",
    );
    const bare = await plan(C.singleNoShell);
    expect(has(bare, "src", "server", "scheduling-notify.ts")).toBe(false);
    expect(code(file(bare, "src", "server", "comms-senders.ts"))).toContain("onFailed");
  });
});

describe("named tables (review G1)", () => {
  it.each(WITH_ALERTS)("%s: the alerts' own tables", async (_label, overrides) => {
    expect(code(file(await plan(overrides), "src", "server", "alerts.ts"))).toContain("tables: notificationTables,");
  });
  it.each(WITH_FILES)("%s: the files' own tables", async (_label, overrides) => {
    expect(code(file(await plan(overrides), "src", "server", "files.ts"))).toContain("tables: storageTables,");
  });
});

describe("the team's own sending allowance (review BO-10)", () => {
  const keysOf = (senders: string): string[] => {
    const m = senders.match(/export const TEAM_TEMPLATE_KEYS: ReadonlySet<string> = new Set<string>\(\[([^\]]*)\]\);/);
    if (!m) throw new Error("no TEAM_TEMPLATE_KEYS");
    return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((k) => k[1]!).sort();
  };
  it("lists exactly the installed packages' office templates, plus team_alert with alerts", async () => {
    expect(keysOf(file(await plan(C.companyAll), "src", "server", "comms-senders.ts"))).toEqual(
      ["estimate_lead_staff", "quote_staff_notice", "team_alert", "visit_staff_notice"],
    );
    expect(keysOf(file(await plan(C.companyFieldOnly), "src", "server", "comms-senders.ts"))).toEqual(
      ["estimate_lead_staff", "quote_staff_notice", "visit_staff_notice"],
    );
    const senders = code(file(await plan(C.companyAll), "src", "server", "comms-senders.ts"));
    expect(senders).toContain("team: { hour: 60, day: 300 },");
    expect(senders).toContain("const key = team ? `comms-out-team:${bucket}:${tenantId}` : `comms-out:${bucket}:${tenantId}`;");
  });
});

describe("files: the dev disk (review BO-08) and the links (review G2)", () => {
  it.each(WITH_FILES)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    const files = code(file(p, "src", "server", "files.ts"));
    // An ENVIRONMENT check, never a feature one: neither token, while developing.
    expect(files).toContain('const devDisk = !privateBlob && !publicBlob && env.NODE_ENV === "development";');
    const disk = files.split("\n").filter((line) => line.includes("createLocalDiskStore("));
    expect(disk.length).toBe(2);
    for (const line of disk) expect(line).toContain("(devDisk ? createLocalDiskStore(");
    expect(file(p, ".gitignore")).toMatch(/^\.data\/$/m);
    // Links re-checked against the person and the company on every open.
    expect(files).toContain("signing: { secret, stillValid: options.stillValid ?? memberStillValid }");
    expect(files).toContain("if (env.FILES_LINK_SECRET) return env.FILES_LINK_SECRET;");
    expect(files).toContain('createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:file-links:v1").digest("hex")');
    // The private store is a PRIVATE Vercel Blob store, its own token.
    expect(files).toContain('createVercelBlobStore({ sdk: blobSdk, token: env.BLOB_PRIVATE_READ_WRITE_TOKEN, access: "private" })');
  });
});

describe("the registry and the records list exactly the installed features, on declared permissions", () => {
  const FRAGMENTS: ReadonlyArray<readonly [keyof Answers | "companies", string, string]> = [
    ["companies", "tenancyAlertKinds", "tenancy"],
    ["includeScheduling", "schedulingAlertKinds", "scheduling"],
    ["includeEstimator", "estimatorAlertKinds", "estimator"],
    ["includeInvoicing", "invoicingAlertKinds", "invoicing"],
    ["includeComms", "commsAlertKinds", "comms"],
    ["includeStorage", "storageAlertKinds", "storage"],
  ];
  const RECORDS: ReadonlyArray<readonly [keyof Answers, string, string]> = [
    ["includeScheduling", "schedulingFileRecords", "scheduling"],
    ["includeEstimator", "estimatorFileRecords", "estimator"],
    ["includeInvoicing", "invoicingFileRecords", "invoicing"],
  ];
  const on = (a: Answers, flag: keyof Answers | "companies") => (flag === "companies" ? a.tenantNoun !== "none" : Boolean(a[flag]));

  it.each(WITH_ALERTS)("%s: the alert registry", async (_label, overrides) => {
    const a = answers(overrides);
    const p = await plan(overrides);
    const fragments = registryFragments(code(file(p, "src", "server", "alerts.ts")));
    const expected = FRAGMENTS.filter(([flag]) => on(a, flag)).map(([, name]) => name);
    expect(fragments).toEqual(expected);
    // Every permission a kind asks is one this project's people can hold.
    const named = (await Promise.all(FRAGMENTS.filter(([flag]) => on(a, flag)).map(([, , pkg]) => permissionsNamedBy(pkg, "alerts")))).flat();
    await expectDeclared(p, a, named);
  });

  it.each(WITH_FILES)("%s: the record types", async (_label, overrides) => {
    const a = answers(overrides);
    const p = await plan(overrides);
    const records = recordFactories(code(file(p, "src", "server", "files.ts")));
    expect(records).toEqual(RECORDS.filter(([flag]) => on(a, flag)).map(([, name]) => name));
    const named = (await Promise.all(RECORDS.filter(([flag]) => on(a, flag)).map(([, , pkg]) => permissionsNamedBy(pkg, "files")))).flat();
    await expectDeclared(p, a, [...named, ...(await packagePermissionKeys("storage"))]);
  });

  /** Companies: a key of an installed package's fragment. One business: mapped to a staff key the catalog declares. */
  async function expectDeclared(p: EmitPlan, a: Answers, permissions: readonly string[]): Promise<void> {
    expect(permissions.length).toBeGreaterThan(0);
    if (a.tenantNoun !== "none") {
      const installed = ["tenancy", "notifications", "storage", "scheduling", "estimator", "invoicing", "comms"].filter((pkg) =>
        packagesFor(a).includes(`@adminigloo/${pkg}`),
      );
      const declared = new Set((await Promise.all(installed.map((pkg) => packagePermissionKeys(pkg)))).flat());
      for (const permission of permissions) expect(declared.has(permission), `${permission} is declared by an installed package`).toBe(true);
      return;
    }
    const maps = pathsOf(p)
      .filter((path) => path.startsWith("src/server/") && /_STAFF_KEYS\b/.test(contentsAt(p, path)))
      .flatMap((path) => [...contentsAt(p, path).matchAll(/^\s+"([a-z][a-z.]+)": "(staff\.[a-z.]+)",$/gm)].map((m) => [m[1]!, m[2]!] as const));
    const staffFor = new Map(maps);
    const catalog = file(p, "src", "permissions", "catalog.ts");
    for (const permission of permissions) {
      const staff = staffFor.get(permission);
      expect(staff, `${permission} has a staff key`).toBeDefined();
      expect(catalog, `${staff} is in the catalog`).toContain(`"${staff}": {`);
    }
  }
});

describe("roles another package adds", () => {
  it("names scheduling's Crew as absent when alerts name it and scheduling isn't installed, and nothing otherwise", async () => {
    const roles = async (o: Partial<Answers>) => code(file(await plan(o), "src", "permissions", "roles.ts"));
    expect(await roles(C.companyAlertsAlone)).toContain('export const ROLES_NOT_IN_THIS_PROJECT: readonly string[] = ["crew"];');
    expect(await roles(C.companyAll)).toContain("export const ROLES_NOT_IN_THIS_PROJECT: readonly string[] = [];");
    expect(await roles(C.companyFieldOnly)).toContain("export const ROLES_NOT_IN_THIS_PROJECT: readonly string[] = [];");
    expect(await roles(C.singleAll)).toContain("export const ROLES_NOT_IN_THIS_PROJECT: readonly string[] = [];");
    const catalogTest = code(file(await plan(C.companyAlertsAlone), "src", "permissions", "__tests__", "catalog.test.ts"));
    expect(catalogTest).toContain("templatesNamedBy(tenantCatalog, [...TENANT_TEMPLATE_KEYS, ...ROLES_NOT_IN_THIS_PROJECT])");
  });
});

describe("overlays (13.1)", () => {
  const EXPECTED: Readonly<Record<keyof typeof C, readonly string[]>> = {
    companyAll: ["notifications-companies", "storage", "storage-companies", "storage-visits-companies"],
    singleAll: ["notifications-single", "notifications-admin", "storage", "storage-single", "storage-admin", "storage-visits-admin"],
    companyAlertsAlone: ["notifications-companies"],
    companyFilesAlone: ["storage", "storage-companies"],
    companyFieldNoFiles: ["notifications-companies"],
    companyFieldOnly: [],
    singleNoShell: ["notifications-single", "storage", "storage-single"],
  };
  it.each(Object.keys(EXPECTED) as (keyof typeof C)[])("%s", async (label) => {
    const names = overlayNamesFor(answers(C[label])).filter((name) => /^(notifications|storage)/.test(name));
    expect([...names].sort()).toEqual([...EXPECTED[label]].sort());
    // And the plan collides nowhere (planEmit throws OverlayCollisionError).
    await expect(plan(C[label])).resolves.toBeDefined();
  });

  it("never pushes the empty notifications overlay", () => {
    for (const [, o] of ALL) expect(overlayNamesFor(answers(o))).not.toContain("notifications");
  });
});

describe("routes ↔ pages: every alerts and files page names a route that exists", () => {
  it("companies", async () => {
    const p = await plan(C.companyAll);
    let checked = 0;
    for (const path of pathsOf(p)) {
      if (!/^app\/\(site\)\/app\/(alerts|files|schedule\/visits)\//.test(path) || !path.endsWith("page.tsx")) continue;
      for (const match of contentsAt(p, path).matchAll(/\/api\/app\/\$\{company\.id\}\/([a-z-]+)/g)) {
        checked += 1;
        const route = `app/api/app/[tenantId]/${match[1]}/[...path]/route.ts`;
        expect(pathsOf(p), `${path} calls ${route}`).toContain(route);
        expect(code(contentsAt(p, route)), route).toMatch(/build(Alerts|Files)Handlers\(\)/);
      }
    }
    expect(checked).toBe(4);
    // The signed links and the logo, for anyone (both modes).
    expect(code(contentsAt(p, "app/api/files/[...path]/route.ts"))).toContain("buildFileLinkHandlers()");
  });

  it("single business", async () => {
    const p = await plan(C.singleAll);
    let checked = 0;
    for (const path of pathsOf(p)) {
      if (!/^app\/admin\/(alerts|files|schedule\/visits)\//.test(path) || !path.endsWith("page.tsx")) continue;
      for (const match of contentsAt(p, path).matchAll(/"\/api\/admin\/(alerts|files)"/g)) {
        checked += 1;
        expect(pathsOf(p), path).toContain(`app/api/admin/${match[1]}/[...path]/route.ts`);
      }
    }
    expect(checked).toBe(4);
    // The old inbox address still opens the alerts.
    expect(code(contentsAt(p, "app/admin/inbox/page.tsx"))).toContain('redirect("/admin/alerts")');
  });
});

describe("import order (13.10)", () => {
  it.each(ALL.filter(([, o]) => o.includeNotifications || o.includeStorage))("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    const imports = (path: string) => [...contentsAt(p, path).matchAll(/^import [^;]*? from "([^"]+)";$/gm)].map((m) => m[1]!);
    for (const path of ["src/server/alerts.ts", "src/server/files.ts"]) {
      if (!pathsOf(p).includes(path)) continue;
      expect(imports(path), path).not.toContain("@/server/company-routes");
      expect(imports(path), path).not.toContain("./company-routes");
    }
    if (pathsOf(p).includes("src/server/files.ts")) {
      // tenancy.ts imports files.ts at load (the logo store), so files.ts reaches tenancy only inside a function.
      expect(imports("src/server/files.ts")).not.toContain("@/server/tenancy");
      expect(imports("src/server/files.ts")).not.toContain("./tenancy");
      expect(imports("src/server/files.ts")).not.toContain("./alerts");
      expect(code(file(p, "src", "server", "tenancy-logo.ts"))).toContain('from "./files"');
    }
    // The emitted proof that loads every glue module first and alone.
    expect(pathsOf(p)).toContain("src/server/__tests__/glue-imports.test.ts");
  });
});

describe("crons (13.8), env and /setup (13.7)", () => {
  it("schedules the alerts and files crons daily, after the others", async () => {
    const vercel = JSON.parse(file(await plan(C.companyAll), "vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toEqual(
      expect.arrayContaining([
        { path: "/api/cron/alerts", schedule: "15 14 * * *" },
        { path: "/api/cron/files", schedule: "45 14 * * *" },
      ]),
    );
    const fieldOnly = JSON.parse(file(await plan(C.companyFieldOnly), "vercel.json")) as { crons: { path: string }[] };
    expect(fieldOnly.crons.map((c) => c.path)).not.toContain("/api/cron/alerts");
    expect(fieldOnly.crons.map((c) => c.path)).not.toContain("/api/cron/files");
  });

  it("serves every active company from the alerts cron, and the one business in a single one", async () => {
    const companies = code(file(await plan(C.companyAll), "app", "api", "cron", "alerts", "route.ts"));
    expect(companies).toContain("runForEachCompany(");
    expect(companies).toContain("tenantIds: await tenancy.activeCompanyIds(),");
    const single = code(file(await plan(C.singleAll), "app", "api", "cron", "alerts", "route.ts"));
    expect(single).toContain("tenantIds: [ALERTS_TENANT]");
    expect(single).not.toContain("runForEachCompany(");
    const filesCron = code(file(await plan(C.companyAll), "app", "api", "cron", "files", "route.ts"));
    expect(filesCron).toContain("files.purgeDeleted({ timeBudgetMs: 30_000 })");
    // Batches until none are left or the run's time is spent (review BUY-05).
    expect(filesCron).toContain("files.moveToPrivate({ purpose, limit: MOVE_BATCH, timeBudgetMs: left })");
    // A live check every day, which /setup then shows for an hour (review BUY-06).
    expect(filesCron).toContain("privateStoreVerdict({ fresh: true, storage: files })");
    // 0.1's library files move too (review BUY-04).
    expect(file(await plan(C.companyAll), "src", "server", "files.ts")).toContain('export const FILES_MOVE_TO_PRIVATE: readonly string[] = ["library.file", "estimator.photo"];');
    expect(file(await plan(C.companyFilesAlone), "src", "server", "files.ts")).toContain('export const FILES_MOVE_TO_PRIVATE: readonly string[] = ["library.file"];');
  });

  it("declares the private store, the allowance and the link key, and refuses one token for both stores", async () => {
    const env = file(await plan(C.companyAll), "src", "env.ts");
    expect(env).toContain("BLOB_PRIVATE_READ_WRITE_TOKEN: z.string().min(1).optional(),");
    expect(env).toContain('FILES_ALLOWANCE_MB: z.coerce.number().int("a whole number of megabytes").min(1).max(1048576).optional(),');
    expect(env).toContain('FILES_LINK_SECRET: z.string().min(32, "at least 32 characters").optional(),');
    expect(env).toContain("The private store needs its own token: connect a second Blob store with access Private.");
    expect(file(await plan(C.companyAlertsAlone), "src", "env.ts")).not.toContain("BLOB_PRIVATE_READ_WRITE_TOKEN");
    const setup = file(await plan(C.companyAll), "app", "(site)", "setup", "page.tsx");
    expect(setup).toContain("<SetupFilesSlot />");
    for (const name of ["BLOB_PRIVATE_READ_WRITE_TOKEN", "FILES_ALLOWANCE_MB", "FILES_LINK_SECRET"]) expect(setup).toContain(name);
  });
});

describe("capabilities (13.9): each claim is proven by the files the plan wrote", () => {
  const KEYS = [
    "notifications.fanout",
    "notifications.bell",
    "notifications.inbox",
    "notifications.producers",
    "storage.files",
    "storage.library",
    "storage.attachments",
    "estimator.photos",
  ];
  it.each([
    ["companies", C.companyAll],
    ["single", C.singleAll],
  ] as const)("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    for (const key of KEYS) {
      expect(capabilitiesFor(answers(overrides)), key).toContain(key);
      const row = CAPABILITY_EVIDENCE.find((r) => r.capability === key);
      expect(row, key).toBeDefined();
      expect(row!.provenBy(p), key).toBe(true);
    }
  });

  it("claims no inbox or library for one business with no shell, and the bell all the same", () => {
    const keys = capabilitiesFor(answers(C.singleNoShell));
    expect(keys).toContain("notifications.bell");
    expect(keys).not.toContain("notifications.inbox");
    expect(keys).not.toContain("storage.library");
  });
});

describe("what the project installs and says (17)", () => {
  it("installs both widgets at their first lines, and the 2b-1 lines of every package", async () => {
    expect(packagesFor(answers(C.companyAll))).toEqual(
      expect.arrayContaining(["@adminigloo/notifications-widget", "@adminigloo/storage-widget"]),
    );
    for (const [pkg, range] of [
      ["notifications", "^0.2.0"],
      ["notifications-widget", "^0.1.0"],
      ["storage", "^0.2.0"],
      ["storage-widget", "^0.1.0"],
      ["tenancy", "^0.7.0"],
      ["tenancy-widget", "^0.2.2"],
      ["scheduling", "^0.6.0"],
      ["scheduling-widget", "^0.3.0"],
      ["estimator", "^0.5.0"],
      ["estimator-widget", "^0.5.0"],
      ["invoicing", "^0.6.0"],
      ["invoicing-widget", "^0.2.0"],
      ["comms", "^0.5.0"],
      ["comms-widget", "^0.1.1"],
    ] as const) {
      expect(versionRangeFor(`@adminigloo/${pkg}`), pkg).toBe(range);
    }
    const manifest = JSON.parse(file(await plan(C.companyAll), "package.json")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@vercel/blob"]).toBe("^2.8.0");
  });

  it("says in the README what each company gets and what isn't included, word for word", async () => {
    const readme = file(await plan(C.companyAll), "README.md");
    expect(readme).toContain("### Alerts and files");
    expect(readme).toContain("/app/alerts/settings");
    expect(readme).toContain("/app/files");
    const single = TENANCY_2B1_NOT_INCLUDED[17]!;
    for (const item of TENANCY_2B1_NOT_INCLUDED.filter((entry) => entry !== single)) expect(readme).toContain(item);
    // The single-business-without-a-shell line is a single business's only.
    expect(readme).not.toContain(single);
    const singleReadme = file(await plan(C.singleAll), "README.md");
    expect(singleReadme).toContain(single);
    expect(singleReadme).toContain("/admin/alerts/settings");
    expect(singleReadme).not.toContain(TENANCY_2B1_NOT_INCLUDED[12]!); // the bell's other companies
    // 2a's items 2b-1 delivered or restated are gone from both.
    for (const item of TENANCY_2A_SUPERSEDED) expect(readme).not.toContain(item);
    // A project with neither feature has no section.
    expect(file(await plan(C.companyFieldOnly), "README.md")).not.toContain("### Alerts and files");
  });

  it("lists the same Not included items in the generator's own README, so a buyer reads them before generating", async () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const own = flat(await readFile(join(__dirname, "..", "..", "README.md"), "utf8"));
    expect(own).toContain("### Not included (Tenancy 2b-1)");
    for (const item of TENANCY_2B1_NOT_INCLUDED) expect(own, item).toContain(flat(item));
    expect(own).toContain("--storage --notifications --ai");
  });

  it("tells the operator in DEPLOYMENT.md about the two stores, word for word, and the two crons", async () => {
    const deployment = file(await plan(C.companyAll), "DEPLOYMENT.md");
    // Both stores, for a fresh deployment as well as an upgrade (review BUY-08).
    expect(deployment).toContain(
      "1. **The public store, for logos.** In the Vercel dashboard open Storage → Create → Blob, set its access to **Public**, and connect it to this project with the usual environment variable prefix, `BLOB` (that gives `BLOB_READ_WRITE_TOKEN`). If the project already has a Blob store, keep it: that is this one, and it holds the company logos.",
    );
    expect(deployment).toContain(
      "2. **The private store, for photos and files.** For photos and files, in the Vercel dashboard open Storage → Create → Blob, set its access to Private, and connect it to this project with the environment variable prefix `BLOB_PRIVATE` (that gives `BLOB_PRIVATE_READ_WRITE_TOKEN`). Redeploy.",
    );
    expect(deployment).toContain("**What files cost.** Vercel's included Blob storage and operations are for the whole platform, not per company;");
    for (const word of ["FILES_ALLOWANCE_MB", "FILES_LINK_SECRET", "/api/cron/alerts", "/api/cron/files"]) expect(deployment).toContain(word);
    expect(deployment).not.toContain("<!-- adminigloo:alerts-files -->");
    // With alerts, the office notices go to the people Alert settings name.
    expect(deployment).toContain("the people the company's owner names in Alert\nsettings");
    const neither = file(await plan(C.companyFieldOnly), "DEPLOYMENT.md");
    expect(neither).not.toContain("### Photos and files: two Blob stores");
    expect(neither).not.toContain("FILES_ALLOWANCE_MB");
    expect(neither).not.toContain("/api/cron/alerts");
    expect(neither).not.toContain("<!-- adminigloo:alerts-files -->");
  });

  it("emits the alerts and files proofs where they apply", async () => {
    const full = pathsOf(await plan(C.companyAll));
    for (const proof of ["company-alerts.test.ts", "company-files.test.ts", "glue-imports.test.ts", "feature-isolation.test.ts"]) {
      expect(full).toContain(`src/server/__tests__/${proof}`);
    }
    const alertsAlone = pathsOf(await plan(C.companyAlertsAlone));
    expect(alertsAlone).toContain("src/server/__tests__/company-alerts.test.ts");
    expect(alertsAlone).not.toContain("src/server/__tests__/company-files.test.ts");
    // The isolation test covers alerts and files even with no field feature.
    expect(alertsAlone).toContain("src/server/__tests__/feature-isolation.test.ts");
    expect(pathsOf(await plan(C.companyFilesAlone))).toContain("src/server/__tests__/feature-isolation.test.ts");
    const single = pathsOf(await plan(C.singleAll));
    expect(single).not.toContain("src/server/__tests__/company-alerts.test.ts");
    expect(single).toContain("src/server/__tests__/glue-imports.test.ts");
  });
});

describe("what the terminal says after generating (Tenancy 2b-1)", () => {
  // The next steps are the one piece of documentation that reliably gets
  // read. 0.1's lines said the inbox was a primitive nobody writes to and
  // that files turn on with the PUBLIC Blob token — both false once the
  // producers are wired and files are private, and the second would send an
  // owner to connect the wrong store.
  it("says alerts are wired, where the choices are, and that files need the private store", async () => {
    const { nextSteps } = await import("../cli.js");
    const company = nextSteps(answers(C.companyAll), "/out/igloo-back-office");
    const single = nextSteps(answers(C.singleAll), "/out/igloo-back-office");
    const noShell = nextSteps(answers(C.singleNoShell), "/out/igloo-back-office");
    for (const out of [company, single, noShell]) {
      expect(out).not.toMatch(/primitive|honestly empty|Wire your first producer/);
      expect(out).not.toContain("File uploads turn on with BLOB_READ_WRITE_TOKEN");
      expect(out).not.toContain("kept with their estimate once");
      expect(out).toContain("Alerts are on");
      expect(out).toContain("BLOB_PRIVATE");
      expect(out).toContain(".data/files");
    }
    expect(company).toContain("At /app/alerts/settings each person picks");
    expect(company).toContain("keeps company logos");
    expect(single).toContain("At /admin/alerts/settings each person picks");
    expect(single).not.toContain("logos");
    expect(noShell).toContain("Alert settings come with the admin panel");
    expect(company).toContain("Customers' photos are kept privately with their estimate");
  });
});
