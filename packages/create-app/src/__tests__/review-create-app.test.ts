/**
 * The owner-review findings against a generated --scheduling project, one
 * test per finding (BO-xx from the business-owner walk, F9 from the code
 * review). Each fails on the generator before the fix.
 *
 * Read from the PLAN as text, like scheduling-overlay.test.ts: the routes
 * reach `@/db` and can't run here. The decisions they call are tested for real
 * in the overlay's own src/server/__tests__/scheduling-config.test.ts (run in
 * a generated project) and against the real handlers in
 * e2e/tests/scheduling-scenario.spec.ts.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, IncompatibleAnswersError, assertAnswersCompatible, type Answers } from "../answers.js";
import { collectAnswers, nextSteps } from "../cli.js";
import { COMMS_CRON_DAILY_AT_UTC, planEmit, type EmitPlan } from "../emit.js";
import { defaultsOnlyPrompter } from "../prompt.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");

function answers(overrides: Partial<Answers> = {}): Answers {
  return {
    ...DEFAULT_ANSWERS,
    projectName: "acme-windows",
    adminShell: "minimal",
    includeScheduling: true,
    includeComms: true,
    includeEmail: true,
    ...overrides,
  };
}

const plan = (overrides: Partial<Answers> = {}) => planEmit(TEMPLATE_DIR, "/out", answers(overrides));

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("BO-03: scheduling is never generated into a project nobody can answer it from", () => {
  it("refuses --scheduling --admin none, in plain words, before anything is planned", async () => {
    expect(() => assertAnswersCompatible(answers({ adminShell: "none" }))).toThrow(IncompatibleAnswersError);
    expect(() => assertAnswersCompatible(answers({ adminShell: "none" }))).toThrow(/needs an admin panel/);
    await expect(plan({ adminShell: "none" })).rejects.toThrow(IncompatibleAnswersError);
    // Without scheduling, no shell is still a perfectly good project.
    expect(() => assertAnswersCompatible(answers({ adminShell: "none", includeScheduling: false }))).not.toThrow();
  });

  it("refuses it from the CLI too, before a directory is created", async () => {
    await expect(
      collectAnswers({ name: "acme", yes: true, help: false, scheduling: true, adminShell: "none" }, defaultsOnlyPrompter()),
    ).rejects.toThrow(IncompatibleAnswersError);
  });

  it("brings customer email with scheduling unless it is explicitly declined", async () => {
    // --scheduling alone used to generate a project whose customers were
    // never emailed anything: comms and email both defaulted to no.
    const brought = await collectAnswers({ name: "acme", yes: true, help: false, scheduling: true }, defaultsOnlyPrompter());
    expect(brought).toMatchObject({ includeScheduling: true, includeComms: true, includeEmail: true });
    const declined = await collectAnswers(
      { name: "acme", yes: true, help: false, scheduling: true, comms: false, email: false },
      defaultsOnlyPrompter(),
    );
    expect(declined).toMatchObject({ includeScheduling: true, includeComms: false, includeEmail: false });
  });
});

describe("BO-01: reminders go out the day before, on the cron that actually runs", () => {
  it("queues reminders for the same daily run vercel.json schedules — one value, not two", async () => {
    const p = await plan();
    const vercel = JSON.parse(file(p, "vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    const comms = vercel.crons.find((cron) => cron.path === "/api/cron/comms");
    const { hour, minute } = COMMS_CRON_DAILY_AT_UTC;
    expect(comms?.schedule).toBe(`${minute} ${hour} * * *`);
    const notify = code(file(p, "src", "server", "scheduling-notify.ts"));
    const runAt = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    expect(notify).toContain(`REMINDER_RUNS = { dailyAtUtc: "${runAt}" }`);
    expect(notify).toContain("reminderRuns: REMINDER_RUNS");
  });

  it("tells the developer when reminders really go out, in the next steps", () => {
    const out = nextSteps(answers(), "/out/acme-windows");
    expect(out).toContain("once a day (7 AM Mountain)");
    expect(out).toContain("CRON_SECRET");
    expect(out).toContain("15 minutes (DEPLOYMENT.md)");
    // Only pages this project has, and the first one is the switch.
    expect(out).toContain("Online booking starts OFF");
  });
});

describe("BO-02 and BO-06: a crew member gets their route and nothing else", () => {
  it("declares one staff key per scheduling job in the catalog", async () => {
    const catalog = file(await plan(), "src", "permissions", "catalog.ts");
    for (const key of ["staff.schedule.route", "staff.schedule.view", "staff.schedule.manage", "staff.schedule.settings"]) {
      expect(catalog, key).toContain(`"${key}": {`);
    }
  });

  it("puts each sidebar entry on its own key, so a crew member sees only Today's route", async () => {
    const nav = code(file(await plan(), "src", "components", "admin", "AdminNav.tsx"));
    const entry = (href: string) => nav.slice(nav.indexOf(`href: "${href}"`), nav.indexOf(`href: "${href}"`) + 200);
    expect(entry("/admin/schedule")).toContain('permission: "staff.schedule.view"');
    expect(entry("/admin/schedule/today")).toContain('permission: "staff.schedule.route"');
    expect(entry("/admin/schedule/settings")).toContain('permission: "staff.schedule.settings"');
  });

  it("wires the people picker and the crew-role grant into the staff route", async () => {
    const p = await plan();
    const route = code(file(p, "app", "api", "admin", "schedule", "[...path]", "route.ts"));
    expect(route).toContain("listPeople: () => listSchedulingPeople()");
    expect(route).toContain("onCrewMemberChange: (change) => onSchedulingCrewChange(change)");
    const server = code(file(p, "src", "server", "scheduling.ts"));
    expect(server).toContain("export async function onSchedulingCrewChange(");
    expect(server).toContain("crewAccessChange(");
    expect(server).toContain("auditEntry(auditRegistry, {");
    expect(server).toContain('"scheduling.crew.access.granted"');
    expect(server).toContain("ensureCrewAccess(tx)");
    // The audit log knows the actions it is asked to write.
    expect(code(file(p, "src", "server", "audit.ts"))).toContain("schedulingAuditedActions");
  });

  it("points the settings screen at the page a new crew member signs in on", async () => {
    const page = file(await plan(), "app", "admin", "schedule", "settings", "page.tsx");
    expect(page).toContain("signInUrl={schedulingUrls.signIn}");
  });
});

describe("BO-04: the staff screens are told whether email actually goes out", () => {
  it("passes the delivery status to the staff handler, with or without comms", async () => {
    for (const includeComms of [true, false]) {
      const p = await plan({ includeComms });
      expect(code(file(p, "app", "api", "admin", "schedule", "[...path]", "route.ts"))).toContain(
        "delivery: () => schedulingDelivery()",
      );
      expect(code(file(p, "src", "server", "scheduling-notify.ts"))).toContain(
        "export async function schedulingDelivery(): Promise<DeliveryStatus>",
      );
    }
    const notify = code(file(await plan(), "src", "server", "scheduling-notify.ts"));
    expect(notify).toContain("emailConfigured: commsEmailConfigured");
    expect(notify).toContain("cronSecretSet: Boolean(env.CRON_SECRET)");
  });
});

describe("BO-07: addresses resolve in the country the business works in", () => {
  it("biases the geocoder to the United States", async () => {
    expect(code(file(await plan(), "src", "server", "scheduling.ts"))).toContain('region: "us"');
  });
});

describe("BO-08: the first deploy doesn't go live under the folder name", () => {
  it("writes the first settings with no business name — online booking starts off", async () => {
    const server = code(file(await plan(), "src", "server", "scheduling.ts"));
    expect(server).toContain("firstSchedulingSettings({ timeZone: env.SCHEDULING_TIME_ZONE })");
    expect(server).not.toContain("businessName: projectName");
    const config = code(file(await plan(), "src", "server", "scheduling-config.ts"));
    expect(config).toContain("publicBookingEnabled: false");
  });
});

describe("BO-14: the owner can read the visit emails before the first booking", () => {
  it("adds them at first boot and whenever Messages lists its templates", async () => {
    const p = await plan();
    const server = code(file(p, "src", "server", "scheduling.ts"));
    expect(server).toContain("await ensureSchedulingEmailTemplates()");
    expect(code(file(p, "src", "server", "scheduling-notify.ts"))).toContain(
      "await schedulingComms.ensureTemplates(SCHEDULING_TENANT)",
    );
    expect(code(file(p, "src", "server", "comms-hooks.ts"))).toContain("export async function ensureProducerTemplates(");
    expect(code(file(p, "src", "server", "routers", "comms.ts"))).toContain("await ensureProducerTemplates(COMMS_TENANT)");
  });
});

describe("F9: a drain that throws part-way still scrubs the sent links", () => {
  it("runs the scrub in a finally, in the cron and in the console's send-now", async () => {
    const p = await plan();
    for (const path of [
      ["app", "api", "cron", "comms", "route.ts"],
      ["src", "server", "routers", "comms.ts"],
    ]) {
      const source = code(file(p, ...path));
      expect(source, path.join("/")).toMatch(/finally\s*\{\s*await afterCommsRun\(\);\s*\}/);
    }
  });
});
