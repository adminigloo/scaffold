import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * @adminigloo/feedback's Kanban board (`./board`) in a real browser, inside
 * the admin shell where 0.8.0 failed: a sidebar, a `<main overflow-y:auto>`
 * the DOCUMENT scrolls past (so a sticky bulk bar sat under the tallest
 * column, below the fold), a floating feedback button bottom-right, and an
 * in-memory fake server behind onMove / onMoveMany that the test can make
 * resolve, reject, hold, or partly fail — and that re-renders the board with
 * fresh tickets after a landed move, the way router.refresh / refetch does.
 *
 * SELF-CONTAINED like booking-widget.spec.ts: the board is bundled here, in
 * beforeAll, from the package SOURCE (packages/feedback/src/board.tsx) with
 * esbuild, react pinned to e2e's single copy, as a DEVELOPMENT build under
 * StrictMode (every buyer's `next dev`). Every test also fails on an uncaught
 * page error or any console error/warning (React's dev warnings included).
 *
 * Negative control: AIB_BOARD_SRC=<path to another board.tsx> bundles that
 * file instead (copy board-tokens.ts next to it if it imports one). Against
 * 0.8.0's board (git show 9d117d3:packages/feedback/src/board.tsx) the
 * stale-override, bar-on-screen, bar-painted, 44px and zero-specificity tests
 * fail, as they must. Against the 0.9.0 board as it was BEFORE its review fix
 * pass, every test in the fix-pass section at the bottom (27) fails at the
 * assertion it is named for, as do the two axe tests; the other 22 pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const boardEntry = (
  process.env.AIB_BOARD_SRC
    ? resolve(process.env.AIB_BOARD_SRC)
    : join(e2eRoot, "..", "packages", "feedback", "src", "board.tsx")
).replace(/\\/g, "/");
const ORIGIN = "https://admin.test";
const BOARD_URL = `${ORIGIN}/admin/feedback/board`;

/**
 * The host app: an admin shell around the real FeedbackBoard and TicketPanel,
 * plus the fake server (window.__srv). Plain JS/JSX inside a template string —
 * no backticks, no template holes except the two marked.
 */
const HOST_APP = `
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackBoard, TicketPanel } from ${JSON.stringify(boardEntry)};

const cfg = window.__cfg;
const clone = (rows) => rows.map((row) => Object.assign({}, row));
const errorText = (error) => (error && error.message) || String(error);

const srv = {
  tickets: clone(cfg.tickets),
  calls: [],
  // resolve | reject | hold (held moves wait for release(true|false))
  mode: "resolve",
  // ids onMoveMany refuses: it lands the rest, refreshes, then throws — or,
  // with partialAs "result", resolves { failed: [those ids] } (0.9.0's contract)
  failIds: [],
  partialAs: "throw",
  sendFails: false,
  // true: onSend waits for releaseSend()
  sendHold: false,
  sendHeld: [],
  held: [],
  ready: false,
  // true: a refetch is queued (a snapshot of the server as it was then) and
  // only reaches the board on flush() — a slow router.refresh.
  deferRefresh: false,
  queued: [],
  // React commits of a new tickets prop (the App's effect counts them)
  commits: 0,
  render() {},
  refresh() {
    const rows = clone(srv.tickets);
    if (srv.deferRefresh) srv.queued.push(rows);
    else srv.render(rows);
  },
  flush() {
    const rows = srv.queued.shift();
    if (!rows) throw new Error("no refresh is queued");
    srv.render(rows);
  },
  releaseSend() {
    const next = srv.sendHeld.shift();
    if (!next) throw new Error("no send is held");
    next();
  },
  release(ok) {
    const next = srv.held.shift();
    if (!next) throw new Error("nothing is held");
    if (ok === false) next.reject(new Error("Server said no"));
    else next.resolve();
  },
  apply(ids, status) {
    srv.tickets = srv.tickets.map((t) =>
      ids.indexOf(t.id) === -1 ? t : Object.assign({}, t, { status: status, statusChangedAt: new Date().toISOString() }),
    );
  },
  // Someone else (another admin, an automation) changed a ticket on the server.
  setStatus(id, status) {
    srv.apply([id], status);
    srv.refresh();
  },
};
window.__srv = srv;

function gate() {
  if (srv.mode === "reject") return Promise.reject(new Error("Server said no"));
  if (srv.mode === "hold") return new Promise((resolve, reject) => { srv.held.push({ resolve, reject }); });
  return Promise.resolve();
}

// The testbed's shape: mutate, refetch, THEN resolve.
async function onMove(id, to) {
  srv.calls.push({ fn: "onMove", ids: [id], to: to });
  await gate();
  srv.apply([id], to);
  srv.refresh();
}

async function onMoveMany(ids, to) {
  srv.calls.push({ fn: "onMoveMany", ids: ids.slice(), to: to });
  await gate();
  const landed = ids.filter((id) => srv.failIds.indexOf(id) === -1);
  srv.apply(landed, to);
  srv.refresh();
  if (landed.length === ids.length) return;
  if (srv.partialAs === "result") return { failed: ids.filter((id) => landed.indexOf(id) === -1) };
  throw new Error("Refused " + (ids.length - landed.length) + " of " + ids.length);
}

function App() {
  const [tickets, setTickets] = useState(() => clone(srv.tickets));
  const [messages, setMessages] = useState(() => JSON.parse(JSON.stringify(cfg.messages || {})));
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    srv.render = (rows) => setTickets(rows);
    srv.ready = true;
  }, []);
  useEffect(() => {
    srv.commits += 1;
  }, [tickets]);
  const open = openId ? tickets.find((t) => t.id === openId) || null : null;
  return (
    <div className="shell">
      <nav className="side" aria-label="Admin">
        <a href="/admin/feedback">Feedback tickets</a>
        <a href="/admin/feedback/board" aria-current="page">Board</a>
        <a href="/admin/organization">Organization</a>
        <a href="/admin/hosts">Hosts</a>
        <a href="/admin/account">Enterprise account</a>
      </nav>
      <main className="main">
        <header className="head">
          <h1>Feedback board</h1>
          <input className="search" aria-label="Search tickets" placeholder="Search tickets" />
        </header>
        <FeedbackBoard
          statuses={cfg.statuses}
          tickets={tickets}
          onMove={onMove}
          onMoveMany={cfg.bulk ? onMoveMany : undefined}
          onOpen={(ticket) => {
            srv.calls.push({ fn: "onOpen", ids: [ticket.id] });
            if (cfg.panel) setOpenId(ticket.id);
          }}
          ticketHref={cfg.href ? (ticket) => ${JSON.stringify(ORIGIN)} + "/admin/feedback/" + ticket.ticketNumber : undefined}
          onMoveError={(error, ids, to) => srv.calls.push({ fn: "onMoveError", ids: ids.slice(), to: to, message: errorText(error) })}
          theme={cfg.theme}
        />
      </main>
      <button type="button" className="fab">Feedback</button>
      {open ? (
        <TicketPanel
          ticket={open}
          messages={messages[open.id] || []}
          statuses={cfg.statuses}
          detail={cfg.detail || null}
          currentUser="Dallin"
          onClose={() => {
            srv.calls.push({ fn: "onClose" });
            setOpenId(null);
          }}
          onSend={async (body) => {
            srv.calls.push({ fn: "onSend", body: body });
            if (srv.sendHold) await new Promise((resolve) => srv.sendHeld.push(resolve));
            if (srv.sendFails) throw new Error("Send failed");
            const id = open.id;
            const row = { id: "m" + Date.now(), senderType: "staff", senderName: "Dallin", body: body, createdAt: new Date().toISOString() };
            setMessages((prev) => Object.assign({}, prev, { [id]: (prev[id] || []).concat([row]) }));
          }}
          onAssign={async (assignee) => { srv.calls.push({ fn: "onAssign", assignee: assignee }); }}
          onMove={(to) => onMove(open.id, to)}
          onArchive={async () => { srv.calls.push({ fn: "onArchive" }); }}
          onError={(error, action) => srv.calls.push({ fn: "onError", action: action, message: errorText(error) })}
          theme={cfg.theme}
        />
      ) : null}
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
.side { width: 240px; flex: none; background: #0b1220; padding: 16px 12px; }
.side a { display: block; color: #e5e7eb; padding: 10px 12px; text-decoration: none; border-radius: 8px; }
.main { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; }
.head { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.head h1 { font-size: 20px; margin: 0; }
.search { margin-left: auto; padding: 10px 12px; border: 1px solid #9ca3af; border-radius: 8px; min-width: 260px; }
.fab { position: fixed; right: 16px; bottom: 16px; z-index: 50; height: 44px; padding: 0 18px; border: 0;
  border-radius: 999px; background: #111827; color: #ffffff; font: 600 14px system-ui, sans-serif; }
`;

const SHOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dde3ea"/>' +
  '<rect x="40" y="40" width="200" height="60" fill="none" stroke="#e11d48" stroke-width="6"/></svg>';

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

interface Ticket {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category: string | null;
  status: string;
  assignee: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  hasUnreadReporterReply: boolean;
  pagePathname: string | null;
  screenshotUrl: string | null;
  annotatedScreenshotUrl: string | null;
  createdAt: string;
  statusChangedAt: string | null;
  archivedAt: string | null;
}

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const shot = (n: number) => `${ORIGIN}/shots/${n}.svg`;
const num = (n: number) => `FB-${String(n).padStart(5, "0")}`;

function ticket(n: number, title: string, status: string, extra: Partial<Ticket> = {}): Ticket {
  return {
    id: `t${n}`,
    ticketNumber: num(n),
    title,
    priority: "medium",
    category: null,
    status,
    assignee: null,
    reporterName: null,
    reporterEmail: null,
    hasUnreadReporterReply: false,
    pagePathname: null,
    screenshotUrl: null,
    annotatedScreenshotUrl: null,
    createdAt: ago(2),
    statusChangedAt: null,
    archivedAt: null,
    ...extra,
  };
}

const STATUSES = [
  { key: "open", label: "New", color: "#1f6fff", sortOrder: 10, agingWarnHours: 24, agingStaleHours: 72 },
  { key: "in_progress", label: "In progress", color: "#ff8a00", sortOrder: 20, wipLimit: 3 },
  { key: "review", label: "In review", color: "#8b5cf6", sortOrder: 30, wipLimit: 1 },
  { key: "resolved", label: "Done", color: "#12b23b", sortOrder: 40, isTerminal: true },
];

const T1_TITLE = "Checkout button does nothing on Safari";

/** Every visual state the board has: chips, aging, WIP full/over, archived, unread, screenshots. */
const TICKETS: Ticket[] = [
  ticket(1, T1_TITLE, "open", {
    priority: "critical",
    assignee: "Dallin",
    reporterName: "Ada Lovelace",
    pagePathname: "/checkout",
    annotatedScreenshotUrl: shot(1),
    screenshotUrl: shot(101),
    hasUnreadReporterReply: true,
    createdAt: ago(120),
    statusChangedAt: ago(100),
  }),
  ticket(2, "Invoice PDF cuts off the total", "open", {
    priority: "high",
    reporterEmail: "grace@example.com",
    createdAt: ago(30),
    statusChangedAt: ago(30),
  }),
  ticket(3, "Typo on the pricing page", "open", { priority: "low" }),
  // Enough filler that the New column runs well past the bottom of the window.
  ...Array.from({ length: 16 }, (_, i) => ticket(4 + i, `Filler request ${4 + i}`, "open")),
  ticket(21, "Dark mode toggle flickers", "in_progress", { assignee: "Sam" }),
  ticket(22, "Search is slow past 10k tickets", "in_progress", { priority: "high", screenshotUrl: shot(22) }),
  ticket(23, "CSV export drops the dates", "review"),
  ticket(24, "Login loops after SSO", "review", { priority: "critical" }),
  ticket(25, "Old logo in the receipt email", "resolved", {
    priority: "low",
    archivedAt: ago(5),
    annotatedScreenshotUrl: shot(25),
    hasUnreadReporterReply: true,
    assignee: "Dallin",
    reporterName: "Linus",
  }),
  ticket(26, "Footer link 404s", "resolved", { priority: "critical" }),
];

const ORPHAN = ticket(99, "Imported from the old helpdesk", "triage", { priority: "high", reporterName: "Import" });

const DETAIL = {
  description: "Clicked Pay, nothing happened.\nTried twice, then gave up.",
  context: {
    browser: "Safari 18.1",
    os: "macOS 15",
    viewport: { width: 1440, height: 900 },
    url: "https://shop.example.com/checkout",
    pathname: "/checkout",
    clickTrail: [
      { type: "click", target: "button#pay", value: null, timestamp: 1 },
      { type: "input", target: "input#email", value: "a***@example.com", timestamp: 2 },
    ],
  },
  errors: [{ type: "TypeError", message: "Cannot read properties of undefined (reading 'total')" }],
};

const MESSAGES = {
  t1: [
    { id: "m1", senderType: "reporter", senderName: "Ada Lovelace", body: "It still fails on my iPad.", createdAt: ago(20) },
    { id: "m2", senderType: "staff", senderName: "Dallin", body: "Thanks — reproducing now.", createdAt: ago(19) },
    { id: "m3", senderType: "system", senderName: "Dallin", body: "Status changed to In progress", createdAt: ago(18) },
  ],
};

interface Cfg {
  statuses: typeof STATUSES;
  tickets: Ticket[];
  bulk?: boolean;
  panel?: boolean;
  href?: boolean;
  theme?: "auto" | "light" | "dark";
  detail?: typeof DETAIL;
  messages?: typeof MESSAGES;
}

interface Call {
  fn: string;
  ids?: string[];
  to?: string;
  message?: string;
  action?: string;
  body?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __srv: any;
    __cfg: Cfg;
    __altPrevented: boolean[];
    __trail: (string | null)[];
    __launcherClicks: number;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "board-host.tsx", loader: "tsx" },
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

test.use({ viewport: { width: 1600, height: 900 }, locale: "en-US" });

// Every test fails on an uncaught error or a console error/warning — React's
// dev warnings, unhandled rejections from a callback the board forgot to catch.
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
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feedback board · Admin</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style id="host-css">${HOST_CSS}</style>` +
    (hostCss ? `<style id="host-tokens">${hostCss}</style>` : "") +
    `</head><body><div id="root"></div><script>window.__cfg = ${data};</script>` +
    '<script src="/bundle.js"></script></body></html>'
  );
}

async function boot(page: Page, cfg: Partial<Cfg> = {}, hostCss = ""): Promise<void> {
  const full: Cfg = { statuses: STATUSES, tickets: TICKETS, ...cfg };
  await page.context().route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname.startsWith("/shots/")) return route.fulfill({ contentType: "image/svg+xml", body: SHOT_SVG });
    if (url.pathname === "/admin/feedback/board") {
      return route.fulfill({ contentType: "text/html", body: shellHtml(full, hostCss) });
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Ticket</title><h1>Ticket page</h1></html>' });
  });
  await page.goto(BOARD_URL);
  await page.waitForFunction(() => window.__srv?.ready === true);
  await expect(page.locator(".aib-card").first()).toBeVisible();
}

const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** A column, by its header label (class-based so the 0.8.0 negative control can find it too). */
const col = (page: Page, label: string): Locator =>
  page.locator(".aib-col").filter({ has: page.locator(".aib-col-title", { hasText: exact(label) }) });

/** A card, by ticket number — anywhere, or inside `scope`. */
const card = (page: Page, n: number, scope?: Locator): Locator =>
  (scope ?? page).locator(".aib-card").filter({ has: page.locator(".aib-num", { hasText: exact(num(n)) }) });

/** The card's keyboard handle: its title button / link. */
const handle = (page: Page, n: number): Locator => page.locator(`[data-aib-open="t${n}"]`);

const live = (page: Page): Locator => page.locator('.aib-root > [role="status"]');
const bar = (page: Page): Locator => page.locator(".aib-bulkbar");

async function calls(page: Page, fn?: string): Promise<Call[]> {
  const all: Call[] = await page.evaluate(() => JSON.parse(JSON.stringify(window.__srv.calls)));
  return fn ? all.filter((call) => call.fn === fn) : all;
}

const serverStatus = (page: Page, id: string) =>
  page.evaluate((ticketId) => window.__srv.tickets.find((t: Ticket) => t.id === ticketId)?.status, id);

const setMode = (page: Page, mode: "resolve" | "reject" | "hold") =>
  page.evaluate((m) => {
    window.__srv.mode = m;
  }, mode);

/** Card numbers in a column, top to bottom. */
const numbersIn = (page: Page, label: string) => col(page, label).locator(".aib-num").allTextContents();

async function expectInViewport(page: Page, target: Locator, what: string): Promise<void> {
  const box = await target.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `${what} has no box`).not.toBeNull();
  const scroll = await page.evaluate(() => window.scrollY);
  const where = `${what} at y=${Math.round(box!.y)}..${Math.round(box!.y + box!.height)} (window ${viewport.height}px tall, scrolled ${scroll}px)`;
  expect(box!.y, where).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, where).toBeLessThanOrEqual(viewport.height);
  expect(box!.x, where).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, where).toBeLessThanOrEqual(viewport.width);
}

/** The element a real click at (x, y) would hit is `target` (or inside it). */
async function hits(target: Locator, x: number, y: number): Promise<boolean> {
  return target.evaluate((el, [px, py]) => {
    const top = document.elementFromPoint(px!, py!);
    return top !== null && (top === el || el.contains(top));
  }, [x, y]);
}

/**
 * A touch target: at least `min`×`min`, and a click at its centre lands on it
 * (not on a neighbour, the floating button, or the bar). With `core`, every
 * point of the central core×core square must land on it too — the part a
 * finger actually aims at.
 */
async function expectTarget(target: Locator, what: string, min = 44, core = 0): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  const box = await target.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(min);
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  expect(await hits(target, cx, cy), `${what}: a click at its centre lands elsewhere`).toBe(true);
  if (core > 0) {
    const misses: string[] = [];
    for (const dx of [-1, -0.5, 0, 0.5, 1]) {
      for (const dy of [-1, -0.5, 0, 0.5, 1]) {
        const x = cx + (dx * (core - 1)) / 2;
        const y = cy + (dy * (core - 1)) / 2;
        if (!(await hits(target, x, y))) misses.push(`(${dx},${dy})`);
      }
    }
    expect(misses, `${what}: points of its central ${core}px square land elsewhere`).toEqual([]);
  }
}

/** The board's package stylesheet: React 19's hoisted <style data-href>, or React 18's injected #aib-styles. */
const PACKAGE_STYLE = 'style[data-href="aib-styles"], style#aib-styles';

async function axeViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include(include)
    .analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.replace(/\s+/g, " ")}`),
  }));
}

