import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * @adminigloo/booking-widget in a real browser, driven like a visitor: hold a
 * time and watch the countdown, change your mind (the previous hold must ride
 * along as previousHoldToken), lose the time to someone else and recover with
 * the form intact, switch zones, leave the page (the hold must be released),
 * let a hold run out, submit the same form twice, book in the sandbox,
 * reschedule (asking as the booking: its typeKey, its manage token) and cancel
 * from the manage page, and do it all at 390px.
 *
 * SELF-CONTAINED on purpose: the widget is bundled here, in beforeAll, from
 * the package's SOURCE with esbuild (react pinned to e2e's single copy, as
 * bundle.mjs does), and the booking server is a fake answered with page.route
 * on a made-up origin — so this spec needs no edit to bundle.mjs or the shared
 * host-app fixture. The one exception is the "leaving the page" test: a
 * keepalive request sent from `pagehide` is invisible to page.route (it
 * outlives the document that sent it), so that test serves the same fake from
 * a real local HTTP server and checks what actually arrived.
 *
 * The bundle is a DEVELOPMENT React build under StrictMode, so mount effects
 * run twice the way every buyer's `next dev` runs them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const widgetEntry = join(e2eRoot, "..", "packages", "booking-widget", "src", "index.ts").replace(/\\/g, "/");
const adminEntry = join(e2eRoot, "..", "packages", "booking-widget", "src", "admin.ts").replace(/\\/g, "/");
const ORIGIN = "https://booking.test";

/**
 * An in-memory BookingAdminAdapter for <BookingAdmin>, seeded from the test
 * (window.__bk.admin) and recording every call on window.__admin.calls — the
 * admin screens' "server", the way respond() below is the widget's.
 * Plain JS inside the bundle's source (no backticks, no template holes).
 */
const ADMIN_FAKE = `
function makeAdapter(seed) {
  const state = JSON.parse(JSON.stringify(seed));
  const calls = [];
  window.__admin = { calls, state };
  let n = 0;
  const nextId = (prefix) => prefix + "_" + (++n);
  const log = (name, input) => calls.push({ name, input: input === undefined ? null : JSON.parse(JSON.stringify(input)) });
  const findBooking = (id) => state.bookings.find((b) => b.id === id);
  const host = (id) => state.hosts.find((h) => h.id === id);
  const clear = (value) => (value === "" ? null : value);
  return {
    emailsEnabled: state.emailsEnabled,
    hoursAreDefault: state.hoursAreDefault,
    async listHosts() { return state.hosts; },
    async listTypes() { return state.types; },
    async listBlackouts() { return state.blackouts; },
    async countLiveHolds() { return state.holds || 0; },
    async listBookings(input) {
      log("listBookings", input);
      const now = Date.now();
      const upcoming = input.scope === "upcoming";
      return state.bookings
        .filter((b) => (upcoming ? Date.parse(b.end) > now : Date.parse(b.end) <= now))
        .sort((a, b) => (upcoming ? 1 : -1) * (Date.parse(a.start) - Date.parse(b.start)));
    },
    async getBooking(id) {
      const b = findBooking(id);
      return b ? Object.assign({}, b, { events: state.events[id] || [] }) : null;
    },
    async cancelBooking(input) {
      log("cancelBooking", input);
      const b = findBooking(input.id);
      b.status = "cancelled"; b.cancelledBy = "host"; b.cancelReason = input.reason;
      return b;
    },
    async confirmBooking(id) { log("confirmBooking", id); const b = findBooking(id); b.status = "confirmed"; return b; },
    async setOutcome(input) {
      log("setOutcome", input);
      const b = findBooking(input.id);
      b.outcome = input.outcome; if (input.status) b.status = input.status;
      return b;
    },
    async rescheduleBooking(input) {
      log("rescheduleBooking", input);
      if (state.rescheduleFails) { state.rescheduleFails = false; throw new Error("That time was just taken. Pick another."); }
      const b = findBooking(input.id);
      const length = Date.parse(b.end) - Date.parse(b.start);
      b.start = input.start; b.end = new Date(Date.parse(input.start) + length).toISOString(); b.sequence += 1;
      return b;
    },
    async listRescheduleSlots(input) {
      log("listRescheduleSlots", input);
      const from = Date.parse(input.from), to = Date.parse(input.to);
      return { slots: state.slots.filter((s) => Date.parse(s.start) >= from && Date.parse(s.start) < to) };
    },
    async upsertHost(input) {
      log("upsertHost", input);
      const h = host(input.id);
      for (const key of ["displayName", "email", "timezone", "autoConfirm"]) if (input[key] !== undefined) h[key] = input[key];
      for (const key of ["meetingLink", "phone", "inviteMailbox"]) if (input[key] !== undefined) h[key] = clear(input[key]);
      if (input.busyIcsUrl !== undefined) h.busyIcsUrl = input.busyIcsUrl ? "https://calendar.google.com/…ics ✓" : null;
      h.updatedAt = new Date(Date.now() + (++n)).toISOString();
      return h;
    },
    async testCalendar(id) { log("testCalendar", id); return { ok: true, events: 3 }; },
    async rotateFeed(id) {
      log("rotateFeed", id);
      host(id).hasFeedToken = true;
      return { httpsUrl: "https://booking.test/api/booking/v1/feed/tok" + (++n) + ".ics" };
    },
    async getAvailability() { return { weekly: state.weekly, exceptions: state.exceptions }; },
    async setWeekly(input) { log("setWeekly", input); state.weekly = input.windows; return input.windows; },
    async addException(input) {
      log("addException", input);
      const row = { id: nextId("ex"), date: input.date, kind: input.kind, startMinute: input.startMinute ?? null, endMinute: input.endMinute ?? null, note: input.note ?? null };
      state.exceptions.push(row);
      return row;
    },
    async removeException(id) { log("removeException", id); state.exceptions = state.exceptions.filter((e) => e.id !== id); return { removed: true }; },
    async addBlackout(input) {
      log("addBlackout", input);
      const row = { id: nextId("bo"), date: input.date, label: input.label };
      state.blackouts.push(row);
      return row;
    },
    async removeBlackout(id) { log("removeBlackout", id); state.blackouts = state.blackouts.filter((b) => b.id !== id); return { removed: true }; },
    async upsertType(input) {
      log("upsertType", input);
      const existing = state.types.find((t) => t.id === input.id);
      const row = Object.assign(existing || { id: nextId("type") }, input, { updatedAt: new Date(Date.now() + (++n)).toISOString() });
      if (!existing) state.types.push(row);
      return row;
    },
  };
}
`;

const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BookingWidget, ManageBooking } from ${JSON.stringify(widgetEntry)};
import { BookingAdmin } from ${JSON.stringify(adminEntry)};

const cfg = window.__bk || {};
window.__booked = [];
${ADMIN_FAKE}
const adminAdapter = cfg.admin ? makeAdapter(cfg.admin) : null;

