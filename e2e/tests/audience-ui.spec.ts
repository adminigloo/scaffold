import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * @adminigloo/audience's admin components (`./ui`) in a real browser, inside
 * an admin shell shaped like Riddler Go's analytics page: a KPI card with the
 * include-internal switch and the "Excluded: N" line, the internal-audience
 * panel, the Mark this browser button and the unfiltered-sources note — all
 * fed by an in-memory fake server behind the callbacks, the way server
 * actions feed them (mutate, then the page re-renders with fresh props).
 *
 * SELF-CONTAINED like feedback-board.spec.ts: the components are bundled in
 * beforeAll from the package SOURCE (packages/audience/src/ui.tsx) with
 * esbuild, react pinned to e2e's single copy, as a DEVELOPMENT build under
 * StrictMode. Every test also fails on an uncaught page error or any console
 * error/warning.
 *
 * Negative control: AIU_UI_SRC=<path to another ui.tsx> bundles that file
 * instead (copy core/labels.ts, core/words.ts, ui-tokens.ts and views.ts
 * beside it). Against a copy with ink-muted lowered to #9aa5ae, buttons at
 * 30px and Add enabled before any preview, the 44px test, both light-scheme
 * axe tests and the three preview-before-add tests fail, as they must.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const uiEntry = (
  process.env.AIU_UI_SRC ? resolve(process.env.AIU_UI_SRC) : join(e2eRoot, "..", "packages", "audience", "src", "ui.tsx")
).replace(/\\/g, "/");
const ORIGIN = "https://admin.test";
const PAGE_URL = `${ORIGIN}/admin/analytics/audience`;

/**
 * The host app. Plain JS/JSX inside a template string — no backticks, no
 * template holes except the marked ones.
 */