const bg = (target: Locator) => target.evaluate((el) => getComputedStyle(el).backgroundColor);

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

test("dragging a card to another column lands it there and calls onMove", async ({ page }) => {
  await boot(page);
  await card(page, 2).dragTo(col(page, "In progress"));

  await expect(card(page, 2, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 2, col(page, "New"))).toHaveCount(0);
  expect(await calls(page, "onMove")).toEqual([{ fn: "onMove", ids: ["t2"], to: "in_progress" }]);
  // Landed and refreshed: the server agrees, the card is no longer busy.
  expect(await serverStatus(page, "t2")).toBe("in_progress");
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
  await expect(live(page)).toHaveText("FB-00002 moved to In progress.");
  expect(await calls(page, "onMoveError")).toEqual([]);
});

test("a refused move shows optimistically, then puts the card back where it was and calls onMoveError", async ({ page }) => {
  await boot(page);
  await setMode(page, "hold");
  await card(page, 2).dragTo(col(page, "In progress"));

  // Optimistic: already in the target column, marked busy while the server thinks.
  await expect(card(page, 2, col(page, "In progress"))).toHaveClass(/aib-busy/);

  await page.evaluate(() => window.__srv.release(false));
  await expect(card(page, 2, col(page, "New"))).toBeVisible();
  await expect(card(page, 2, col(page, "In progress"))).toHaveCount(0);
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
  // Back in its own slot, not appended at the bottom.
  expect((await numbersIn(page, "New")).slice(0, 3)).toEqual(["FB-00001", "FB-00002", "FB-00003"]);
  expect(await calls(page, "onMoveError")).toEqual([
    { fn: "onMoveError", ids: ["t2"], to: "in_progress", message: "Server said no" },
  ]);
  await expect(live(page)).toHaveText("FB-00002 could not be moved.");

  // Not left stuck: the same card moves normally afterwards.
  await setMode(page, "resolve");
  await card(page, 2).dragTo(col(page, "In progress"));
  await expect(card(page, 2, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
  expect(await calls(page, "onMove")).toHaveLength(2);
});

test("after a landed move, later server-side changes to that ticket are SHOWN (0.8.0 kept its own status forever)", async ({
  page,
}) => {
  await boot(page);
  await card(page, 2).dragTo(col(page, "In progress"));
  await expect(card(page, 2, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);

  // Someone else finishes it.
  await page.evaluate(() => window.__srv.setStatus("t2", "resolved"));
  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 2, col(page, "In progress"))).toHaveCount(0);

  // And someone reopens it — back to the very status the board's move started
  // from, the case a "drop the override once the server leaves base" rule must
  // not resurrect.
  await page.evaluate(() => window.__srv.setStatus("t2", "open"));
  await expect(card(page, 2, col(page, "New"))).toBeVisible();
  await expect(card(page, 2, col(page, "Done"))).toHaveCount(0);
});

test("a server change that arrives while a move is in flight wins over the optimistic card", async ({ page }) => {
  await boot(page);
  await setMode(page, "hold");
  await card(page, 2).dragTo(col(page, "In progress"));
  await expect(card(page, 2, col(page, "In progress"))).toBeVisible();

  // Another admin moves it to review before our server call answers.
  await page.evaluate(() => window.__srv.setStatus("t2", "review"));
  await expect(card(page, 2, col(page, "In review"))).toBeVisible();
  await expect(card(page, 2, col(page, "In progress"))).toHaveCount(0);

  // Our move then lands (last write wins on the server) — and the board shows that.
  await page.evaluate(() => window.__srv.release(true));
  await expect(card(page, 2, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
});

// ---------------------------------------------------------------------------
// Bulk selection
// ---------------------------------------------------------------------------

test("bulk: ticking two cards brings up an on-screen, painted bar with 44px targets; Move to + Apply moves both", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await boot(page, { bulk: true });
  // The shell that broke 0.8.0: the document, not <main>, scrolls, and the
  // board runs far past the bottom of the window.
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow, "precondition: the board must be much taller than the window").toBeGreaterThan(600);

  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await page.getByRole("checkbox", { name: "Select FB-00003" }).check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("2 selected");

  // In the viewport — at the top of the page, and scrolled halfway down.
  await expectInViewport(page, bar(page), "bulk bar (page at top)");
  await page.evaluate(() => window.scrollTo(0, 700));
  await expectInViewport(page, bar(page), "bulk bar (page scrolled)");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Painted: 0.8.0's tokens lived on .aib-board, the bar's sibling, so its
  // var(--aib-surface) resolved to nothing and it painted transparent.
  const barBg = await bg(bar(page));
  expect(barBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(barBg).toBe("rgb(255, 255, 255)");

  // Not under the host's floating button, and the button is still clickable.
  const fab = page.locator(".fab");
  const [barBox, fabBox] = [await bar(page).boundingBox(), await fab.boundingBox()];
  const overlap =
    barBox!.x < fabBox!.x + fabBox!.width &&
    fabBox!.x < barBox!.x + barBox!.width &&
    barBox!.y < fabBox!.y + fabBox!.height &&
    fabBox!.y < barBox!.y + barBox!.height;
  expect(overlap, "bulk bar overlaps the floating feedback button").toBe(false);

  // Every bar control and every checkbox is a 44px target a click actually reaches.
  const select = bar(page).getByRole("combobox", { name: "Move selection to" });
  const apply = bar(page).getByRole("button", { name: "Apply" });
  const clear = bar(page).getByRole("button", { name: "Clear" });
  for (const [control, what] of [
    [select, "Move to select"],
    [apply, "Apply"],
    [clear, "Clear"],
  ] as const) {
    await expectTarget(control, what);
  }
  const checks = page.locator(".aib-check");
  const count = await checks.count();
  expect(count, "a checkbox per card plus a select-all per column").toBe(TICKETS.length + STATUSES.length);
  for (let i = 0; i < count; i += 1) {
    const label = (await checks.nth(i).getAttribute("aria-label")) ?? `checkbox ${i}`;
    await expectTarget(checks.nth(i), label, 44, 24);
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  await select.selectOption({ label: "Done" });
  await apply.click();
  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 3, col(page, "Done"))).toBeVisible();
  const many = await calls(page, "onMoveMany");
  expect(many).toHaveLength(1);
  expect(many[0]!.to).toBe("resolved");
  expect([...many[0]!.ids!].sort()).toEqual(["t2", "t3"]);
  expect(await calls(page, "onMove")).toEqual([]);
  // Done: selection cleared, bar gone, the move announced.
  await expect(bar(page)).toHaveCount(0);
  await expect(live(page)).toHaveText("2 tickets moved to Done.");
});

test("bulk: dragging a ticked card carries the whole selection", async ({ page }) => {
  await boot(page, { bulk: true });
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await page.getByRole("checkbox", { name: "Select FB-00003" }).check();
  await card(page, 2).dragTo(col(page, "Done"));

  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 3, col(page, "Done"))).toBeVisible();
  const many = await calls(page, "onMoveMany");
  expect(many).toHaveLength(1);
  expect([...many[0]!.ids!].sort()).toEqual(["t2", "t3"]);
  expect(many[0]!.to).toBe("resolved");
});