function App() {
  if (adminAdapter) {
    return <BookingAdmin adapter={adminAdapter} bookingPageUrl="/real" />;
  }
  if (cfg.manage) {
    return <ManageBooking baseUrl="/api/booking" token={cfg.manage} realBookingHref="/real" {...(cfg.manageProps || {})} />;
  }
  return (
    <BookingWidget
      baseUrl="/api/booking"
      sandbox={cfg.sandbox}
      realBookingHref="/real"
      source="e2e"
      onBooked={(result) => window.__booked.push(result)}
      {...(cfg.props || {})}
    />
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "booking-host.tsx", loader: "tsx" },
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

test.use({ timezoneId: "America/New_York", locale: "en-US" });

// ---------------------------------------------------------------------------
// The fake booking server
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const utcDay = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const iso = (ms: number) => new Date(ms).toISOString();
/** The calendar date of an instant in New York — the browser's zone in these tests. */
const nyDate = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
/** Tiles from one cut date to another, both included. */
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1;

/** Two days of times: two mornings, an afternoon and an evening in New York, year-round. */
function makeSlots(): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  for (const day of [utcDay(2), utcDay(3)]) {
    for (const minutes of [14 * 60, 14 * 60 + 30, 19 * 60, 23 * 60 + 30]) {
      const start = day + minutes * 60_000;
      out.push({ start: iso(start), end: iso(start + 30 * 60_000) });
    }
  }
  return out;
}

interface Fake {
  config: {
    sandbox: boolean;
    hostDisplayName: string;
    hostTimezone: string;
    types: Array<{
      key: string;
      name: string;
      description: string | null;
      durationMinutes: number;
      media: string[];
      minNoticeMinutes?: number;
      horizonDays?: number;
    }>;
    defaultCallingCode?: string;
    emailsEnabled?: boolean;
    contactEmail?: string | null;
  };
  /** The host has no meeting link saved: video bookings come back with meetingLink null. */
  noMeetingLink?: boolean;
  slots: Array<{ start: string; end: string }>;
  slotRequests: number;
  holds: Array<Record<string, unknown>>;
  releases: string[];
  books: Array<Record<string, unknown>>;
  reschedules: Array<Record<string, unknown>>;
  cancels: Array<Record<string, unknown>>;
  /** Starts a hold attempt finds already taken. */
  takenOnHold: Set<string>;
  failBookOnce: { status: number; code: string } | null;
  /** Simulates a server that counts the visitor's own hold as busy on reschedule. */
  rescheduleRejectsHeld: boolean;
  /** A hold carrying a manage token answers not_found (the booking can no longer move). */
  holdNotFoundForManage: boolean;
  holdMs: number;
  booking: Record<string, unknown> & { start: string; end: string; status: string };
}

function makeFake(overrides: Partial<Fake> = {}): Fake {
  const slots = makeSlots();
  const bookedStart = Date.parse(slots[0]!.start) - DAY;
  return {
    config: {
      sandbox: false,
      hostDisplayName: "Dallin",
      hostTimezone: "America/Denver",
      types: [
        {
          key: "intro",
          name: "Intro call",
          description: "A 30-minute walkthrough.",
          durationMinutes: 30,
          media: ["video", "phone", "prospect_hosted"],
        },
      ],
    },
    slots,
    slotRequests: 0,
    holds: [],
    releases: [],
    books: [],
    reschedules: [],
    cancels: [],
    takenOnHold: new Set(),
    failBookOnce: null,
    rescheduleRejectsHeld: false,
    holdNotFoundForManage: false,
    holdMs: 10 * 60_000,
    booking: {
      status: "confirmed",
      start: iso(bookedStart),
      end: iso(bookedStart + 30 * 60_000),
      typeName: "Intro call",
      durationMinutes: 30,
      hostDisplayName: "Dallin",
      hostTimezone: "America/Denver",
      inviteeName: "Ada",
      inviteeTimezone: "America/New_York",
      medium: "video",
      meetingLink: "https://meet.example.com/abc",
      hostPhone: null,
      inviteMailbox: null,
      googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Intro",
      canCancel: true,
      canReschedule: true,
      sandbox: false,
    },
    ...overrides,
  };
}

interface Reply {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  contentType: "application/json",
  headers: { "cache-control": "no-store", ...headers },
  body: JSON.stringify(body),
});

const SHELL =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  '<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body></html>';

/** The fake server's whole behaviour, independent of how the request arrived. */
function respond(fake: Fake, url: URL, body: Record<string, unknown>): Reply {
  const path = url.pathname;
  if (!path.startsWith("/api/booking/")) {
    return { status: 200, contentType: "text/html", body: SHELL };
  }
  const api = path.slice("/api/booking".length);

  if (api === "/v1/config") return json(200, fake.config);
  if (api === "/v1/slots") {
    fake.slotRequests += 1;
    const from = Date.parse(url.searchParams.get("from") ?? "");
    const to = Date.parse(url.searchParams.get("to") ?? "");
    const slots = fake.slots.filter((s) => Date.parse(s.start) >= from && Date.parse(s.start) < to);
    return json(200, { slots, busySync: "ok" });
  }
  if (api === "/v1/hold") {
    fake.holds.push(body);
    if (fake.holdNotFoundForManage && body.manageToken) {
      return json(404, { error: { code: "not_found", message: "not found" } });
    }
    const start = String(body.start);
    if (fake.takenOnHold.has(start)) {
      fake.slots = fake.slots.filter((s) => s.start !== start);
      return json(409, { error: { code: "slot_taken", message: "taken" } });
    }
    const token = `h${fake.holds.length}`;
    return json(200, {
      holdToken: token,
      expiresAt: iso(Date.now() + fake.holdMs),
      start,
      end: iso(Date.parse(start) + 30 * 60_000),
    });
  }
  if (api === "/v1/hold/release") {
    fake.releases.push(String(body.holdToken));
    return json(200, { ok: true });
  }
  if (api === "/v1/book") {
    fake.books.push(body);
    if (fake.failBookOnce) {
      const failure = fake.failBookOnce;
      fake.failBookOnce = null;
      fake.slots = fake.slots.filter((s) => s.start !== body.start);
      return json(failure.status, { error: { code: failure.code, message: failure.code } });
    }
    const start = String(body.start);
    const booking = {
      ...fake.booking,
      status: "confirmed",
      start,
      end: iso(Date.parse(start) + 30 * 60_000),
      inviteeName: body.name,
      inviteeTimezone: body.timezone,
      medium: body.medium,
      meetingLink: body.medium === "video" && !fake.noMeetingLink ? "https://meet.example.com/abc" : null,
      hostPhone: body.medium === "phone" ? "+18015550100" : null,
      inviteMailbox: body.medium === "prospect_hosted" ? "meet@booking.test" : null,
      sandbox: fake.config.sandbox,
    };
    return json(200, { booking, manageToken: "mt_1", manageUrl: `${ORIGIN}/manage/mt_1` });
  }
  const manage = api.match(/^\/v1\/manage\/([^/]+)(\/[a-z]+)?$/);
  if (manage) {
    const noindex = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
    if (manage[1] !== "mt_1") return json(404, { error: { code: "not_found", message: "not found" } }, noindex);
    const action = manage[2] ?? "";
    if (action === "") return json(200, { booking: fake.booking }, noindex);
    if (action === "/ics") {
      return { status: 200, contentType: "text/calendar", body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" };
    }
    if (action === "/cancel") {
      fake.cancels.push(body);
      fake.booking = { ...fake.booking, status: "cancelled", canCancel: false, canReschedule: false };
      return json(200, { booking: fake.booking }, noindex);
    }
    if (action === "/reschedule") {
      fake.reschedules.push(body);
      if (fake.rescheduleRejectsHeld && body.holdToken) {
        return json(409, { error: { code: "slot_taken", message: "own hold counted" } }, noindex);
      }
      const start = String(body.start);
      fake.booking = { ...fake.booking, start, end: iso(Date.parse(start) + 30 * 60_000) };
      return json(200, { booking: fake.booking }, noindex);
    }
  }
  return json(404, { error: { code: "not_found", message: "no route" } });
}

type HostConfig = {
  sandbox?: boolean;
  manage?: string;
  /** Extra <BookingWidget> props (JSON-safe ones). */
  props?: Record<string, unknown>;
  /** Extra <ManageBooking> props. */
  manageProps?: Record<string, unknown>;
  /** Mount <BookingAdmin> over the in-memory adapter, seeded with this. */
  admin?: Record<string, unknown>;
};

async function boot(page: Page, origin: string, bk: HostConfig): Promise<void> {
  await page.goto(`${origin}/`);
  await page.evaluate((cfg) => {
    (window as unknown as { __bk: unknown }).__bk = cfg;
  }, bk);
  await page.addScriptTag({ content: bundle });
}

/** The fake behind page.route on a made-up origin — the default. */
async function mount(page: Page, fake: Fake, bk: HostConfig = {}): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? (request.postDataJSON() as Record<string, unknown>) : {};
    return route.fulfill(respond(fake, new URL(request.url()), body));
  });
  await boot(page, ORIGIN, bk);
}