const HOST_APP = `
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AudienceRulesPanel,
  ExcludedNote,
  IncludeInternalToggle,
  MarkThisBrowserButton,
  UnfilteredSourcesNote,
} from ${JSON.stringify(uiEntry)};

const cfg = window.__cfg;
const clone = (rows) => rows.map((row) => Object.assign({}, row));

const srv = {
  rules: clone(cfg.rules),
  runs: clone(cfg.runs),
  calls: [],
  // resolve | reject | hold
  previewMode: "resolve",
  addMode: "resolve",
  removeMode: "resolve",
  markMode: "resolve",
  duplicate: false,
  held: [],
  ready: false,
  render() {},
  release(ok) {
    const next = srv.held.shift();
    if (!next) throw new Error("nothing is held");
    if (ok === false) next.reject(new Error("Server said no"));
    else next.resolve();
  },
};
window.__srv = srv;

// "error-result": the call RESOLVES { error } — how a server action keeps its
// reason in a production Next build, where a thrown error's message is hidden.
const RESULT_ERROR = "An active rule already says that.";

function gate(mode) {
  if (mode === "reject") return Promise.reject(new Error("The database is unavailable — try again."));
  if (mode === "hold") return new Promise((resolve, reject) => { srv.held.push({ resolve, reject }); });
  return Promise.resolve();
}

function fakePreview(draft) {
  const n = draft.value.length;
  const visitOnly = ["network", "host", "user_agent"].indexOf(draft.kind) !== -1;
  return {
    retroactive: !visitOnly,
    subjects: visitOnly ? { users: 0, visitors: 0, orgs: 0, events: 0, orders: 0 } : { users: 1, visitors: 2, orgs: 0, events: 0, orders: 0 },
    alreadyExcluded: { users: 0, visitors: 0, orgs: 0, events: 0, orders: 0 },
    windows: visitOnly ? [] : [
      { key: "30d", label: "Last 30 days", before: { sessions: 1200, visitors: 800 }, excluded: { sessions: n, visitors: 2 }, after: { sessions: 1200 - n, visitors: 798 }, earliest: "2026-09-20T00:00:00Z" },
      { key: "90d", label: "Last 90 days", before: { sessions: 3400, visitors: 2100 }, excluded: { sessions: n * 2, visitors: 2 }, after: { sessions: 3400 - n * 2, visitors: 2098 }, earliest: "2026-07-20T00:00:00Z" },
      { key: "all", label: "All time", before: { sessions: 9100, visitors: 5000 }, excluded: { sessions: n * 3, visitors: 2 }, after: { sessions: 9100 - n * 3, visitors: 4998 }, earliest: "2026-03-02T00:00:00Z" },
    ],
    limits: visitOnly ? ["Network rules apply to new visits only: IP addresses are never stored, so past visits cannot be matched."] : [],
    duplicateOf: srv.duplicate ? "r1" : null,
  };
}

async function onPreview(draft) {
  srv.calls.push({ fn: "onPreview", draft: draft });
  await gate(srv.previewMode);
  if (srv.previewMode === "error-result") return { error: RESULT_ERROR };
  return fakePreview(draft);
}

async function onAdd(draft) {
  srv.calls.push({ fn: "onAdd", draft: draft });
  await gate(srv.addMode);
  if (srv.addMode === "error-result") return { error: RESULT_ERROR };
  const id = "r" + (srv.rules.length + 10);
  srv.rules = [{ id: id, kind: draft.kind, value: draft.value.toLowerCase(), reasonLabel: draft.reasonLabel, note: draft.note, createdBy: "dallin@adminigloo.com", createdAt: "2026-10-08T12:00:00Z", appliesFrom: draft.appliesFrom }].concat(srv.rules);
  const annotation = "Internal rule added: " + draft.value.length * 3 + " sessions excluded back to 2026-03-02";
  srv.runs = [{ id: "x" + Date.now(), action: "apply", subjectsChanged: 3, sessionsAffected: draft.value.length * 3, runBy: "dallin@adminigloo.com", runAt: "2026-10-08T12:00:00Z", summary: annotation }].concat(srv.runs);
  srv.render();
  return { applied: { annotation: annotation } };
}

async function onRemove(ruleId) {
  srv.calls.push({ fn: "onRemove", ruleId: ruleId });
  await gate(srv.removeMode);
  if (srv.removeMode === "error-result") return { error: "That rule does not exist." };
  srv.rules = srv.rules.filter((rule) => rule.id !== ruleId);
  srv.render();
  return { annotation: "Internal rule removed: 12 sessions counted again" };
}

async function onMark() {
  srv.calls.push({ fn: "onMark" });
  await gate(srv.markMode);
  if (srv.markMode === "error-result") return { error: "This browser has no visitor id yet — load a page first." };
}

function App() {
  const [rules, setRules] = useState(() => clone(srv.rules));
  const [runs, setRuns] = useState(() => clone(srv.runs));
  const [includeInternal, setIncludeInternal] = useState(!!cfg.includeInternal);
  useEffect(() => {
    srv.render = () => { setRules(clone(srv.rules)); setRuns(clone(srv.runs)); };
    srv.ready = true;
  }, []);
  const excluded = { total: 312, byReason: { role: 200, email: 60, named_user: 40, automation: 12 } };
  const href = includeInternal ? "/admin/analytics/audience" : "/admin/analytics/audience?include_internal=1";
  return (
    <div className="shell">
      <nav className="side" aria-label="Admin">
        <a href="/admin">Dashboard</a>
        <a href="/admin/analytics">Analytics</a>
        <a href="/admin/analytics/audience" aria-current="page">Internal audience</a>
      </nav>
      <main className="main">
        <h1>Analytics</h1>
        <section className="card" aria-label="Visits">
          <div className="kpi"><span className="kpi-label">Visits</span><span className="kpi-value">{includeInternal ? "9,412" : "9,100"}</span></div>
          <ExcludedNote excluded={excluded} includeInternal={includeInternal} theme={cfg.theme} />
          <IncludeInternalToggle
            value={includeInternal}
            href={href}
            theme={cfg.theme}
            onNavigate={(to) => { srv.calls.push({ fn: "navigate", href: to }); setIncludeInternal(to.indexOf("include_internal=1") !== -1); }}
          />
        </section>
        <AudienceRulesPanel
          rules={rules}
          runs={runs}
          canEdit={cfg.canEdit}
          maskEmails={cfg.maskEmails}
          onPreview={onPreview}
          onAdd={onAdd}
          onRemove={onRemove}
          codeRule="Platform role is super, staff or analytics"
          theme={cfg.theme}
        />
        <div className="row">
          <MarkThisBrowserButton onMark={onMark} theme={cfg.theme} />
          <UnfilteredSourcesNote theme={cfg.theme} />
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

/** The host's own CSS — a light admin with no dark mode, like most. */
const HOST_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #ffffff; color: #111827; }
.shell { display: flex; min-height: 100vh; }
.side { width: 220px; flex: none; background: #0b1220; padding: 16px 12px; }
.side a { display: block; color: #e5e7eb; padding: 12px; text-decoration: none; border-radius: 8px; }
.main { flex: 1; min-width: 0; padding: 24px; display: grid; gap: 20px; align-content: start; }
.main h1 { font-size: 22px; margin: 0; }
.card { border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; display: grid; gap: 10px; }
.kpi { display: grid; }
.kpi-label { color: #4b5563; font-size: 13px; }
.kpi-value { font-size: 28px; font-weight: 700; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 20px; align-items: start; }
@media (max-width: 700px) { .side { display: none; } .main { padding: 16px; } }
`;