test("bulk: a partial failure keeps the landed card moved, puts the refused one back, and calls onMoveError", async ({
  page,
}) => {
  await boot(page, { bulk: true });
  await page.evaluate(() => {
    window.__srv.failIds = ["t3"];
  });
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await page.getByRole("checkbox", { name: "Select FB-00003" }).check();
  await bar(page).getByRole("combobox", { name: "Move selection to" }).selectOption({ label: "Done" });
  await bar(page).getByRole("button", { name: "Apply" }).click();

  // The server landed t2 and refused t3: the board shows exactly that.
  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 3, col(page, "New"))).toBeVisible();
  await expect(card(page, 3, col(page, "Done"))).toHaveCount(0);
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
  await expect(card(page, 3)).not.toHaveClass(/aib-busy/);
  expect(await serverStatus(page, "t2")).toBe("resolved");
  expect(await serverStatus(page, "t3")).toBe("open");
  const errors = await calls(page, "onMoveError");
  expect(errors).toHaveLength(1);
  expect([...errors[0]!.ids!].sort()).toEqual(["t2", "t3"]);
  expect(errors[0]!.to).toBe("resolved");
  expect(errors[0]!.message).toBe("Refused 1 of 2");
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

test("keyboard: Tab reaches a card title, Enter opens it, Alt+Arrow moves it a column with focus kept and announced", async ({
  page,
}) => {
  await boot(page);
  await page.getByRole("textbox", { name: "Search tickets" }).focus();
  await page.keyboard.press("Tab");
  await expect(handle(page, 1)).toBeFocused();

  await page.keyboard.press("Enter");
  expect(await calls(page, "onOpen")).toEqual([{ fn: "onOpen", ids: ["t1"] }]);

  await page.keyboard.press("Alt+ArrowRight");
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(handle(page, 1)).toBeFocused();
  await expect(live(page)).toHaveText("FB-00001 moved to In progress.");
  expect(await calls(page, "onMove")).toEqual([{ fn: "onMove", ids: ["t1"], to: "in_progress" }]);

  // And again, both ways — focus rides along every time.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(card(page, 1, col(page, "In review"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(handle(page, 1)).toBeFocused();
  await expect(live(page)).toHaveText("FB-00001 moved to In review.");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(handle(page, 1)).toBeFocused();
  await expect(live(page)).toHaveText("FB-00001 moved to In progress.");
  expect((await calls(page, "onMove")).map((c) => c.to)).toEqual(["in_progress", "review", "in_progress"]);
});