/** The same fake on a real local socket, for requests page.route cannot see. */
async function serve(fake: Fake): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const reply = respond(fake, new URL(req.url ?? "/", "http://127.0.0.1"), body);
      res.writeHead(reply.status, { "content-type": reply.contentType, ...(reply.headers ?? {}) });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

const timeButtons = (page: Page) => page.locator("button.aibk-time");
const activeText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

async function fillDetails(page: Page, name = "Ada Lovelace", email = "ada@example.com"): Promise<void> {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

test("books a time: a held countdown, the previous hold handed back, a full confirmation", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake);

  await expect(page.getByRole("heading", { name: "Intro call" })).toBeVisible();
  await expect(page.locator(".aibk-zone")).toContainText("New York");
  for (const part of ["Morning", "Afternoon", "Evening"]) {
    await expect(page.getByRole("group", { name: new RegExp(`^${part},`) })).toBeVisible();
  }
  // Nothing on the page took focus before the visitor did anything.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  expect(await activeText(page)).toBe("Your details");
  await expect(page.getByRole("timer")).toHaveText(/Held for (10:00|9:\d\d)/);
  expect(fake.holds[0]).toEqual({ type: "intro", start: fake.slots[0]!.start });

  // Change of mind: the second hold carries the first token.
  await page.getByRole("button", { name: "Change time" }).click();
  expect(await activeText(page)).toBe("Choose a time");
  await timeButtons(page).nth(1).click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  expect(fake.holds[1]).toEqual({ type: "intro", start: fake.slots[1]!.start, previousHoldToken: "h1" });

  // Phone call without a number: the field says so and takes focus.
  await fillDetails(page);
  await page.getByLabel(/Phone call — we call you/).check();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("Enter the number we should call.")).toBeVisible();
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type)).toBe("tel");
  expect(fake.books).toHaveLength(0);

  // A number without its country code is caught before the round trip.
  await page.getByLabel("Phone number").fill("801 555 0143");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText(/Include the country code, like \+1 801 555 0143/)).toBeVisible();
  expect(fake.books).toHaveLength(0);

  await page.getByLabel("Phone number").fill("+1 (801) 555-0143");
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  expect(await activeText(page)).toBe("You're booked");
  expect(fake.books[0]).toMatchObject({
    type: "intro",
    start: fake.slots[1]!.start,
    holdToken: "h2",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+18015550143",
    medium: "phone",
    timezone: "America/New_York",
    source: "e2e",
  });
  // The number as the server stored it (E.164), not as typed — so a number
  // read in the wrong country is visible to the visitor right here.
  await expect(page.getByText("Dallin will call you at +18015550143")).toBeVisible();
  await expect(page.getByText("The call will come from +18015550100.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Add to Google Calendar/ })).toHaveAttribute(
    "href",
    fake.booking.googleCalendarUrl as string,
  );
  await expect(page.getByRole("link", { name: "Download .ics" })).toHaveAttribute("href", "/api/booking/v1/manage/mt_1/ics");
  await expect(page.getByRole("link", { name: "Reschedule or cancel" })).toHaveAttribute("href", `${ORIGIN}/manage/mt_1`);
  expect(await page.evaluate(() => (window as unknown as { __booked: unknown[] }).__booked.length)).toBe(1);
  // h1 went back inside the second hold request; h2 became the booking. Neither
  // may be "released" afterwards — releasing a converted hold would be a bug.
  expect(fake.releases).toEqual([]);
});

test("a time taken on hold: said plainly, times refetched, the taken time gone", async ({ page }) => {
  const fake = makeFake();
  const taken = fake.slots[0]!.start;
  fake.takenOnHold.add(taken);
  await mount(page, fake);

  await expect(timeButtons(page).first()).toBeVisible();
  const before = fake.slotRequests;
  await timeButtons(page).first().click();
  await expect(page.getByRole("alert")).toContainText("Someone just booked that time");
  await expect.poll(() => fake.slotRequests).toBeGreaterThan(before);
  await expect(page.locator(`button.aibk-time[data-start="${taken}"]`)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your details" })).toHaveCount(0);
});

test("a time taken at booking: back to the picker, hold released, everything typed kept", async ({ page }) => {
  const fake = makeFake({ failBookOnce: { status: 409, code: "slot_taken" } });
  await mount(page, fake);

  await timeButtons(page).first().click();
  await fillDetails(page, "Grace Hopper", "grace@example.com");
  await page.getByLabel(/Anything we should know/).fill("Bring the compiler");
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("alert")).toContainText("Someone just booked that time");
  await expect(page.getByRole("heading", { name: "Choose a time" })).toBeVisible();
  await expect.poll(() => fake.releases).toEqual(["h1"]);

  await timeButtons(page).first().click();
  await expect(page.getByLabel("Name")).toHaveValue("Grace Hopper");
  await expect(page.getByLabel("Email")).toHaveValue("grace@example.com");
  await expect(page.getByLabel(/Anything we should know/)).toHaveValue("Bring the compiler");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  expect(fake.books[1]).toMatchObject({ holdToken: "h2", notes: "Bring the compiler", medium: "video" });
});

test("a form sent twice: told the first one booked, kept on the form, the hold not released", async ({ page }) => {
  const fake = makeFake({ failBookOnce: { status: 409, code: "already_booked" } });
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);
  const slotRequestsBefore = fake.slotRequests;
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("alert")).toContainText("You're already booked for this time");
  await expect(page.getByRole("alert")).toContainText("Check your email");
  // Not a lost time: no trip back to the picker, no refetch.
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  expect(fake.slotRequests).toBe(slotRequestsBefore);
  // The hold became the first booking; releasing it would be a bug.
  expect(fake.releases).toEqual([]);
});

test("a number without + is read in the calling code the server advertises", async ({ page }) => {
  const fake = makeFake();
  fake.config.defaultCallingCode = "1";
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);
  await page.getByLabel(/Phone call — we call you/).check();
  await expect(page.getByText("Outside +1? Start with + and the country code.")).toBeVisible();
  await page.getByLabel("Phone number").fill("801 555 0143");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  expect(fake.books[0]).toMatchObject({ phone: "+18015550143", medium: "phone" });
});