interface Rule {
  id: string;
  kind: string;
  value: string;
  reasonLabel?: string | null;
  note?: string | null;
  createdBy?: string | null;
  createdAt: string;
  appliesFrom?: string | null;
}

const RULES: Rule[] = [
  { id: "r1", kind: "email", value: "rachel.smith@gmail.com", reasonLabel: "Rachel (client)", createdBy: "dallin@adminigloo.com", createdAt: "2026-10-01T10:00:00Z" },
  { id: "r2", kind: "email_domain", value: "riddlergo.com", reasonLabel: "Staff", createdBy: "dallin@adminigloo.com", createdAt: "2026-09-01T00:00:00Z" },
  { id: "r3", kind: "network", value: "203.0.113.0/24", reasonLabel: "Office", createdBy: "sam@riddlergo.com", createdAt: "2026-09-02T00:00:00Z" },
];
const RUNS = [
  { id: "x1", action: "apply", subjectsChanged: 3, sessionsAffected: 57, runBy: "dallin@adminigloo.com", runAt: "2026-10-01T10:00:01Z", summary: "Internal rule added (person (email) r***@gmail.com): 57 sessions excluded back to 2026-06-10" },
  { id: "x0", action: "apply", subjectsChanged: 14, sessionsAffected: 255, runBy: "dallin@adminigloo.com", runAt: "2026-09-01T00:00:01Z", summary: "Internal rule added (staff domain riddlergo.com): 255 sessions excluded back to 2026-03-02" },
];

interface Cfg {
  rules: Rule[];
  runs: typeof RUNS;
  canEdit: boolean;
  maskEmails?: boolean;
  theme?: "auto" | "light" | "dark";
  includeInternal?: boolean;
}

interface Call {
  fn: string;
  draft?: { kind: string; value: string; reasonLabel: string | null; note: string | null; appliesFrom: string | null };
  ruleId?: string;
  href?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __srv: any;
    __cfg: Cfg;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "audience-host.tsx", loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: {
      react: join(e2eRoot, "node_modules", "react"),
      "react-dom": join(e2eRoot, "node_modules", "react-dom"),
    },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]!.text;
});

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });

const problems = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on("pageerror", (error) => list.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") list.push(`${message.type()}: ${message.text()}`);
  });
});
test.afterEach(({ page }) => {
  expect(problems.get(page) ?? [], "uncaught errors or console errors/warnings on the page").toEqual([]);
});

function shellHtml(cfg: Cfg, hostCss: string): string {
  const data = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Internal audience · Admin</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style id="host-css">${HOST_CSS}</style>` +
    (hostCss ? `<style id="host-tokens">${hostCss}</style>` : "") +
    `</head><body><div id="root"></div><script>window.__cfg = ${data};</script>` +
    '<script src="/bundle.js"></script></body></html>'
  );
}

async function boot(page: Page, cfg: Partial<Cfg> = {}, hostCss = ""): Promise<void> {
  const full: Cfg = { rules: RULES, runs: RUNS, canEdit: true, ...cfg };
  await page.context().route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/admin/analytics/audience") return route.fulfill({ contentType: "text/html", body: shellHtml(full, hostCss) });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Elsewhere</title><h1>Elsewhere</h1></html>' });
  });
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => window.__srv?.ready === true);
  await expect(page.locator(".aiu-panel")).toBeVisible();
}

const panel = (page: Page): Locator => page.locator(".aiu-panel");
const addButton = (page: Page): Locator => panel(page).getByRole("button", { name: "Add rule" });
const previewButton = (page: Page): Locator => panel(page).getByRole("button", { name: /^Preview/ });
const valueInput = (page: Page): Locator => panel(page).getByRole("textbox", { name: "Person (email)", exact: true });
const status = (page: Page): Locator => panel(page).locator('[role="status"]');

async function calls(page: Page, fn?: string): Promise<Call[]> {
  const all: Call[] = await page.evaluate(() => JSON.parse(JSON.stringify(window.__srv.calls)));
  return fn ? all.filter((call) => call.fn === fn) : all;
}

const setMode = (page: Page, which: "previewMode" | "addMode" | "removeMode" | "markMode", mode: "resolve" | "reject" | "hold" | "error-result") =>
  page.evaluate(([key, value]) => {
    window.__srv[key!] = value;
  }, [which, mode] as const);

async function hits(target: Locator, x: number, y: number): Promise<boolean> {
  return target.evaluate((el, [px, py]) => {
    const top = document.elementFromPoint(px!, py!);
    return top !== null && (top === el || el.contains(top));
  }, [x, y]);
}

/** A touch target: at least 44×44, and a click at its centre lands on it. */
async function expectTarget(target: Locator, what: string, min = 44): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  const box = await target.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(min);
  expect(await hits(target, box!.x + box!.width / 2, box!.y + box!.height / 2), `${what}: a click at its centre lands elsewhere`).toBe(true);
}

async function axeViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include(include).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.replace(/\s+/g, " ")}`),
  }));
}

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    return `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.id ?? ""}:${(el.textContent ?? "").trim().slice(0, 40)}`;
  });
}

/** Press Tab until `target` has focus (keyboard only), at most `max` times. */
async function tabTo(page: Page, target: Locator, max = 25): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached the target; focus is on ${await focusedName(page)}`);
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing on any component — ${scheme} scheme, at rest, with a preview, and mid-removal`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, { includeInternal: true });
    expect(await axeViolations(page, ".aiu-root"), "at rest").toEqual([]);

    await valueInput(page).fill("new.person@gmail.com");
    await previewButton(page).click();
    await expect(panel(page).locator(".aiu-preview")).toBeVisible();
    await panel(page).locator(".aiu-defaults > summary").click();
    expect(await axeViolations(page, ".aiu-root"), "preview showing, defaults open").toEqual([]);

    await panel(page).getByRole("button", { name: /^Remove rule: Email domain/ }).click();
    await expect(panel(page).getByRole("button", { name: "Remove rule", exact: true })).toBeFocused();
    expect(await axeViolations(page, ".aiu-root"), "confirming a removal").toEqual([]);
  });
}