test("keyboard: a refused Alt+Arrow move puts the card back AND keeps focus on it", async ({ page }) => {
  await boot(page);
  await setMode(page, "reject");
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowRight");

  await expect(live(page)).toHaveText("FB-00001 could not be moved.");
  await expect(card(page, 1, col(page, "New"))).toBeVisible();
  await expect(card(page, 1, col(page, "In progress"))).toHaveCount(0);
  expect(await calls(page, "onMoveError")).toEqual([
    { fn: "onMoveError", ids: ["t1"], to: "in_progress", message: "Server said no" },
  ]);
  // The card jumped back a column, which remounts its title — a keyboard user
  // must not be dropped onto <body>.
  await expect(handle(page, 1)).toBeFocused();
});

test("keyboard: Alt+Arrow with no column that way is still the board's, not the browser's Back/Forward", async ({
  page,
}) => {
  // On Windows and Linux, Alt+← is Back: an unhandled one on a first-column
  // card navigates away from the board. Headless Chromium has no Back
  // accelerator, so what this checks is the precondition for one firing:
  // whether the board consumed the key (defaultPrevented).
  await boot(page, { tickets: [...TICKETS, ORPHAN] });
  await page.evaluate(() => {
    window.__altPrevented = [];
    window.addEventListener("keydown", (event) => {
      if (event.altKey && event.key.startsWith("Arrow")) window.__altPrevented.push(event.defaultPrevented);
    });
  });
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowLeft"); // first column: nowhere to go
  await handle(page, 26).focus();
  await page.keyboard.press("Alt+ArrowRight"); // last column: nowhere to go
  await handle(page, 99).focus();
  await page.keyboard.press("Alt+ArrowRight"); // unrecognised status: never moved by key
  expect(await page.evaluate(() => window.__altPrevented)).toEqual([true, true, true]);
  expect(await calls(page, "onMove")).toEqual([]);
  await expect(card(page, 1, col(page, "New"))).toBeVisible();
  await expect(card(page, 26, col(page, "Done"))).toBeVisible();
  await expect(card(page, 99, col(page, "Unrecognised status"))).toBeVisible();
});

// ---------------------------------------------------------------------------
// ticketHref
// ---------------------------------------------------------------------------

test("ticketHref: the title is a real link; a plain click calls onOpen, a ctrl/meta-click is left to the browser", async ({
  page,
}) => {
  await boot(page, { href: true });
  const link = page.getByRole("link", { name: T1_TITLE, exact: true });
  await expect(link).toHaveAttribute("href", `${ORIGIN}/admin/feedback/FB-00001`);
  await expect(link).toHaveAttribute("data-aib-open", "t1");

  await link.click();
  expect(await calls(page, "onOpen")).toEqual([{ fn: "onOpen", ids: ["t1"] }]);
  expect(page.url()).toBe(BOARD_URL);

  // Ctrl+click: a new tab with the ticket's URL, and no onOpen.
  const opened = page.context().waitForEvent("page", { timeout: 5000 });
  await link.click({ modifiers: ["Control"] });
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe(`${ORIGIN}/admin/feedback/FB-00001`);
  await tab.close();
  expect(await calls(page, "onOpen")).toHaveLength(1);

  // Meta+click (⌘ on a Mac): also not the board's.
  await link.click({ modifiers: ["Meta"] });
  await page.waitForTimeout(300);
  if (page.url() === BOARD_URL) {
    expect(await calls(page, "onOpen")).toHaveLength(1);
  } else {
    // On Windows/Linux Meta+click is a plain navigation — the link's own job,
    // which is only possible because the board did not swallow it.
    expect(page.url()).toBe(`${ORIGIN}/admin/feedback/FB-00001`);
  }
});

// ---------------------------------------------------------------------------
// Unknown statuses
// ---------------------------------------------------------------------------

test("an unknown status gets an Unrecognised status column: drag out of it, never into it", async ({ page }) => {
  await boot(page, { tickets: [...TICKETS, ORPHAN] });
  const orphans = col(page, "Unrecognised status");
  await expect(card(page, 99, orphans)).toBeVisible();
  await expect(card(page, 99, orphans)).toContainText("status “triage”");

  // Drag a known card over the orphan column: it never becomes a drop target.
  // (Positive control first: a real column does light up under the same drag.)
  // Chromium fires dragover on the update AFTER the pointer enters a new
  // element; a real OS keeps sending updates while the pointer rests, but
  // Playwright sends one per move — so each stop is followed by a 2px nudge.
  const dragOverAt = async (x: number, y: number) => {
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.move(x + 2, y + 2);
  };
  const source = await card(page, 2).boundingBox();
  await page.mouse.move(source!.x + 30, source!.y + 12);
  await page.mouse.down();
  const progress = await col(page, "In progress").boundingBox();
  await dragOverAt(progress!.x + progress!.width / 2, progress!.y + 22);
  await expect(col(page, "In progress")).toHaveClass(/aib-over/);
  const target = await orphans.boundingBox();
  await dragOverAt(target!.x + target!.width / 2, target!.y + 22);
  await expect(col(page, "In progress")).not.toHaveClass(/aib-over/);
  await expect(orphans).not.toHaveClass(/aib-over/);
  await page.mouse.up();

  await page.waitForTimeout(300);
  expect(await calls(page, "onMove")).toEqual([]);
  await expect(card(page, 2, col(page, "New"))).toBeVisible();
  await expect(card(page, 2, orphans)).toHaveCount(0);

  // Dragging the orphan into a real column is how it gets fixed.
  await card(page, 99).dragTo(col(page, "In progress"));
  await expect(card(page, 99, col(page, "In progress"))).toBeVisible();
  expect(await calls(page, "onMove")).toEqual([{ fn: "onMove", ids: ["t99"], to: "in_progress" }]);
  // No orphans left: the column goes away.
  await expect(orphans).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Theme and tokens
// ---------------------------------------------------------------------------

const LIGHT = { surface: "rgb(255, 255, 255)", surface2: "rgb(245, 247, 249)", ink: "rgb(14, 22, 28)" };
const DARK = { surface: "rgb(22, 29, 35)", surface2: "rgb(15, 20, 24)", ink: "rgb(232, 237, 241)" };

async function themeOf(page: Page) {
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await expect(bar(page)).toBeVisible();
  await handle(page, 1).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return {
    card: await bg(card(page, 3)),
    column: await bg(col(page, "New")),
    ink: await page.locator(".aib-root").evaluate((el) => getComputedStyle(el).color),
    bar: await bg(bar(page)),
    panel: await bg(page.locator(".aib-panel")),
  };
}

test("theme='light' under a dark OS keeps the board, bar and panel light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await boot(page, { theme: "light", bulk: true, panel: true });
  expect(await themeOf(page)).toEqual({
    card: LIGHT.surface,
    column: LIGHT.surface2,
    ink: LIGHT.ink,
    bar: LIGHT.surface,
    panel: LIGHT.surface,
  });
});

test("theme auto (the default) under a dark OS is dark — board, bar and panel", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await boot(page, { bulk: true, panel: true });
  expect(await themeOf(page)).toEqual({
    card: DARK.surface,
    column: DARK.surface2,
    ink: DARK.ink,
    bar: DARK.surface,
    panel: DARK.surface,
  });
});

test("theme='dark' under a light OS is dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await boot(page, { theme: "dark", bulk: true, panel: true });
  expect(await themeOf(page)).toEqual({
    card: DARK.surface,
    column: DARK.surface2,
    ink: DARK.ink,
    bar: DARK.surface,
    panel: DARK.surface,
  });
});