test("the date strip runs exactly to the type's horizon when the server sends it", async ({ page }) => {
  const fake = makeFake();
  // The host in the viewer's own zone, so the day count is exact whatever the hour.
  fake.config.hostTimezone = "America/New_York";
  fake.config.types[0]!.horizonDays = 5;
  await mount(page, fake);
  await expect(timeButtons(page).first()).toBeVisible();
  // It starts at the first day that has a time (no run of dead tiles up
  // front) and ends exactly at the horizon's last day: today + 4 here.
  const firstDay = nyDate(Date.parse(fake.slots[0]!.start));
  const lastDay = nyDate(Date.now() + 4 * DAY);
  const tiles = page.locator("button.aibk-day");
  await expect(tiles).toHaveCount(dayCount(firstDay, lastDay));
  await expect(tiles.first()).toHaveAttribute("data-date", firstDay);
  await expect(tiles.last()).toHaveAttribute("data-date", lastDay);
  await expect(page.getByRole("button", { name: "Show later dates" })).toHaveCount(0);
});

test("switching zones re-cuts the same instants onto the new clock", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake);
  const first = timeButtons(page).first();
  await expect(first).toBeVisible();
  const start = await first.getAttribute("data-start");
  const newYorkLabel = (await first.textContent())?.trim();

  await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
  await expect(page.locator(".aibk-zone")).toContainText("Tokyo");
  const sameInstant = page.locator(`button.aibk-time[data-start="${start}"]`);
  await expect(sameInstant).toBeVisible();
  const tokyoLabel = (await sameInstant.textContent())?.trim();
  expect(tokyoLabel).not.toBe(newYorkLabel);
  // 14:00 UTC is 11:00 PM in Tokyo: the evening group.
  await expect(page.getByRole("group", { name: /^Evening,/ }).locator(`[data-start="${start}"]`)).toHaveCount(1);

  await sameInstant.click();
  await fillDetails(page);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  expect(fake.books[0]).toMatchObject({ timezone: "Asia/Tokyo", start });
});

test("leaving the page releases the hold", async ({ page }) => {
  const fake = makeFake();
  const { origin, server } = await serve(fake);
  try {
    await boot(page, origin, {});
    await timeButtons(page).first().click();
    await expect(page.getByRole("timer")).toBeVisible();
    await page.goto(`${origin}/elsewhere`);
    await expect.poll(() => fake.releases, { timeout: 5_000 }).toEqual(["h1"]);
  } finally {
    server.close();
  }
});

test("a hold that runs out offers to hold the time again", async ({ page }) => {
  const fake = makeFake({ holdMs: 2_500 });
  await mount(page, fake);
  await timeButtons(page).first().click();
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Your hold ran out", { timeout: 6_000 });
  fake.holdMs = 10 * 60_000;
  await page.getByRole("button", { name: "Hold it again" }).click();
  await expect(page.getByRole("timer")).toHaveText(/Held for (10:00|9:\d\d)/);
  expect(fake.holds[1]).toMatchObject({ start: fake.slots[0]!.start, previousHoldToken: "h1" });
});

test("sandbox: a persistent banner, labelled times, a preview confirmation and the real CTA", async ({ page }) => {
  const fake = makeFake();
  fake.config.sandbox = true;
  await mount(page, fake);

  const banner = page.locator("[data-aibk-sandbox]");
  await expect(banner).toContainText("Nothing is booked, nobody is emailed, and Dallin doesn't see it.");
  await expect(page.getByText("Sample times · sandbox")).toBeVisible();
  await timeButtons(page).first().click();
  await expect(banner).toBeVisible();
  await fillDetails(page);
  await page.getByRole("button", { name: "Confirm booking (sandbox)" }).click();

  await expect(page.getByRole("heading", { name: "This is what your customer would see" })).toBeVisible();
  await expect(banner).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happens on a real booking" })).toBeVisible();
  await expect(page.locator(".aibk-real li")).toHaveCount(4);
  const cta = page.locator("[data-aibk-real-cta]");
  await expect(cta).toHaveText("Book a real call with Dallin →");
  await expect(cta).toHaveAttribute("href", "/real");

  await page.getByRole("button", { name: "Try another time in the sandbox" }).click();
  await expect(page.getByRole("heading", { name: "Choose a time" })).toBeVisible();
});

test("works at 390px: no sideways scroll or clipped content, 44px touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fake = makeFake();
  fake.config.sandbox = true; // the banner and the "sample times" tag are the widest rows
  await mount(page, fake);
  await expect(timeButtons(page).first()).toBeVisible();

  // The page must not scroll sideways, AND nothing inside the card may be wider
  // than the card: the card clips its overflow, so a too-wide row would not
  // show up as page scroll — it would just be cut off (the zone select was).
  const overflow = () =>
    page.evaluate(() => {
      const worst = [".aibk-root", ".aibk-body", ".aibk-section", ".aibk-zone", ".aibk-section-head"]
        .flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
        .map((el) => el.scrollWidth - el.clientWidth);
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, ...worst);
    });
  expect(await overflow()).toBeLessThanOrEqual(0);
  const select = await page.getByLabel("Time zone").boundingBox();
  expect(select!.x + select!.width).toBeLessThanOrEqual(390 - 16);
  const heights = await page.$$eval("button.aibk-time, button.aibk-day:not(:disabled)", (els) =>
    els.map((el) => el.getBoundingClientRect().height),
  );
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);

  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  const targets = await page.$$eval(".aibk-root input.aibk-input, .aibk-root .aibk-btn, .aibk-root label.aibk-medium", (els) =>
    els.map((el) => el.getBoundingClientRect().height),
  );
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
});

// ---------------------------------------------------------------------------
// Manage
// ---------------------------------------------------------------------------

test("manage: reschedule with a hold, then cancel with a reason", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake, { manage: "mt_1" });

  await expect(page.getByRole("heading", { name: "Your intro call" })).toBeVisible();
  await expect(page.getByText("Confirmed")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download .ics" })).toHaveAttribute("href", "/api/booking/v1/manage/mt_1/ics");

  await page.getByRole("button", { name: "Pick another time" }).click();
  await expect(page.getByRole("heading", { name: "Pick a new time" })).toBeVisible();
  await expect.poll(() => activeText(page)).toBe("Pick a new time");
  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Move your booking?" })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await page.getByRole("button", { name: "Move my booking" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Moved to" })).toBeVisible();
  expect(fake.reschedules[0]).toEqual({ start: fake.slots[0]!.start, holdToken: "h1" });
  expect(fake.releases).toEqual([]);

  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByLabel(/Anything we should know/).fill("Found another time");
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.getByRole("heading", { name: "Your intro call is cancelled" })).toBeVisible();
  expect(fake.cancels[0]).toEqual({ reason: "Found another time" });
  await expect(page.getByRole("link", { name: "Book a new time" })).toHaveAttribute("href", "/real");
  await expect(page.getByRole("button", { name: "Pick another time" })).toHaveCount(0);
});

test("manage: the picker asks as the booking — its typeKey, and its manage token on slots and hold", async ({ page }) => {
  const fake = makeFake();
  fake.config.types.push({ key: "deep", name: "Deep dive", description: null, durationMinutes: 60, media: ["video"] });
  // The booking's name and duration point at "intro"; its typeKey says "deep" — the key wins.
  fake.booking = { ...fake.booking, typeKey: "deep" };
  const slotQueries: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/v1/slots")) slotQueries.push(url.searchParams);
  });
  await mount(page, fake, { manage: "mt_1" });

  await page.getByRole("button", { name: "Pick another time" }).click();
  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Move your booking?" })).toBeVisible();
  expect(slotQueries.length).toBeGreaterThan(0);
  expect(slotQueries.map((query) => [query.get("type"), query.get("manage")])).toEqual(
    slotQueries.map(() => ["deep", "mt_1"]),
  );
  expect(fake.holds[0]).toEqual({ type: "deep", start: fake.slots[0]!.start, manageToken: "mt_1" });

  await page.getByRole("button", { name: "Move my booking" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to" })).toBeVisible();
  expect(fake.reschedules[0]).toEqual({ start: fake.slots[0]!.start, holdToken: "h1" });
});