test("the analytics role's view is axe-clean too", async ({ page }) => {
  await boot(page, { canEdit: false, maskEmails: true });
  expect(await axeViolations(page, ".aiu-root")).toEqual([]);
});

test("every control is a 44px target a click actually reaches", async ({ page }) => {
  await boot(page);
  await valueInput(page).fill("someone@gmail.com");
  await previewButton(page).click();
  await expect(addButton(page)).toBeEnabled();
  const controls = page.locator('.aiu-root :is(button, input, select, summary, a[role="switch"], [role="region"][tabindex])');
  const count = await controls.count();
  expect(count).toBeGreaterThan(10);
  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const label = await control.evaluate((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.id ?? ""} ${(el.textContent ?? "").trim().slice(0, 30)}`);
    if (label.startsWith("div")) continue; // the preview table's scroll region is not a tap target
    await expectTarget(control, label);
  }
});

// ---------------------------------------------------------------------------
// Preview before add
// ---------------------------------------------------------------------------

test("preview, then add: Add stays disabled until the SAME draft is previewed, then saves it and resets the form", async ({ page }) => {
  await boot(page);
  await expect(addButton(page)).toBeDisabled();
  await expect(panel(page).getByText("Preview first: see what the rule would exclude before saving it.")).toBeVisible();

  await valueInput(page).fill("  New.Person+promo@gmail.com ");
  await panel(page).getByRole("textbox", { name: "Label (optional)", exact: true }).fill("Rachel's consultant");
  await previewButton(page).click();

  const preview = panel(page).locator(".aiu-preview");
  await expect(preview).toContainText("Matches 1 person, 2 devices.");
  await expect(preview).toContainText("Reaches back to 2026-03-02.");
  const allTime = preview.getByRole("row", { name: /All time/ });
  await expect(allTime).toContainText("9,100");
  await expect(allTime).toContainText("78");
  await expect(status(page)).toHaveText("Preview ready: 78 sessions would be excluded.");
  expect((await calls(page, "onPreview"))[0]!.draft).toEqual({
    kind: "email",
    value: "New.Person+promo@gmail.com",
    reasonLabel: "Rachel's consultant",
    note: null,
    appliesFrom: null,
  });
  expect(await calls(page, "onAdd")).toEqual([]);

  await expect(addButton(page)).toBeEnabled();
  await addButton(page).click();
  await expect(status(page)).toHaveText("Rule added. Internal rule added: 78 sessions excluded back to 2026-03-02");
  expect((await calls(page, "onAdd"))[0]!.draft).toMatchObject({ kind: "email", value: "New.Person+promo@gmail.com" });
  await expect(panel(page).locator(".aiu-rule").first()).toContainText("new.person+promo@gmail.com");
  await expect(panel(page).getByRole("heading", { name: "Rules (4)" })).toBeVisible();
  await expect(panel(page).locator(".aiu-run").first()).toContainText("78 sessions excluded back to 2026-03-02");
  // Reset: empty value, no preview, Add disabled again, focus back in the value field.
  await expect(valueInput(page)).toHaveValue("");
  await expect(valueInput(page)).toBeFocused();
  await expect(preview).toHaveCount(0);
  await expect(addButton(page)).toBeDisabled();
});

test("changing the rule after a preview takes Add away until it is previewed again", async ({ page }) => {
  await boot(page);
  await valueInput(page).fill("a.person@gmail.com");
  await previewButton(page).click();
  await expect(addButton(page)).toBeEnabled();
  await valueInput(page).fill("another.person@gmail.com");
  await expect(addButton(page)).toBeDisabled();
  await expect(panel(page).getByText("The rule changed — preview it again.")).toBeVisible();
  await previewButton(page).click();
  await expect(addButton(page)).toBeEnabled();
  // Switching kind changes the draft too, and the field's label follows the kind.
  await panel(page).getByRole("combobox", { name: "What to match" }).selectOption("email_domain");
  await expect(addButton(page)).toBeDisabled();
  await expect(panel(page).getByRole("textbox", { name: "Email domain", exact: true })).toHaveValue("another.person@gmail.com");
});

test("a rule that cannot reach back says so, and offers no date", async ({ page }) => {
  await boot(page);
  await panel(page).getByRole("combobox", { name: "What to match" }).selectOption("network");
  await expect(panel(page).getByLabel("Only from (optional)", { exact: true })).toHaveCount(0);
  await panel(page).getByRole("textbox", { name: "Network (IP range)", exact: true }).fill("198.51.100.0/24");
  await previewButton(page).click();
  await expect(panel(page).locator(".aiu-preview")).toContainText("New visits only.");
  await expect(panel(page).locator(".aiu-preview")).toContainText("IP addresses are never stored");
  await expect(status(page)).toHaveText("Preview ready: this rule applies to new visits only.");
});

test("a duplicate is shown, and cannot be added", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__srv.duplicate = true;
  });
  await valueInput(page).fill("rachel.smith@gmail.com");
  await previewButton(page).click();
  await expect(panel(page).getByText("An active rule already says this — there is nothing to add.")).toBeVisible();
  await expect(addButton(page)).toBeDisabled();
});

test("errors: a failed preview keeps Add disabled; a failed add keeps the draft; an empty value is caught before any call", async ({ page }) => {
  await boot(page);
  await previewButton(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Enter a value to match.");
  await expect(valueInput(page)).toBeFocused();
  await expect(valueInput(page)).toHaveAttribute("aria-invalid", "true");
  expect(await calls(page, "onPreview")).toEqual([]);

  await setMode(page, "previewMode", "reject");
  await valueInput(page).fill("x.person@gmail.com");
  await previewButton(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Preview failed: The database is unavailable — try again.");
  await expect(addButton(page)).toBeDisabled();

  await setMode(page, "previewMode", "resolve");
  await setMode(page, "addMode", "reject");
  await previewButton(page).click();
  await expect(addButton(page)).toBeEnabled();
  await addButton(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("The database is unavailable — try again.");
  await expect(valueInput(page)).toHaveValue("x.person@gmail.com");
  await expect(panel(page).getByRole("heading", { name: "Rules (3)" })).toBeVisible();
});

test("a server action that RESOLVES { error } (production Next hides thrown messages): every control shows the reason", async ({ page }) => {
  await boot(page);
  await valueInput(page).fill("x.person@gmail.com");

  await setMode(page, "previewMode", "error-result");
  await previewButton(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Preview failed: An active rule already says that.");
  await expect(addButton(page)).toBeDisabled();

  await setMode(page, "previewMode", "resolve");
  await setMode(page, "addMode", "error-result");
  await previewButton(page).click();
  await expect(addButton(page)).toBeEnabled();
  await addButton(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("An active rule already says that.");
  await expect(valueInput(page)).toHaveValue("x.person@gmail.com");
  await expect(panel(page).getByRole("status")).not.toContainText("Rule added");

  await setMode(page, "removeMode", "error-result");
  await panel(page).getByRole("button", { name: /^Remove rule: Network/ }).click();
  await panel(page).getByRole("button", { name: "Remove rule", exact: true }).click();
  await expect(panel(page).getByRole("group", { name: "Confirm removal" }).getByRole("alert")).toHaveText("That rule does not exist.");
  await expect(panel(page).getByRole("heading", { name: "Rules (3)" })).toBeVisible();

  await setMode(page, "markMode", "error-result");
  await page.getByRole("button", { name: "Exclude this browser from analytics" }).click();
  await expect(page.locator(".aiu-mark").getByRole("alert")).toHaveText("This browser has no visitor id yet — load a page first.");
  await expect(page.locator(".aiu-mark").getByRole("button", { name: "Exclude this browser from analytics" })).toBeVisible();
});

test("while a preview is in flight the button says so and a second submit is ignored", async ({ page }) => {
  await boot(page);
  await setMode(page, "previewMode", "hold");
  await valueInput(page).fill("slow@gmail.com");
  await previewButton(page).click();
  await expect(previewButton(page)).toHaveText("Previewing…");
  await expect(previewButton(page)).toHaveAttribute("aria-busy", "true");
  await valueInput(page).press("Enter");
  expect(await calls(page, "onPreview")).toHaveLength(1);
  await page.evaluate(() => window.__srv.release(true));
  await expect(addButton(page)).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

test("keyboard only: type, Enter to preview, Tab to Add, Enter to save; Remove → confirm → Escape → confirm → Enter", async ({ page }) => {
  await boot(page);
  await panel(page).getByRole("combobox", { name: "What to match" }).focus();
  await page.keyboard.press("Tab");
  await expect(valueInput(page)).toBeFocused();
  await page.keyboard.type("keyboard.person@gmail.com");
  await page.keyboard.press("Enter");
  await expect(panel(page).locator(".aiu-preview")).toBeVisible();
  await tabTo(page, addButton(page));
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Rule added.");
  await expect(valueInput(page)).toBeFocused();
  expect(await calls(page, "onAdd")).toHaveLength(1);

  const remove = panel(page).getByRole("button", { name: /^Remove rule: Email domain riddlergo\.com/ });
  await remove.focus();
  await page.keyboard.press("Enter");
  const confirm = panel(page).getByRole("button", { name: "Remove rule", exact: true });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(await calls(page, "onRemove")).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByText("riddlergo.com", { exact: true })).toHaveCount(0);
  expect(await calls(page, "onRemove")).toEqual([{ fn: "onRemove", ruleId: "r2" }]);
  await expect(panel(page).getByRole("heading", { name: /^Rules \(/ })).toBeFocused();
  await expect(status(page)).toHaveText("Rule removed. Internal rule removed: 12 sessions counted again");
});

test("a failed removal keeps the confirm open with the reason; Keep backs out", async ({ page }) => {
  await boot(page);
  await setMode(page, "removeMode", "reject");
  await panel(page).getByRole("button", { name: /^Remove rule: Network/ }).click();
  await panel(page).getByRole("button", { name: "Remove rule", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("The database is unavailable — try again.");
  await panel(page).getByRole("button", { name: "Keep" }).click();
  await expect(panel(page).getByRole("button", { name: /^Remove rule: Network/ })).toBeFocused();
  await expect(panel(page).getByRole("heading", { name: "Rules (3)" })).toBeVisible();
});

// ---------------------------------------------------------------------------
// The analytics role
// ---------------------------------------------------------------------------

test("maskEmails + view only (the analytics role): no form, no Remove, and no address anywhere on the page", async ({ page }) => {
  await boot(page, { canEdit: false, maskEmails: true });
  await expect(panel(page).getByText("View only. Staff can add and remove rules.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Remove/ })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Add rule" })).toHaveCount(0);
  await expect(panel(page).locator("form")).toHaveCount(0);
  await expect(panel(page)).toContainText("r***@gmail.com");
  const text = await page.locator("body").innerText();
  for (const address of ["rachel.smith@gmail.com", "dallin@adminigloo.com", "sam@riddlergo.com"]) expect(text).not.toContain(address);
  expect(text).toMatch(/d\*\*\*@adminigloo\.com/);
});

// ---------------------------------------------------------------------------
// Toggle, note, mark, unfiltered
// ---------------------------------------------------------------------------

test("include-internal: a real link drawn as a switch; Space flips it; on shows the banner and the note says 'Including'", async ({ page }) => {
  await boot(page);
  const toggle = page.getByRole("switch", { name: "Include internal traffic" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveAttribute("href", "/admin/analytics/audience?include_internal=1");
  await expect(page.locator(".aiu-note")).toHaveText("Excluded: 312 sessions (automation 12, staff 200, named person 100)");
  await expect(page.locator(".aiu-banner")).toHaveCount(0);

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".aiu-banner")).toHaveText("Internal traffic is included. These numbers count staff, test accounts and automation.");
  await expect(page.locator(".aiu-note")).toHaveText("Including 312 internal sessions (automation 12, staff 200, named person 100)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await calls(page, "navigate")).map((c) => c.href)).toEqual([
    "/admin/analytics/audience?include_internal=1",
    "/admin/analytics/audience",
  ]);
});

test("Mark this browser: busy, then done — announced; a failure is shown and the button comes back", async ({ page }) => {
  await boot(page);
  await setMode(page, "markMode", "reject");
  const button = page.getByRole("button", { name: "Exclude this browser from analytics" });
  await button.click();
  await expect(page.locator(".aiu-mark").getByRole("alert")).toHaveText("The database is unavailable — try again.");
  await setMode(page, "markMode", "hold");
  await button.click();
  await expect(page.locator(".aiu-mark").getByRole("button")).toHaveText("Marking…");
  await page.evaluate(() => window.__srv.release(true));
  await expect(page.locator(".aiu-mark")).toContainText("This browser is excluded from analytics.");
  await expect(page.locator(".aiu-mark").getByRole("status")).toHaveText("This browser is now excluded from analytics.");
  await expect(page.locator(".aiu-mark").getByRole("button")).toHaveCount(0);
});

test("the unfiltered-sources note names every outside number", async ({ page }) => {
  await boot(page);
  const note = page.getByRole("complementary", { name: "Not filtered" });
  for (const name of ["Google Search Console", "AI answer engines (AEO)", "Stripe and Clerk dashboards", "Digests already sent", "Ad pixels (Meta, Google Ads, Floodlight)"]) {
    await expect(note).toContainText(name);
  }
});

// ---------------------------------------------------------------------------
// Layout and theming
// ---------------------------------------------------------------------------

test("phone width: nothing makes the PAGE scroll sideways, even with a preview table showing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await valueInput(page).fill("phone.person@gmail.com");
  await previewButton(page).click();
  await expect(panel(page).locator(".aiu-preview table")).toBeVisible();
  await panel(page).getByRole("button", { name: /^Remove rule: Email domain/ }).click();
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(widths.page, "the page scrolls sideways").toBe(widths.viewport);
});

test("a host's token override wins at any specificity (the defaults sit under :where)", async ({ page }) => {
  await boot(page, {}, ".aiu-root { --aiu-accent: #5b21b6; --aiu-accent-strong: #4c1d95; }");
  await valueInput(page).fill("x@gmail.com");
  const bg = await previewButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(91, 33, 182)");
});

test("theme='dark' pins dark tokens inside a light host; auto follows the OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await boot(page, { theme: "dark" });
  const surface = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(surface).toBe("rgb(21, 27, 33)");
  expect(await axeViolations(page, ".aiu-root")).toEqual([]);
});

test("forced colours (Windows High Contrast): the switch keeps a visible track and knob, on and off", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await boot(page);
  const read = () =>
    page.evaluate(() => {
      const track = document.querySelector(".aiu-switch-track") as HTMLElement;
      const knob = document.querySelector(".aiu-switch-knob") as HTMLElement;
      return {
        trackBorder: getComputedStyle(track).borderTopColor,
        trackBg: getComputedStyle(track).backgroundColor,
        knob: getComputedStyle(knob).backgroundColor,
        adjust: getComputedStyle(knob).forcedColorAdjust,
      };
    });
  const off = await read();
  expect(off.adjust).toBe("none");
  expect(off.knob).not.toBe(off.trackBg);
  expect(off.trackBorder).not.toBe("rgba(0, 0, 0, 0)");
  await page.getByRole("switch").click();
  const on = await read();
  expect(on.knob).not.toBe(on.trackBg);
  expect(on.trackBg).not.toBe(off.trackBg);
});