for (const [name, media, theme] of [
  ["light", "light", undefined],
  ["dark pinned", "light", "dark"],
  ["auto under a dark OS", "dark", undefined],
] as const) {
  test(`a host's .aib-root token override wins even from a stylesheet BEFORE the package's (${name})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: media });
    await boot(page, { bulk: true, theme }, ".aib-root { --aib-accent: rgb(255, 0, 0); }");
    // Make the order the hard case: the host rule first in <head>, the package
    // stylesheet after it — same-specificity rules would let the package win.
    const order = await page.evaluate((selector) => {
      const host = document.getElementById("host-tokens")!;
      document.head.prepend(host);
      const pkg = document.querySelector(selector);
      if (!pkg) return "no package stylesheet";
      return host.compareDocumentPosition(pkg) & Node.DOCUMENT_POSITION_FOLLOWING ? "host first" : "package first";
    }, PACKAGE_STYLE);
    expect(order).toBe("host first");

    const root = page.locator(".aib-root");
    expect(await root.evaluate((el) => getComputedStyle(el).getPropertyValue("--aib-accent").trim())).toBe(
      "rgb(255, 0, 0)",
    );
    // A token used inside the board (the screenshot link) …
    const shotLink = card(page, 1).getByRole("link", { name: /Screenshot for FB-00001/ });
    expect(await shotLink.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
    // … and in the bulk bar, which renders beside .aib-board, not inside it.
    await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
    await bar(page).getByRole("combobox", { name: "Move selection to" }).selectOption({ label: "Done" });
    expect(await bg(bar(page).getByRole("button", { name: "Apply" }))).toBe("rgb(255, 0, 0)");
  });
}

test("the documented bar position vars move it: --aib-bar-bottom clears the floating button, --aib-bar-left centres it on <main>", async ({
  page,
}) => {
  await boot(page, { bulk: true }, ".aib-root { --aib-bar-bottom: 88px; --aib-bar-left: calc(50% + 120px); }");
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  const box = (await bar(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(viewport.height - (box.y + box.height))).toBe(88);
  const mainCentre = (240 + viewport.width) / 2;
  expect(Math.abs(box.x + box.width / 2 - mainCentre)).toBeLessThanOrEqual(1);
  const fab = (await page.locator(".fab").boundingBox())!;
  expect(box.y + box.height, "bar sits above the floating button").toBeLessThanOrEqual(fab.y);
});

// ---------------------------------------------------------------------------
// Accessibility (axe)
// ---------------------------------------------------------------------------

for (const scheme of ["light", "dark"] as const) {
  test(`axe: no WCAG 2.1 A/AA violations — board at rest, bar up, panel open (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, {
      tickets: [...TICKETS, ORPHAN],
      bulk: true,
      panel: true,
      detail: DETAIL,
      messages: MESSAGES,
    });
    // Columns are labelled groups (not landmarks — a 9-column board would
    // flood the landmark list) with real lists.
    await expect(page.getByRole("group", { name: "In progress", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "In progress", exact: true }).getByRole("listitem")).toHaveCount(2);

    expect(await axeViolations(page, ".aib-root"), "board at rest").toEqual([]);

    await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
    await page.getByRole("checkbox", { name: "Select all in In review" }).check();
    await bar(page).getByRole("combobox", { name: "Move selection to" }).selectOption({ label: "Done" });
    await expect(bar(page).getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(await axeViolations(page, ".aib-root"), "bar up").toEqual([]);
    await bar(page).getByRole("button", { name: "Clear" }).click();

    await handle(page, 1).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".aib-shot")).toBeVisible();
    expect(await axeViolations(page, ".aib-panel"), "ticket panel").toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// TicketPanel
// ---------------------------------------------------------------------------

test("TicketPanel: focus moves in, Tab and Shift+Tab stay inside, Escape closes and focus returns to the opener", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await page.getByRole("textbox", { name: "Search tickets" }).focus();
  await page.keyboard.press("Tab");
  await expect(handle(page, 1)).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: `FB-00001 — ${T1_TITLE}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

  const inside = () => page.evaluate(() => !!document.activeElement?.closest(".aib-panel"));
  const seen = new Set<string>();
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    expect(await inside(), `Tab #${i + 1} left the panel`).toBe(true);
    seen.add(await page.evaluate(() => document.activeElement!.outerHTML.slice(0, 40)));
  }
  expect(seen.size, "Tab cycles through the panel's controls").toBeGreaterThanOrEqual(5);
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await inside(), `Shift+Tab #${i + 1} left the panel`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(handle(page, 1)).toBeFocused();
});

test("TicketPanel: closing it after moving the ticket from the panel returns focus to that card", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await handle(page, 1).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("combobox", { name: "Status" }).selectOption({ label: "In progress" });
  // The card moved columns behind the panel (its title remounted).
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(dialog.getByRole("combobox", { name: "Status" })).toHaveValue("in_progress");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(handle(page, 1)).toBeFocused();
});

test("TicketPanel: a send that throws keeps the draft and calls onError (no unhandled rejection)", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await handle(page, 1).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    window.__srv.sendFails = true;
  });
  const note = dialog.getByRole("textbox", { name: "Note as Dallin" });
  await note.fill("Looking into it now");
  await dialog.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => calls(page, "onError")).toEqual([{ fn: "onError", action: "send", message: "Send failed" }]);
  await expect(note).toHaveValue("Looking into it now");
  await expect(dialog.getByRole("button", { name: "Send" })).toBeEnabled();

  // The retry goes through and only then clears the draft.
  await page.evaluate(() => {
    window.__srv.sendFails = false;
  });
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(note).toHaveValue("");
  await expect(dialog.locator(".aib-msg-staff").last()).toContainText("Looking into it now");
  expect((await calls(page, "onSend")).map((c) => c.body)).toEqual(["Looking into it now", "Looking into it now"]);
});

// ---------------------------------------------------------------------------
// 0.9.0 review fix pass. Each test below fails against the board as it was
// before that pass (AIB_BOARD_SRC=<the pre-fix board.tsx>) — see the README.
// ---------------------------------------------------------------------------

/** The column title a card (by ticket number) is rendered under, or null. */
const columnOf = (page: Page, n: number) =>
  page.evaluate((number) => {
    for (const el of document.querySelectorAll(".aib-card")) {
      if (el.querySelector(".aib-num")?.textContent === number) {
        return el.closest(".aib-col")?.querySelector(".aib-col-title")?.textContent ?? null;
      }
    }
    return null;
  }, num(n));

/**
 * Record every column a card is ever rendered in (window.__trail), from now
 * on: a MutationObserver sees each commit, so even a one-frame snap back to
 * an earlier column shows up.
 */
async function trackColumns(page: Page, n: number): Promise<void> {
  await page.evaluate((number) => {
    const where = () => {
      for (const el of document.querySelectorAll(".aib-card")) {
        if (el.querySelector(".aib-num")?.textContent === number) {
          return el.closest(".aib-col")?.querySelector(".aib-col-title")?.textContent ?? null;
        }
      }
      return null;
    };
    window.__trail = [];
    const note = () => {
      const at = where();
      if (window.__trail[window.__trail.length - 1] !== at) window.__trail.push(at);
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }, num(n));
}

/** Hand the board the oldest queued refetch, and wait until React has committed it. */
async function flushRefresh(page: Page): Promise<void> {
  const before = await page.evaluate(() => window.__srv.commits as number);
  await page.evaluate(() => window.__srv.flush());
  await page.waitForFunction((n) => window.__srv.commits > n, before);
}

/** Move the host's own stylesheet in front of the package's — the order where same-specificity rules lose. */
async function hostStylesFirst(page: Page): Promise<void> {
  const order = await page.evaluate((selector) => {
    const host = document.getElementById("host-tokens")!;
    document.head.prepend(host);
    const pkg = document.querySelector(selector);
    if (!pkg) return "no package stylesheet";
    return host.compareDocumentPosition(pkg) & Node.DOCUMENT_POSITION_FOLLOWING ? "host first" : "package first";
  }, PACKAGE_STYLE);
  expect(order).toBe("host first");
}

/** WCAG contrast ratio of two computed rgb()/rgba() colours (alpha ignored). */
function contrast(a: string, b: string): number {
  const lum = (color: string) => {
    const [r, g, bl] = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const onCloseCount = (page: Page) => calls(page, "onClose").then((list) => list.length);

async function openPanel(page: Page, n = 1): Promise<Locator> {
  await handle(page, n).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  return dialog;
}

// --- (1) Token scope and stacking -------------------------------------------

test("panel: the feedback widget's launcher (fixed bottom-right, z-index 2147483000) does not cover Send", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  await dialog.getByRole("textbox", { name: "Note as Dallin" }).fill("On it");
  // The widget's real launcher, placed as packages/feedback-widget/src/styles.ts (.aif-fab) places it.
  await page.evaluate(() => {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "aif-launcher";
    fab.textContent = "Report a bug";
    fab.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:auto;padding:10px 16px;" +
      "border:0;border-radius:999px;font:600 13px system-ui,sans-serif;background:#0f766e;color:#fff";
    window.__launcherClicks = 0;
    fab.addEventListener("click", () => {
      window.__launcherClicks += 1;
    });
    document.body.appendChild(fab);
  });
  const send = dialog.getByRole("button", { name: "Send" });
  const s = (await send.boundingBox())!;
  const l = (await page.locator("#aif-launcher").boundingBox())!;
  const [cx, cy] = [s.x + s.width / 2, s.y + s.height / 2];
  expect(
    cx >= l.x && cx <= l.x + l.width && cy >= l.y && cy <= l.y + l.height,
    "precondition: the launcher's box covers Send's centre",
  ).toBe(true);

  expect(await hits(send, cx, cy), "the launcher is painted over Send").toBe(true);
  await page.mouse.click(cx, cy);
  await expect.poll(() => calls(page, "onSend")).toEqual([{ fn: "onSend", body: "On it" }]);
  expect(await page.evaluate(() => window.__launcherClicks), "the click meant for Send hit the launcher").toBe(0);
});

test("panel: a host's .aib-panel-layer { --aib-z-panel: 50 } restacks scrim and dialog together — the scrim stays BELOW the dialog", async ({
  page,
}) => {
  await boot(
    page,
    { panel: true, detail: DETAIL, messages: MESSAGES },
    ".aib-panel-layer { --aib-z-panel: 50; --aib-accent: rgb(255, 0, 0); }",
  );
  await hostStylesFirst(page);
  const dialog = await openPanel(page);

  const z = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).zIndex);
  expect({ dialog: await z(".aib-panel"), scrim: await z(".aib-panel-backdrop") }).toEqual({
    dialog: "50",
    scrim: "49",
  });
  // The middle of the dialog's body is the dialog's, not the scrim's …
  const body = (await dialog.locator(".aib-thread").boundingBox())!;
  expect(await hits(dialog, body.x + body.width / 2, body.y + body.height / 2), "the scrim covers the dialog").toBe(
    true,
  );
  // … and the board beside it is under the scrim.
  expect(await hits(page.locator(".aib-panel-backdrop"), 500, 300)).toBe(true);
  // Every token set on the layer reaches inside the dialog (none re-declared beneath it).
  // (Polled: Send eases its background over 120ms from the disabled grey.)
  await dialog.getByRole("textbox", { name: "Note as Dallin" }).fill("x");
  await expect.poll(() => bg(dialog.getByRole("button", { name: "Send" }))).toBe("rgb(255, 0, 0)");
});