test("manage: a hold for a booking that can no longer move re-reads it and shows where it stands", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake, { manage: "mt_1" });
  await page.getByRole("button", { name: "Pick another time" }).click();
  await expect(timeButtons(page).first()).toBeVisible();
  // Cancelled elsewhere (another tab, or the host) while this page sat open.
  fake.booking = { ...fake.booking, status: "cancelled", canCancel: false, canReschedule: false };
  fake.holdNotFoundForManage = true;
  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Your intro call is cancelled" })).toBeVisible();
  expect(fake.holds.at(-1)).toMatchObject({ manageToken: "mt_1" });
  await expect(page.getByRole("button", { name: "Pick another time" })).toHaveCount(0);
});

test("manage: a server that counts the visitor's own hold as busy still lets them move", async ({ page }) => {
  const fake = makeFake({ rescheduleRejectsHeld: true });
  await mount(page, fake, { manage: "mt_1" });
  await page.getByRole("button", { name: "Pick another time" }).click();
  await timeButtons(page).first().click();
  await page.getByRole("button", { name: "Move my booking" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to" })).toBeVisible();
  expect(fake.reschedules).toEqual([{ start: fake.slots[0]!.start, holdToken: "h1" }, { start: fake.slots[0]!.start }]);
  expect(fake.releases).toEqual(["h1"]);
});

test("manage: an unknown link gets the not-found page, saying nothing about why", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake, { manage: "nope" });
  await expect(page.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Book a new time" })).toHaveAttribute("href", "/real");
});

test("manage: a past call and a still-unconfirmed request each say so, with the right actions", async ({ page }) => {
  const fake = makeFake();
  const pastStart = Date.now() - 3 * DAY;
  fake.booking = { ...fake.booking, start: iso(pastStart), end: iso(pastStart + 30 * 60_000) };
  await mount(page, fake, { manage: "mt_1" });
  await expect(page.getByRole("heading", { name: "Your intro call has already happened" })).toBeVisible();
  await expect(page.getByText("Past", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pick another time" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download .ics" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Book a new time" })).toBeVisible();

  const requested = makeFake();
  requested.booking = { ...requested.booking, status: "requested" };
  await page.unrouteAll();
  await mount(page, requested, { manage: "mt_1" });
  await expect(page.getByText("Awaiting confirmation")).toBeVisible();
  await expect(page.getByText("Dallin still has to confirm this time.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pick another time" })).toBeVisible();
});

test("several types: a type picker, and switching type hands the hold back", async ({ page }) => {
  const fake = makeFake();
  fake.config.types.push({ key: "deep", name: "Deep dive", description: "An hour on your setup.", durationMinutes: 60, media: ["video"] });
  const slotTypes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/v1/slots")) slotTypes.push(url.searchParams.get("type") ?? "");
  });
  await mount(page, fake);

  await expect(page.getByRole("heading", { name: "Book time with Dallin" })).toBeVisible();
  const intro = page.getByRole("button", { name: /Intro call/ });
  const deep = page.getByRole("button", { name: /Deep dive/ });
  await expect(intro).toHaveAttribute("aria-pressed", "true");
  await timeButtons(page).first().click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  await page.getByRole("button", { name: "Change time" }).click();

  await deep.click();
  await expect(deep).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => fake.releases).toEqual(["h1"]);
  await expect.poll(() => slotTypes.at(-1)).toBe("deep");
  await timeButtons(page).first().click();
  expect(fake.holds.at(-1)).toEqual({ type: "deep", start: fake.slots[0]!.start });
  await expect(page.getByRole("radio")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Review round 2: phone numbers, honest copy without email, the sandbox,
// the date strip — and the admin screens
// ---------------------------------------------------------------------------

async function bookByPhone(page: Page, phone: string): Promise<void> {
  await page.getByLabel(/Phone call — we call you/).check();
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: /^Confirm booking/ }).click();
}

test("phone with code 1: a UK number missing its code is refused, 011 dials abroad, and the confirmation shows what was stored", async ({
  page,
}) => {
  const fake = makeFake();
  fake.config.defaultCallingCode = "1";
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);

  // Negative control for the review's bug: this used to be stored as
  // +12079460958 — a valid-looking Maine number — and booked.
  await bookByPhone(page, "020 7946 0958");
  await expect(page.getByText("US and Canadian numbers don't start with 0.", { exact: false })).toBeVisible();
  expect(fake.books).toHaveLength(0);

  await bookByPhone(page, "011 44 20 7946 0958");
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  expect(fake.books[0]).toMatchObject({ phone: "+442079460958", medium: "phone" });
  await expect(page.getByText("Dallin will call you at +442079460958")).toBeVisible();
  await expect(page.getByText("011 44 20 7946 0958")).toHaveCount(0);
});

test("no email: the confirmation hands over the private link to copy and promises no inbox", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  const fake = makeFake({ noMeetingLink: true });
  fake.config.emailsEnabled = false;
  fake.config.contactEmail = "hello@booking.test";
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
  const field = page.getByLabel("Your private link");
  await expect(field).toHaveValue(`${ORIGIN}/manage/mt_1`);
  await expect(field).toHaveAttribute("readonly", "");
  await expect(
    page.getByText("This is the only way to move or cancel. Bookmark it, or add the call to your calendar (the link is inside)."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy your private link" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/manage/mt_1`);
  // Video with no link saved: who sends it, not where.
  await expect(page.getByText("Dallin will send you the link before the call.")).toBeVisible();
  const text = await page.locator("[data-aibk-confirmation]").innerText();
  expect(text).not.toMatch(/on its way|confirmation email|check your email|link is in your/i);
});

test("no email: a form sent twice points at a person, not at an inbox", async ({ page }) => {
  const fake = makeFake({ failBookOnce: { status: 409, code: "already_booked" } });
  fake.config.emailsEnabled = false;
  fake.config.contactEmail = "hello@booking.test";
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("You're already booked for this time. To move or cancel it, email hello@booking.test.");
  await expect(alert).not.toContainText("Check your email");
});

test("no email: the manage page never sends anyone to a confirmation email", async ({ page }) => {
  // An unknown link.
  const unknown = makeFake();
  unknown.config.emailsEnabled = false;
  unknown.config.contactEmail = "hello@booking.test";
  await mount(page, unknown, { manage: "nope" });
  const notFound = page.locator('[data-aibk-state="not_found"]');
  await expect(notFound).toContainText("Check you copied all of it.");
  await expect(notFound).toContainText("If you need a hand, email hello@booking.test.");
  await expect(notFound.getByRole("link", { name: "hello@booking.test" })).toHaveAttribute("href", "mailto:hello@booking.test");
  await expect(notFound).not.toContainText("from the email again");

  // A booking the page can no longer change.
  const locked = makeFake();
  locked.config.emailsEnabled = false;
  locked.booking = { ...locked.booking, canCancel: false, canReschedule: false };
  await page.unrouteAll();
  await mount(page, locked, { manage: "mt_1" });
  await expect(page.getByText("This booking can't be changed online any more. To change it, contact Dallin directly.")).toBeVisible();
  await expect(page.getByText(/reply to your confirmation email/)).toHaveCount(0);

  // A request still waiting on the host.
  const requested = makeFake();
  requested.config.emailsEnabled = false;
  requested.booking = { ...requested.booking, status: "requested" };
  await page.unrouteAll();
  await mount(page, requested, { manage: "mt_1" });
  await expect(page.getByText("Dallin still has to confirm this time. This page shows it as soon as they do.")).toBeVisible();

  // Negative control: with email on, the old pointer is right and stays.
  const withEmail = makeFake();
  withEmail.booking = { ...withEmail.booking, canCancel: false, canReschedule: false };
  await page.unrouteAll();
  await mount(page, withEmail, { manage: "mt_1" });
  await expect(page.getByText("To change it, reply to your confirmation email.", { exact: false })).toBeVisible();
});

test("sandbox: calendar exports say sandbox, and the preview card says what a REAL booking would send", async ({ page }) => {
  const fake = makeFake();
  fake.config.sandbox = true;
  await mount(page, fake);
  await timeButtons(page).first().click();
  await fillDetails(page);
  await page.getByRole("button", { name: "Confirm booking (sandbox)" }).click();
  await expect(page.getByRole("heading", { name: "This is what your customer would see" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Add sandbox event to Google Calendar/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download sandbox .ics" })).toHaveAttribute("download", "sandbox-booking.ics");
  await expect(page.getByRole("link", { name: /^Add to Google Calendar/ })).toHaveCount(0);
  await expect(page.getByText("In a real booking, a confirmation goes to ada@example.com.")).toBeVisible();
  await expect(page.getByText(/A confirmation is on its way/)).toHaveCount(0);
});

test("sandbox manage link opened elsewhere: still the sandbox, the real CTA labelled as real, and a way back to the demo", async ({
  page,
}) => {
  const fake = makeFake();
  fake.config.sandbox = true;
  // "nope": what a sandbox token looks like from another browser or a day later.
  await mount(page, fake, { manage: "nope", manageProps: { sandbox: true, sandboxHref: "/demo" } });
  await expect(page.locator("[data-aibk-sandbox]")).toBeVisible();
  await expect(
    page.getByText("Sandbox calls only open in the browser that booked them, for 24 hours. Nothing real was booked."),
  ).toBeVisible();
  const real = page.locator("[data-aibk-real-cta]");
  await expect(real).toHaveText("Book a real call with Dallin →");
  await expect(real).toHaveAttribute("href", "/real");
  await expect(page.getByRole("link", { name: "Try the demo again" })).toHaveAttribute("href", "/demo");
  // Negative control for the review's bug: "Book a new time" into the real calendar.
  await expect(page.getByRole("link", { name: "Book a new time" })).toHaveCount(0);
  await expect(page.getByText(/from the email again/)).toHaveCount(0);
});

test("the date strip: earlier/later buttons for mouse users, disabled at the ends, starting at the first open day", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fake = makeFake();
  fake.config.hostTimezone = "America/New_York";
  fake.config.types[0]!.horizonDays = 22;
  fake.slots = Array.from({ length: 20 }, (_, i) => {
    const start = utcDay(i + 2) + 15 * 3_600_000;
    return { start: iso(start), end: iso(start + 30 * 60_000) };
  });
  await mount(page, fake);
  await expect(timeButtons(page).first()).toBeVisible();

  const tiles = page.locator("button.aibk-day");
  await expect(tiles.first()).toHaveAttribute("data-date", nyDate(Date.parse(fake.slots[0]!.start)));
  const earlier = page.getByRole("button", { name: "Earlier days" });
  const later = page.getByRole("button", { name: "Later days" });
  await expect(earlier).toBeVisible();
  await expect(earlier).toBeDisabled();
  await expect(later).toBeEnabled();
  for (const button of [earlier, later]) {
    const box = await button.boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  }

  const scrollLeft = () => page.locator("ul.aibk-days").evaluate((list) => list.scrollLeft);
  const width = await page.locator("ul.aibk-days").evaluate((list) => list.clientWidth);
  await later.click();
  await expect.poll(scrollLeft).toBeGreaterThan(width * 0.8);
  await expect(earlier).toBeEnabled();
  for (let i = 0; i < 6; i += 1) {
    // Re-measured on the strip's scroll event: give it a frame before asking.
    await page.waitForTimeout(150);
    if (await later.isDisabled()) break;
    await later.click();
  }
  await expect(later).toBeDisabled();
  const last = await tiles.last().boundingBox();
  const list = await page.locator("ul.aibk-days").boundingBox();
  expect(last!.x + last!.width).toBeLessThanOrEqual(list!.x + list!.width + 1);
  await earlier.click();
  await expect(later).toBeEnabled();
});

test("a page that already pitches the call can retitle the widget and drop the repeated description", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake, { props: { title: "Pick a time", hideDescription: true } });
  await expect(page.getByRole("heading", { name: "Pick a time" })).toBeVisible();
  await expect(timeButtons(page).first()).toBeVisible();
  await expect(page.getByText("A 30-minute walkthrough.")).toHaveCount(0);

  // Negative control: by default the description is there.
  await page.unrouteAll();
  await mount(page, makeFake());
  await expect(page.getByText("A 30-minute walkthrough.")).toBeVisible();
});

test("a focused step heading keeps clear of a sticky header (--aibk-scroll-margin)", async ({ page }) => {
  const fake = makeFake();
  await mount(page, fake);
  await timeButtons(page).first().click();
  const heading = page.getByRole("heading", { name: "Your details" });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe("96px");
  await page.evaluate(() => document.documentElement.style.setProperty("--aibk-scroll-margin", "40px"));
  expect(await heading.evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe("40px");
});

// ---------------------------------------------------------------------------
// <BookingAdmin>
// ---------------------------------------------------------------------------

function adminBooking(id: string, startMs: number, status: string, name: string, email: string): Record<string, unknown> {
  return {
    id,
    typeKey: "intro",
    typeName: "Intro call",
    hostId: "h1",
    hostDisplayName: "Dallin",
    status,
    start: iso(startMs),
    end: iso(startMs + 30 * 60_000),
    hostTimezone: "America/Denver",
    inviteeTimezone: "America/New_York",
    inviteeName: name,
    inviteeEmail: email,
    inviteePhone: null,
    inviteeCompany: null,
    notes: null,
    medium: "video",
    source: "e2e",
    sequence: 0,
    cancelledBy: null,
    cancelReason: null,
    outcome: null,
  };
}

const ADMIN_FUTURE = utcDay(3) + 18 * 3_600_000;

function adminSeed(over: { emailsEnabled?: boolean; rescheduleFails?: boolean } = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    emailsEnabled: over.emailsEnabled ?? false,
    hoursAreDefault: true,
    holds: 2,
    rescheduleFails: over.rescheduleFails ?? false,
    hosts: [
      {
        id: "h1",
        displayName: "Dallin",
        email: "dallin@booking.test",
        timezone: "America/Denver",
        meetingLink: null,
        phone: null,
        inviteMailbox: null,
        busyIcsUrl: null,
        busySync: { error: null, failingSince: null, okAt: null },
        hasFeedToken: false,
        autoConfirm: true,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    types: [
      {
        id: "t1",
        key: "intro",
        name: "Intro call",
        description: "A 30-minute walkthrough.",
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
        stepMinutes: 30,
        minNoticeMinutes: 720,
        horizonDays: 21,
        maxPerDay: null,
        media: ["video", "phone"],
        hostIds: [],
        isActive: true,
        sortOrder: 0,
      },
    ],
    blackouts: [],
    weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 600, endMinute: 960 })),
    exceptions: [],
    events: { "b-future": [{ id: 1, kind: "booked", actor: "invitee", detail: null, at: iso(now - DAY) }] },
    bookings: [
      adminBooking("b-future", ADMIN_FUTURE, "confirmed", "Ada Lovelace", "ada@example.com"),
      adminBooking("b-now", now - 10 * 60_000, "confirmed", "Charles Babbage", "charles@example.com"),
      adminBooking("b-req", utcDay(4) + 20 * 3_600_000, "requested", "Grace Hopper", "grace@example.com"),
    ],
    // The call's own time (must be hidden by the picker) and three others.
    slots: [ADMIN_FUTURE, utcDay(4) + 18 * 3_600_000, utcDay(4) + 19 * 3_600_000, utcDay(5) + 18 * 3_600_000].map((start) => ({
      start: iso(start),
      end: iso(start + 30 * 60_000),
    })),
  };
}