test("a host's font-family and color on .aib-root / .aib-panel win, even from a stylesheet BEFORE the package's", async ({
  page,
}) => {
  await boot(page, { panel: true }, ".aib-root, .aib-panel { font-family: Georgia, serif; color: rgb(1, 2, 3); }");
  await hostStylesFirst(page);
  await openPanel(page);
  for (const selector of [".aib-root", ".aib-panel"]) {
    const look = await page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el);
      return { font: style.fontFamily, color: style.color };
    });
    expect(look, selector).toEqual({ font: "Georgia, serif", color: "rgb(1, 2, 3)" });
  }
});

for (const [media, theme, scheme] of [
  ["light", "dark", "dark"],
  ["dark", "light", "light"],
  ["dark", undefined, "dark"],
] as const) {
  test(`color-scheme follows the theme, so native controls match it (theme ${theme ?? "auto"} under a ${media} OS)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: media });
    await boot(page, { theme, panel: true });
    await openPanel(page);
    const schemes = await page.evaluate(() =>
      [".aib-root", ".aib-panel-layer", ".aib-panel select"].map((selector) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).colorScheme : `no ${selector}`;
      }),
    );
    expect(schemes).toEqual([scheme, scheme, scheme]);
  });
}

// --- (2) Panel keys: only the ones that reach it; focus restore ------------

/** A host's own native modal <dialog>, opened with showModal() above the panel. */
async function openHostDialog(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const host = document.createElement("dialog");
    host.id = "host-dialog";
    host.setAttribute("aria-label", "Host dialog");
    host.innerHTML =
      '<input aria-label="Host field"><button type="button">One</button><button type="button">Two</button>';
    document.body.appendChild(host);
    host.showModal();
  });
  const host = page.locator("#host-dialog");
  await expect(host.getByRole("textbox", { name: "Host field" })).toBeFocused();
  return host;
}

test("panel: a native <dialog> opened with showModal() above it keeps its own Tab", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await openPanel(page);
  const host = await openHostDialog(page);

  await page.keyboard.press("Tab");
  await expect(host.getByRole("button", { name: "One" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(host.getByRole("button", { name: "Two" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(host.getByRole("button", { name: "One" })).toBeFocused();
});

test("panel: Escape in a native <dialog> opened above it closes only that dialog; the panel stays open", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const panel = await openPanel(page);
  const host = await openHostDialog(page);

  await page.keyboard.press("Escape");
  await expect.poll(() => host.evaluate((el) => (el as HTMLDialogElement).open)).toBe(false);
  expect(await onCloseCount(page), "Escape in the host's dialog closed the panel too").toBe(0);
  await expect(panel).toBeVisible();

  // Positive control: back in the panel, its own Escape still works.
  await panel.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await onCloseCount(page)).toBe(1);
});

test("panel: an Escape that ends an IME composition (isComposing) does not close it", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const panel = await openPanel(page);
  const note = panel.getByRole("textbox", { name: "Note as Dallin" });
  await note.focus();

  // Playwright can't drive a real IME, so this is the keydown one sends when
  // Escape cancels a composition (isComposing). The panel answers keydown
  // synchronously, so an onClose would already be logged when dispatch returns.
  const escapeClosed = (isComposing: boolean) =>
    note.evaluate((el, composing) => {
      const before = window.__srv.calls.length;
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          isComposing: composing,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return window.__srv.calls.slice(before).some((call: { fn: string }) => call.fn === "onClose");
    }, isComposing);
  expect(await escapeClosed(true), "an Escape inside an IME composition closed the panel").toBe(false);
  await expect(panel).toBeVisible();

  // Positive control: the same synthetic Escape, not composing, does close it
  // — so the first one reached the panel and was declined, not lost.
  expect(await escapeClosed(false)).toBe(true);
  await expect(panel).toHaveCount(0);
});

test("panel: an Escape a control inside it already handled (defaultPrevented) does not close it", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const panel = await openPanel(page);
  const note = panel.getByRole("textbox", { name: "Note as Dallin" });
  await note.focus();
  // A control that uses Escape itself, and says so with preventDefault.
  await note.evaluate((el) =>
    el.addEventListener(
      "keydown",
      (event) => {
        if ((event as KeyboardEvent).key === "Escape") event.preventDefault();
      },
      { once: true },
    ),
  );
  await page.keyboard.press("Escape");
  expect(await onCloseCount(page), "an Escape a control had already handled closed the panel").toBe(0);
  await expect(panel).toBeVisible();

  // Positive control: the next Escape (unhandled) closes it.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await onCloseCount(page)).toBe(1);
});

test("panel: with focus on the dialog itself (a click on its text), Tab and Shift+Tab still stay inside", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  const title = dialog.locator(".aib-panel-title");

  await title.click();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  // The last enabled control: the note (Send is disabled with no draft).
  await expect(dialog.getByRole("textbox", { name: "Note as Dallin" })).toBeFocused();

  await title.click();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
});

test("panel: opened by a click on the card's body (nothing focused), closing puts focus on that card's title, not <body>", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await card(page, 1).locator(".aib-num").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(handle(page, 1)).toBeFocused();
});

// --- (3) Panel Status select and Send -----------------------------------------

test("panel Status: arrowing through it sends NO move; Enter sends ONE with the final value; leaving it commits; a pointer pick moves at once", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  const status = dialog.getByRole("combobox", { name: "Status" });
  await page.keyboard.press("Tab");
  await expect(status).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveValue("in_progress");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveValue("review");
  expect(await calls(page, "onMove"), "an arrow key sent a move").toEqual([]);
  await expect(card(page, 1, col(page, "New"))).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(card(page, 1, col(page, "In review"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  expect(await calls(page, "onMove")).toEqual([{ fn: "onMove", ids: ["t1"], to: "review" }]);
  await expect(status).toHaveValue("review");
  await expect(status).toBeFocused();

  // A keyboard choice also commits when focus leaves the control — once.
  await page.keyboard.press("ArrowUp");
  await expect(status).toHaveValue("in_progress");
  expect(await calls(page, "onMove")).toHaveLength(1);
  await page.keyboard.press("Tab");
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  expect((await calls(page, "onMove")).map((call) => call.to)).toEqual(["review", "in_progress"]);

  // A pointer pick (a fresh panel; no key has touched the control) moves at
  // once, without waiting for Enter or blur.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await handle(page, 1).click();
  await expect(dialog).toBeVisible();
  await status.selectOption({ label: "Done" });
  await expect(card(page, 1, col(page, "Done"))).toBeVisible();
  expect((await calls(page, "onMove")).map((call) => call.to)).toEqual(["review", "in_progress", "resolved"]);
});

test("panel: Send says Sending… and is aria-busy while the reply is in flight", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  await page.evaluate(() => {
    window.__srv.sendHold = true;
  });
  const note = dialog.getByRole("textbox", { name: "Note as Dallin" });
  await note.fill("On it");
  const send = dialog.locator(".aib-send");
  await send.click();
  await expect(send).toHaveText("Sending…");
  await expect(send).toHaveAttribute("aria-busy", "true");
  await expect(send).toBeDisabled();

  await page.evaluate(() => window.__srv.releaseSend());
  await expect(note).toHaveValue("");
  await expect(send).toHaveText("Send");
  await expect(send).not.toHaveAttribute("aria-busy");
});

// --- (4) Chained moves ----------------------------------------------------------

test("keyboard: Alt+→ twice before the refetch lands — the card never snaps back a column, and keeps focus", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.__srv.deferRefresh = true;
  });
  await trackColumns(page, 1);
  await handle(page, 1).focus();

  // Each move lands (onMove resolves) but its refetch is queued.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(handle(page, 1)).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(card(page, 1, col(page, "In review"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await expect(handle(page, 1)).toBeFocused();
  expect(await calls(page, "onMove")).toEqual([
    { fn: "onMove", ids: ["t1"], to: "in_progress" },
    { fn: "onMove", ids: ["t1"], to: "review" },
  ]);
  expect(await page.evaluate(() => window.__srv.queued.length)).toBe(2);

  // Refetch #1 says "In progress" (the first move), #2 says "In review".
  for (const n of [1, 2]) {
    await flushRefresh(page);
    expect(await columnOf(page, 1), `column after refetch #${n}`).toBe("In review");
    expect(
      await handle(page, 1).evaluate((el) => el === document.activeElement),
      `focus after refetch #${n}`,
    ).toBe(true);
  }
  expect(await page.evaluate(() => window.__trail), "every column the card was ever drawn in").toEqual([
    "New",
    "In progress",
    "In review",
  ]);

  // Caught up: the board follows the server again.
  await page.evaluate(() => {
    window.__srv.deferRefresh = false;
    window.__srv.setStatus("t1", "resolved");
  });
  await expect(card(page, 1, col(page, "Done"))).toBeVisible();
});