const mountAdmin = (page: Page, seed: Record<string, unknown>) => mount(page, makeFake(), { admin: seed });

const adminCalls = (page: Page, name: string) =>
  page.evaluate(
    (callName) =>
      (window as unknown as { __admin: { calls: Array<{ name: string; input: unknown }> } }).__admin.calls
        .filter((call) => call.name === callName)
        .map((call) => call.input),
    name,
  );

test("admin: Finish setting up names what's unfinished, jumps to each fix, and clears as they're done", async ({ page }) => {
  await mountAdmin(page, adminSeed());
  const checklist = page.locator("[data-aibk-checklist]");
  await expect(checklist).toContainText("People who choose video are promised a link");
  await expect(checklist).toContainText("Your real calendar isn't connected");
  await expect(checklist).toContainText("placeholder defaults");
  await expect(checklist).toContainText("Booked calls won't show up in your calendar");
  await expect(checklist).toContainText("Emails aren't set up");
  // Holds are visible, so a calendar kept full of them is not silent.
  await expect(page.getByText("2 times are held right now")).toBeVisible();

  await page.getByRole("button", { name: "Add your meeting link" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => activeText(page)).toBe("You, as the host");
  const hostCard = page.locator('[data-aibk-card="host"]');
  await hostCard.getByLabel("Meeting link (video calls)").fill("https://meet.example.com/new");
  await hostCard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(checklist).not.toContainText("People who choose video");
  expect((await adminCalls(page, "upsertHost"))[0]).toMatchObject({ id: "h1", meetingLink: "https://meet.example.com/new" });

  await page.getByRole("button", { name: "Get your feed link" }).click();
  await expect.poll(() => activeText(page)).toBe("Your calls in your calendar");
  await page.getByRole("button", { name: "Generate feed link" }).click();
  await expect(page.getByLabel(/Your feed link/)).toHaveValue(/\/v1\/feed\/tok\d+\.ics$/);
  await expect(checklist).not.toContainText("Booked calls won't show up");
  await expect(page.getByRole("button", { name: "Make a new link (stops the old one)" })).toBeVisible();

  await page.getByRole("button", { name: "Set your hours" }).click();
  await expect(page.getByRole("tab", { name: "Availability" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => activeText(page)).toBe("Your week");
  await page.getByRole("button", { name: "Add hours on Saturday" }).click();
  await page.getByRole("button", { name: "Save week" }).click();
  await expect(checklist).not.toContainText("placeholder defaults");
  expect((await adminCalls(page, "setWeekly"))[0]).toMatchObject({ hostId: "h1" });
  // What only the server can fix stays listed.
  await expect(checklist).toContainText("Your real calendar isn't connected");
  await expect(checklist).toContainText("Emails aren't set up");
});

test("admin: calls — outcome only once a call has started, and no-email buttons that say so", async ({ page }) => {
  await mountAdmin(page, adminSeed({ emailsEnabled: false }));
  const future = page.locator('[data-aibk-booking="b-future"]');
  const live = page.locator('[data-aibk-booking="b-now"]');
  const request = page.locator('[data-aibk-booking="b-req"]');
  await expect(future).toBeVisible();
  // The review's bug: "Outcome" on a call that hadn't happened reopened its slot.
  await expect(future.getByRole("button", { name: "Record outcome" })).toHaveCount(0);
  await expect(live.getByRole("button", { name: "Record outcome" })).toBeVisible();
  await expect(live.getByRole("button", { name: "Move call" })).toHaveCount(0);

  await expect(request.getByRole("button", { name: "Confirm", exact: true })).toBeVisible();
  await expect(request.getByRole("link", { name: "Email grace@example.com" })).toHaveAttribute("href", /^mailto:grace@example\.com\?subject=/);
  await request.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => adminCalls(page, "confirmBooking")).toEqual(["b-req"]);

  await future.getByRole("button", { name: "Cancel call" }).click();
  const cancel = future.getByRole("button", { name: "Cancel the call", exact: true });
  await expect(cancel).toBeVisible();
  await expect(future.getByText(/and email them/)).toHaveCount(0);
  await future.getByLabel(/^Why \(optional/).fill("Travel came up");
  await expect(future.getByRole("link", { name: "Email ada@example.com" })).toHaveAttribute("href", /body=Travel%20came%20up/);
  await cancel.click();
  await expect.poll(() => adminCalls(page, "cancelBooking")).toEqual([{ id: "b-future", reason: "Travel came up" }]);
  await expect(future).toContainText("Cancelled by you — “Travel came up”");

  await live.getByRole("button", { name: "Record outcome" }).click();
  await live.getByLabel("How it went").fill("won");
  await live.getByLabel("Mark the call").selectOption("completed");
  await live.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => adminCalls(page, "setOutcome")).toEqual([{ id: "b-now", outcome: "won", status: "completed" }]);
  await expect(live).toContainText("Completed");

  await live.getByRole("button", { name: "History" }).click();
  await expect(live.locator('[data-aibk-panel="history"]')).toBeVisible();
});

test("admin: with email wired, the buttons say they email — the negative control", async ({ page }) => {
  await mountAdmin(page, adminSeed({ emailsEnabled: true }));
  const future = page.locator('[data-aibk-booking="b-future"]');
  await expect(page.locator('[data-aibk-booking="b-req"]').getByRole("button", { name: "Confirm and email them" })).toBeVisible();
  await future.getByRole("button", { name: "Cancel call" }).click();
  await expect(future.getByRole("button", { name: "Cancel the call and email them" })).toBeVisible();
  await expect(future.getByText("A note for Ada Lovelace (optional, it goes in the email)")).toBeVisible();
  await expect(future.locator("[data-aibk-tell-them]")).toHaveCount(0);
  await expect(page.locator("[data-aibk-checklist]")).not.toContainText("Emails aren't set up");
});

test("admin: move a call with the invitee's own picker; a time taken meanwhile is said and refreshed", async ({ page }) => {
  await mountAdmin(page, adminSeed({ emailsEnabled: true, rescheduleFails: true }));
  const future = page.locator('[data-aibk-booking="b-future"]');
  await future.getByRole("button", { name: "Move call" }).click();
  await expect(future.getByRole("heading", { name: "Pick the new time" })).toBeVisible();
  const times = future.locator("button.aibk-time");
  await expect(times.first()).toBeVisible();
  // The call's own time is not offered as somewhere to move it.
  await expect(future.locator(`button.aibk-time[data-start="${iso(ADMIN_FUTURE)}"]`)).toHaveCount(0);
  expect((await adminCalls(page, "listRescheduleSlots"))[0]).toMatchObject({ id: "b-future", typeKey: "intro" });

  const asked = (await adminCalls(page, "listRescheduleSlots")).length;
  await times.first().click();
  await future.getByRole("button", { name: "Move the call and email them" }).click();
  await expect(future.getByRole("alert")).toContainText("That time was just taken. Pick another.");
  await expect.poll(async () => (await adminCalls(page, "listRescheduleSlots")).length).toBeGreaterThan(asked);

  const target = await times.first().getAttribute("data-start");
  await times.first().click();
  await future.getByRole("button", { name: "Move the call and email them" }).click();
  await expect.poll(async () => (await adminCalls(page, "rescheduleBooking")).at(-1)).toEqual({ id: "b-future", start: target });
  await expect(future).toContainText("Moved 1×");
});

test("admin: a week off is one entry — added with Until, listed as one row, removed in one click; holidays take ranges too", async ({
  page,
}) => {
  await mountAdmin(page, adminSeed());
  await page.getByRole("tab", { name: "Availability" }).click();
  const timeOff = page.locator('[data-aibk-card="timeoff"]');
  await timeOff.getByLabel("Date", { exact: true }).fill("2026-10-12");
  await timeOff.getByLabel("Until (optional)").fill("2026-10-18");
  await timeOff.getByLabel(/^Note/).fill("Vacation");
  await timeOff.getByRole("button", { name: "Add 7 days" }).click();
  await expect
    .poll(async () => (await adminCalls(page, "addException")).map((call) => (call as { date: string }).date))
    .toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  expect((await adminCalls(page, "addException"))[0]).toMatchObject({ hostId: "h1", kind: "off", note: "Vacation" });
  const rows = timeOff.locator("[data-aibk-exception]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days");
  await rows.first().getByRole("button", { name: "Remove all 7" }).click();
  await expect.poll(async () => (await adminCalls(page, "removeException")).length).toBe(7);
  await expect(rows).toHaveCount(0);

  const holidays = page.locator('[data-aibk-card="holidays"]');
  await holidays.getByLabel("Date", { exact: true }).fill("2099-12-24");
  await holidays.getByLabel("Until (optional)").fill("2099-12-26");
  await holidays.getByLabel("Label").fill("Holidays");
  await holidays.getByRole("button", { name: "Add 3 holidays" }).click();
  await expect(holidays.locator("[data-aibk-holiday]")).toHaveCount(1);
  await expect(holidays.locator("[data-aibk-holiday]")).toContainText("· Holidays · 3 days");
  expect(await adminCalls(page, "addBlackout")).toEqual([
    { date: "2099-12-24", label: "Holidays" },
    { date: "2099-12-25", label: "Holidays" },
    { date: "2099-12-26", label: "Holidays" },
  ]);
});

test("admin: settings tell the truth about the host email and all-day events; calendar and call type save", async ({ page }) => {
  await mountAdmin(page, adminSeed());
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(
    page.getByText(
      "Where notices go. Also shown to invitees as the organizer in calendar files, and as the invite address unless you set an invite mailbox below.",
    ),
  ).toBeVisible();
  await expect(page.locator("[data-aibk-allday-note]")).toContainText("All-day events only block bookings when they're set to Busy in Google");

  const calendar = page.locator('[data-aibk-card="calendar"]');
  await calendar.getByLabel("Paste the secret address").fill("https://calendar.google.com/calendar/ical/x/private-y/basic.ics");
  await calendar.getByRole("button", { name: "Save address" }).click();
  await expect(calendar).toContainText("https://calendar.google.com/…ics ✓");
  await calendar.getByRole("button", { name: "Test", exact: true }).click();
  await expect(calendar.getByText("It works: 3 busy blocks in the next two weeks.")).toBeVisible();
  await expect(page.locator("[data-aibk-checklist]")).not.toContainText("Your real calendar isn't connected");

  const type = page.locator('[data-aibk-card="type-intro"]');
  await type.getByLabel("Length").selectOption("45");
  await type.getByLabel("Minimum notice").fill("24");
  await type.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => adminCalls(page, "upsertType"))
    .toEqual([
      expect.objectContaining({
        id: "t1",
        key: "intro",
        durationMinutes: 45,
        minNoticeMinutes: 1440,
        stepMinutes: 30,
        media: ["video", "phone"],
        hostIds: [],
        isActive: true,
      }),
    ]);
});

test("admin: a real tablist (arrow keys), and every tab holds at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountAdmin(page, adminSeed());
  const upcoming = page.getByRole("tab", { name: "Upcoming" });
  await expect(upcoming).toHaveAttribute("aria-selected", "true");
  await upcoming.focus();
  await page.keyboard.press("ArrowRight");
  const past = page.getByRole("tab", { name: "Past" });
  await expect(past).toHaveAttribute("aria-selected", "true");
  await expect(past).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Settings" })).toBeFocused();
  // All four tabs on one row at 390px.
  const tops = await page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);

  const overflow = () =>
    page.evaluate(() => {
      const worst = [".aibk-admin", ".aibk-card", ".aibk-booking", ".aibk-panel", ".aibk-section"]
        .flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
        .map((el) => el.scrollWidth - el.clientWidth);
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, ...worst);
    });
  for (const name of ["Upcoming", "Availability", "Settings"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.locator(".aibk-tabpanel")).toBeVisible();
    await page.waitForTimeout(100);
    expect(await overflow(), name).toBeLessThanOrEqual(0);
  }
  // The Move call picker inside a row, too.
  await page.getByRole("tab", { name: "Upcoming" }).click();
  await page.locator('[data-aibk-booking="b-future"]').getByRole("button", { name: "Move call" }).click();
  await expect(page.locator('[data-aibk-booking="b-future"] button.aibk-time').first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test("screenshots for eyeballing: the admin and the no-email confirmation, light and dark, desktop and 390px", async ({ page }) => {
  // Written to test-results/ (gitignored), the way the feedback specs do.
  const shot = async (name: string) => {
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(e2eRoot, "test-results", `booking-${name}.png`), fullPage: true });
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.unrouteAll();
    await mountAdmin(page, adminSeed());
    await expect(page.locator('[data-aibk-booking="b-future"]')).toBeVisible();
    await page.locator('[data-aibk-booking="b-future"]').getByRole("button", { name: "Move call" }).click();
    await expect(page.locator('[data-aibk-booking="b-future"] button.aibk-time').first()).toBeVisible();
    await shot(`admin-upcoming-${scheme}`);
    await page.getByRole("tab", { name: "Availability" }).click();
    await expect(page.getByRole("heading", { name: "Your week" })).toBeVisible();
    await shot(`admin-availability-${scheme}`);
    await page.getByRole("tab", { name: "Settings" }).click();
    await shot(`admin-settings-${scheme}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Upcoming" }).click();
    await expect(page.locator('[data-aibk-booking="b-future"]')).toBeVisible();
    await shot(`admin-upcoming-390-${scheme}`);

    const fake = makeFake({ noMeetingLink: true });
    fake.config.emailsEnabled = false;
    await page.unrouteAll();
    await mount(page, fake);
    await expect(timeButtons(page).first()).toBeVisible();
    await shot(`widget-pick-390-${scheme}`);
    await timeButtons(page).first().click();
    await fillDetails(page);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
    await shot(`widget-no-email-confirmation-390-${scheme}`);
  }
});