test("a card with a move in flight is aria-busy with a dashed edge — not faded", async ({ page }) => {
  await boot(page);
  await setMode(page, "hold");
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowRight");
  const moving = card(page, 1, col(page, "In progress"));
  await expect(moving).toHaveAttribute("aria-busy", "true");
  await expect(handle(page, 1)).toBeFocused();
  const look = await moving.evaluate((el) => {
    const style = getComputedStyle(el);
    return { opacity: style.opacity, edge: style.borderTopStyle };
  });
  expect(look).toEqual({ opacity: "1", edge: "dashed" });

  await page.evaluate(() => window.__srv.release(true));
  await expect(card(page, 1, col(page, "In progress"))).not.toHaveAttribute("aria-busy");
});

// --- (5) Partial bulk result ----------------------------------------------------

test("bulk: onMoveMany resolving { failed: [id] } sends back only that card; the landed one stays moved and leaves the selection", async ({
  page,
}) => {
  await boot(page, { bulk: true });
  await page.evaluate(() => {
    window.__srv.failIds = ["t3"];
    window.__srv.partialAs = "result";
  });
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await page.getByRole("checkbox", { name: "Select FB-00003" }).check();
  await bar(page).getByRole("combobox", { name: "Move selection to" }).selectOption({ label: "Done" });
  await bar(page).getByRole("button", { name: "Apply" }).click();

  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 2)).not.toHaveClass(/aib-busy/);
  await expect(card(page, 3)).not.toHaveClass(/aib-busy/);
  await expect(card(page, 3, col(page, "New"))).toBeVisible();
  await expect(card(page, 3, col(page, "Done"))).toHaveCount(0);
  await expect(live(page)).toHaveText("1 moved to Done; FB-00003 could not be moved.");
  // The landed card leaves the selection; the refused one stays ticked for a retry.
  await expect(page.getByRole("checkbox", { name: "Select FB-00002" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select FB-00003" })).toBeChecked();
  await expect(bar(page)).toContainText("1 selected");
  const errors = await calls(page, "onMoveError");
  expect(errors.map((call) => ({ ids: call.ids, to: call.to }))).toEqual([{ ids: ["t3"], to: "resolved" }]);
  expect(await serverStatus(page, "t2")).toBe("resolved");
  expect(await serverStatus(page, "t3")).toBe("open");
});

// --- (6) Focus after the bulk bar unmounts --------------------------------------

/** Tick a card's checkbox from the keyboard. */
async function tickByKey(page: Page, n: number): Promise<void> {
  await page.getByRole("checkbox", { name: `Select ${num(n)}` }).focus();
  await page.keyboard.press("Space");
}

const focusOnBody = (page: Page) =>
  page.evaluate(() => document.activeElement === document.body || document.activeElement === null);

test("bulk: Apply pressed from the keyboard puts focus on the first moved card's title, not <body>", async ({
  page,
}) => {
  await boot(page, { bulk: true });
  const select = bar(page).getByRole("combobox", { name: "Move selection to" });
  await tickByKey(page, 2);
  await tickByKey(page, 3);
  await expect(bar(page)).toContainText("2 selected");
  await select.selectOption({ label: "Done" });
  await select.focus();
  await page.keyboard.press("Tab");
  await expect(bar(page).getByRole("button", { name: "Apply" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(card(page, 3, col(page, "Done"))).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  // Where a keyboard user can carry on (Alt+Arrow, Enter).
  await expect(handle(page, 2)).toBeFocused();
  expect(await focusOnBody(page)).toBe(false);
});

test("bulk: Clear pressed from the keyboard puts focus on the first cleared card's title, not <body>", async ({ page }) => {
  await boot(page, { bulk: true });
  await tickByKey(page, 4);
  await expect(bar(page)).toContainText("1 selected");
  await bar(page).getByRole("combobox", { name: "Move selection to" }).focus();
  await page.keyboard.press("Tab"); // Apply is disabled with no target, so this is Clear
  await expect(bar(page).getByRole("button", { name: "Clear" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Select FB-00004" })).not.toBeChecked();
  // Cleared cards don't move, so the first of them is where a keyboard user carries on.
  await expect(handle(page, 4)).toBeFocused();
  expect(await focusOnBody(page)).toBe(false);
});

// --- (7) Semantics and announcements --------------------------------------------

test("columns are named groups (one region: the board itself) with real lists; WIP and aging are spelled out; every card handle describes Alt+Arrow", async ({
  page,
}) => {
  // A key with a space: column ids are by position, so aria-labelledby can't split it.
  const statuses = [...STATUSES.slice(0, 2), { key: "on hold", label: "On hold", sortOrder: 25 }, ...STATUSES.slice(2)];
  await boot(page, { statuses: statuses as typeof STATUSES });
  const root = page.locator(".aib-root");
  const names = ["New", "In progress", "On hold", "In review", "Done"];
  await expect(root.getByRole("group")).toHaveCount(names.length);
  for (const name of names) await expect(root.getByRole("group", { name, exact: true }), name).toHaveCount(1);
  // The board is ONE named region (where focus lands after Clear/Apply); the
  // columns are groups, not landmarks — 9 columns would flood the landmark list.
  await expect(page.getByRole("region")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Ticket board" })).toHaveCount(1);

  // Cards are the items of a real list; an empty column has no list at all.
  const group = (name: string) => root.getByRole("group", { name, exact: true });
  await expect(group("New").getByRole("list").getByRole("listitem")).toHaveCount(19);
  await expect(group("On hold").getByRole("list")).toHaveCount(0);
  await expect(group("On hold").getByRole("listitem")).toHaveCount(0);
  await expect(group("On hold")).toContainText("No tickets");

  // WIP and aging in words, not only colour and "2/1".
  await expect(group("In review").getByText("2 tickets, limit 1, over the limit", { exact: true })).toHaveCount(1);
  await expect(group("In progress").getByText("2 tickets, limit 3", { exact: true })).toHaveCount(1);
  await expect(card(page, 1).getByText("Stale: 4 days in this column.", { exact: true })).toHaveCount(1);
  await expect(card(page, 2).getByText("Aging: 1 day in this column.", { exact: true })).toHaveCount(1);

  const hints = await page.locator("[data-aib-open]").evaluateAll((els) =>
    els.map((el) => {
      const id = el.getAttribute("aria-describedby");
      return id ? (document.getElementById(id)?.textContent ?? `missing #${id}`) : "no aria-describedby";
    }),
  );
  expect(hints).toHaveLength(TICKETS.length);
  expect([...new Set(hints)]).toEqual(["Alt plus left or right arrow moves this ticket one column left or right."]);
  // The hint is `hidden`: read as each title's description, never as stray text.
  await expect(page.locator(`[id="${await page.locator("[data-aib-open]").first().getAttribute("aria-describedby")}"]`)).toBeHidden();
});

/**
 * Count text INSERTED into the live region from now on. A screen reader speaks
 * additions (aria-relevant="additions text"); a removal-only change may be
 * skipped, so a repeat must arrive as a new node, not a tweak of the old text.
 */
async function countInsertions(page: Page): Promise<() => Promise<string[]>> {
  await live(page).evaluate((el) => {
    const w = window as unknown as { __inserted: string[] };
    w.__inserted = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) if (node.textContent) w.__inserted.push(node.textContent);
    }).observe(el, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __inserted: string[] }).__inserted);
}

test("live region: Alt+Arrow with no column that way says why — every time", async ({ page }) => {
  // bulk: the orphan's announcement points at "Move to…", the bar's control.
  await boot(page, { tickets: [...TICKETS, ORPHAN], bulk: true });
  const inserted = await countInsertions(page);
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowLeft"); // first column
  await expect(live(page)).toHaveText("No column that way.");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(inserted, "the repeat was not inserted again").toEqual(["No column that way.", "No column that way."]);

  await handle(page, 99).focus();
  await page.keyboard.press("Alt+ArrowRight"); // unrecognised status
  // Names the way out that exists with or without the bulk bar.
  await expect(live(page)).toHaveText(
    "FB-00099's status has no column. Drag it to one, or open it and set its status.",
  );
  expect(await calls(page, "onMove")).toEqual([]);
});

test("live region: the same announcement twice is spoken twice — inserted afresh each time (a refused move, twice)", async ({
  page,
}) => {
  await boot(page);
  const inserted = await countInsertions(page);
  await handle(page, 1).focus();
  await setMode(page, "reject");
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(async () => (await calls(page, "onMoveError")).length).toBe(1);
  await expect(live(page)).toHaveText("FB-00001 could not be moved.");
  await expect(handle(page, 1)).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(async () => (await calls(page, "onMoveError")).length).toBe(2);
  await expect
    .poll(inserted, "a repeated announcement was not inserted again")
    .toEqual(["FB-00001 could not be moved.", "FB-00001 could not be moved."]);
});

// --- (8) Forced colours, control edges, hit areas, host link colours ----------

test("forced colours (Windows High Contrast): a ticked checkbox still looks ticked", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await boot(page, { bulk: true });
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const ticked = page.getByRole("checkbox", { name: "Select FB-00002" });
  const unticked = page.getByRole("checkbox", { name: "Select FB-00003" });
  await ticked.check();
  const drawn = (target: Locator) =>
    target.evaluate((el) => ({
      box: getComputedStyle(el, "::before").backgroundColor,
      tick: getComputedStyle(el, "::after").backgroundColor,
    }));
  const on = await drawn(ticked);
  const off = await drawn(unticked);
  expect(on.box, "ticked and unticked boxes are filled alike").not.toBe(off.box);
  expect(on.tick, "the tick is the colour of its own box").not.toBe(on.box);
});

for (const scheme of ["light", "dark"] as const) {
  test(`panel controls have an edge ≥3:1 against the panel, and placeholders read at 4.5:1 (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, { panel: true });
    const dialog = await openPanel(page, 2); // FB-00002 is unassigned: its Assignee shows the placeholder
    const surface = await bg(dialog);
    const assignee = dialog.locator(".aib-input");
    const note = dialog.getByRole("textbox", { name: "Note as Dallin" });
    await expect(assignee).toHaveValue("");
    for (const [what, target] of [
      ["Status", dialog.getByRole("combobox", { name: "Status" })],
      ["Assignee", assignee],
      ["Note", note],
    ] as const) {
      const edge = await target.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(contrast(edge, surface), `${what} edge ${edge} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    for (const [what, target] of [
      ["Assignee", assignee],
      ["Note", note],
    ] as const) {
      const ink = await target.evaluate((el) => getComputedStyle(el, "::placeholder").color);
      expect(contrast(ink, surface), `${what} placeholder ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("bulk: a card's 44px checkbox ends where its title begins — the hit area never sits under the title", async ({
  page,
}) => {
  await boot(page, { bulk: true });
  for (const n of [1, 2, 3, 21, 25]) {
    const check = (await page.getByRole("checkbox", { name: `Select ${num(n)}` }).boundingBox())!;
    const title = (await handle(page, n).boundingBox())!;
    expect(check.y + check.height, `${num(n)}: checkbox bottom vs title top`).toBeLessThanOrEqual(title.y + 0.5);
  }
});

test("ticketHref titles keep the card's ink under a host's a:link / a:visited / a:hover colours", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await boot(
    page,
    { href: true },
    "a:link { color: rgb(0, 0, 238); } a:visited { color: rgb(85, 26, 139); } a:hover { color: rgb(200, 0, 0); }",
  );
  const link = handle(page, 1);
  const color = () => link.evaluate((el) => getComputedStyle(el).color);
  expect(await color()).toBe(LIGHT.ink);
  await link.hover();
  expect(await color()).toBe(LIGHT.ink);
});

// ---------------------------------------------------------------------------
// 0.9.0 second fix pass (fresh-eyes review of the first). Each test fails
// against the board as it was between the two passes.
// ---------------------------------------------------------------------------

test("panel: after Send, focus stays in the panel (on the note box) and Escape still closes it", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  const note = dialog.getByRole("textbox", { name: "Note as Dallin" });
  await note.fill("On it");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => calls(page, "onSend")).toEqual([{ fn: "onSend", body: "On it" }]);
  await expect(note).toHaveValue("");
  // Send disabled itself; focus must not fall to <body>.
  await expect(note).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("panel: Enter in Assignee applies in place — focus stays, one assign, Escape still closes", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  const assignee = dialog.getByRole("textbox", { name: "Assignee" });
  await assignee.fill("Dana");
  await assignee.press("Enter");
  await expect.poll(() => calls(page, "onAssign")).toEqual([{ fn: "onAssign", assignee: "Dana" }]);
  await expect(assignee).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Leaving the field on close didn't assign a second time.
  expect(await calls(page, "onAssign")).toHaveLength(1);
});

test("panel: if focus does fall to <body>, Escape still closes and Tab re-enters the panel", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  let dialog = await openPanel(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await focusOnBody(page)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  dialog = await openPanel(page);
  await expect(dialog).toBeVisible();
});

test("panel: Escape with a staged status choice reverts it and keeps the panel; the next Escape closes", async ({
  page,
}) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  const dialog = await openPanel(page);
  const status = dialog.getByRole("combobox", { name: "Status" });
  await status.focus();
  const before = await status.inputValue();
  await page.keyboard.press("ArrowDown");
  await expect(status).not.toHaveValue(before);
  await page.keyboard.press("Escape");
  await expect(status).toHaveValue(before);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "onMove")).toEqual([]);
});

test("panel: the Escape it handles never reaches the page around it", async ({ page }) => {
  await boot(page, { panel: true, detail: DETAIL, messages: MESSAGES });
  await page.evaluate(() => {
    const w = window as unknown as { __hostEscapes: number };
    w.__hostEscapes = 0;
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") w.__hostEscapes++;
    });
  });
  const dialog = await openPanel(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __hostEscapes: number }).__hostEscapes)).toBe(0);
});

test("theming on .aib-panel-layer reaches the panel's font and colour (the README's recipe)", async ({ page }) => {
  await boot(
    page,
    { panel: true, detail: DETAIL, messages: MESSAGES },
    ".aib-root, .aib-panel-layer { font-family: Georgia, serif; color: rgb(200, 0, 0); }",
  );
  await openPanel(page);
  const style = await page.locator(".aib-panel").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { font: cs.fontFamily, color: cs.color };
  });
  expect(style.font).toContain("Georgia");
  expect(style.color).toBe("rgb(200, 0, 0)");
});

test("chained: a card moved there and back before the refetch lands still follows a later outside change", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.__srv.deferRefresh = true;
  });
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowRight"); // New → In progress
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await page.keyboard.press("Alt+ArrowLeft"); // back to New
  await expect(card(page, 1, col(page, "New"))).toBeVisible();
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
  await flushRefresh(page); // server: in_progress
  expect(await columnOf(page, 1)).toBe("New");
  await flushRefresh(page); // server: new
  expect(await columnOf(page, 1)).toBe("New");

  // Someone else moves it: the board must show that, not a stale "New".
  await page.evaluate(() => {
    window.__srv.deferRefresh = false;
    window.__srv.setStatus("t1", "in_progress");
  });
  await expect(card(page, 1, col(page, "In progress"))).toBeVisible();
});

test("bulk: a partial result from the keyboard keeps focus in the bar while cards are still ticked", async ({ page }) => {
  await boot(page, { bulk: true });
  await page.evaluate(() => {
    window.__srv.failIds = ["t3"];
    window.__srv.partialAs = "result";
  });
  await page.getByRole("checkbox", { name: "Select FB-00002" }).check();
  await page.getByRole("checkbox", { name: "Select FB-00003" }).check();
  const moveTo = bar(page).getByRole("combobox", { name: "Move selection to" });
  await moveTo.selectOption({ label: "Done" });
  await bar(page).getByRole("button", { name: "Apply" }).focus();
  await page.keyboard.press("Enter");
  await expect(card(page, 2, col(page, "Done"))).toBeVisible();
  await expect(bar(page)).toContainText("1 selected");
  await expect(moveTo).toBeFocused();
});

test("keyboard: Alt+Arrow on a card whose move is still in flight says so", async ({ page }) => {
  await boot(page);
  await setMode(page, "hold");
  await handle(page, 1).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(card(page, 1)).toHaveClass(/aib-busy/);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(live(page)).toHaveText("FB-00001 is still moving.");
  expect(await calls(page, "onMove")).toHaveLength(1);
  await page.evaluate(() => window.__srv.release(true));
  await expect(card(page, 1)).not.toHaveClass(/aib-busy/);
});
