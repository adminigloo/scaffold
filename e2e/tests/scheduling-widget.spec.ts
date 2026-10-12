import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @adminigloo/scheduling-widget in a real browser (contract 10.4), driven the
 * way its people use it:
 *
 *   - a customer books on a 390px phone, and recovers when the time is taken
 *     with everything they typed kept;
 *   - the same customer moves and then cancels from the manage page;
 *   - an office manager drags a visit with a real mouse, and a crew lead does it
 *     with a finger (touch pointer events);
 *   - a crew starts and completes a stop on today's route;
 *   - the theme follows the HOST page (html.dark; and an OS that's dark under a
 *     site that pins light);
 *   - axe finds nothing on the picker, the manage page or the calendar.
 *
 * SELF-CONTAINED, like booking-widget.spec.ts: the widget is bundled here, in
 * beforeAll, from the package's SOURCE with esbuild (react pinned to e2e's
 * single copy), and the scheduling server is a fake answered with page.route on
 * a made-up origin. The bundle is a development React build under StrictMode,
 * so mount effects run twice the way every buyer's `next dev` runs them.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const widgetEntry = join(e2eRoot, "..", "packages", "scheduling-widget", "src", "index.ts").replace(/\\/g, "/");
const adminEntry = join(e2eRoot, "..", "packages", "scheduling-widget", "src", "admin", "index.ts").replace(/\\/g, "/");
const ORIGIN = "https://schedule.test";

const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VisitPicker, ManageVisit } from ${JSON.stringify(widgetEntry)};
import { ScheduleCalendar, CrewDay, SchedulingSettings } from ${JSON.stringify(adminEntry)};

const cfg = window.__sw || {};
window.__requested = [];

function App() {
  const props = cfg.props || {};
  if (cfg.mode === "manage") return <ManageVisit baseUrl="/api/schedule" token="tok_1" bookHref="/book" {...props} />;
  if (cfg.mode === "calendar") return <ScheduleCalendar baseUrl="/api/admin/schedule" pollMs={0} {...props} />;
  if (cfg.mode === "crew") return <CrewDay baseUrl="/api/admin/schedule" {...props} />;
  if (cfg.mode === "settings") return <SchedulingSettings baseUrl="/api/admin/schedule" {...props} />;
  return <VisitPicker baseUrl="/api/schedule" onRequested={(r) => window.__requested.push(r)} {...props} />;
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "scheduling-host.tsx", loader: "tsx" },
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
// The fake scheduling server: Acme Windows, Salt Lake City (America/Denver).
// Dates are in 2030 so "now" never catches up with them.
// ---------------------------------------------------------------------------

const CONFIG = {
  businessName: "Acme Windows",
  timeZone: "America/Denver",
  publicBookingEnabled: true,
  autoConfirm: false,
  services: [{ key: "estimate", name: "Free estimate", description: "We measure and quote.", durationMinutes: 60 }],
  minNoticeMinutes: 1440,
  horizonDays: 3650,
  requireAddress: true,
  cancelCutoffHours: 24,
  contactEmail: "office@acme.test",
  contactPhone: "(801) 555-0143",
  emailsEnabled: true,
  minFillMs: 1500,
};

const SLOTS = [
  { slotId: "s1", date: "2030-11-04", startTime: "09:00", endTime: "10:00", startsAt: "2030-11-04T16:00:00.000Z", endsAt: "2030-11-04T17:00:00.000Z" },
  { slotId: "s2", date: "2030-11-04", startTime: "13:30", endTime: "14:30", startsAt: "2030-11-04T20:30:00.000Z", endsAt: "2030-11-04T21:30:00.000Z" },
  { slotId: "s3", date: "2030-11-05", startTime: "10:00", endTime: "11:00", startsAt: "2030-11-05T17:00:00.000Z", endsAt: "2030-11-05T18:00:00.000Z" },
];

function publicVisit(extra: Record<string, unknown> = {}) {
  return {
    status: "confirmed",
    serviceKey: "estimate",
    serviceName: "Free estimate",
    date: "2030-11-04",
    startTime: "09:00",
    endTime: "10:00",
    startsAt: "2030-11-04T16:00:00.000Z",
    endsAt: "2030-11-04T17:00:00.000Z",
    timeZone: "America/Denver",
    durationMinutes: 60,
    customerName: "Jane Doe",
    address: "123 Main St, Salt Lake City, UT",
    businessName: "Acme Windows",
    contactPhone: "(801) 555-0143",
    contactEmail: "office@acme.test",
    canReschedule: true,
    canCancel: true,
    changeDeadline: "2030-11-03T16:00:00.000Z",
    cancelCutoffHours: 24,
    cancelledBy: null,
    googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Free%20estimate",
    ...extra,
  };
}

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    id: "v1",
    status: "confirmed",
    nextStatuses: ["in_progress", "completed", "cancelled", "no_show"],
    date: "2030-11-04",
    startTime: "09:00",
    endTime: "10:00",
    startsAt: "2030-11-04T16:00:00.000Z",
    endsAt: "2030-11-04T17:00:00.000Z",
    timeZone: "America/Denver",
    durationMinutes: 60,
    resourceId: "crew-a",
    resourceName: "Crew A",
    serviceKey: "estimate",
    serviceName: "Free estimate",
    title: null,
    customerName: "Jane Doe",
    customerEmail: "jane@example.com",
    customerPhone: "+18015550100",
    address: "123 Main St, Salt Lake City, UT",
    lat: 40.76,
    lng: -111.89,
    notes: null,
    estimateId: null,
    origin: "public",
    sequence: 0,
    pendingExpiresAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2030-10-29T15:00:00.000Z",
    updatedAt: "2030-10-29T15:00:00.000Z",
    ...extra,
  };
}

interface Fake {
  slots: typeof SLOTS;
  requests: Array<Record<string, unknown>>;
  takeOnRequest: Set<string>;
  visit: Record<string, unknown>;
  manageCalls: Array<{ action: string; body: Record<string, unknown> }>;
  slotQueries: string[];
  admin: Array<{ path: string; body: Record<string, unknown> }>;
  calendarVisits: Array<Record<string, unknown>>;
  stops: Array<Record<string, unknown>>;
}

function makeFake(): Fake {
  return {
    slots: [...SLOTS],
    requests: [],
    takeOnRequest: new Set(),
    visit: publicVisit(),
    manageCalls: [],
    slotQueries: [],
    admin: [],
    calendarVisits: [snapshot()],
    stops: [snapshot({ id: "v1" }), snapshot({ id: "v2", startTime: "11:00", endTime: "12:00", customerName: "Sam Lee", address: "9 Oak Ave" })],
  };
}

interface Reply {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown): Reply => ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
const refuse = (status: number, code: string, message = code) => json(status, { error: { code, message } });

const SHELL =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  '<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body></html>';

function respond(fake: Fake, url: URL, body: Record<string, unknown>): Reply {
  const path = url.pathname;
  if (path.startsWith("/api/admin/schedule/v1/admin/")) return respondAdmin(fake, path.slice("/api/admin/schedule/v1/admin".length), url, body);
  if (!path.startsWith("/api/schedule/")) return { status: 200, contentType: "text/html", body: SHELL };
  const api = path.slice("/api/schedule".length);
  if (api === "/v1/config") return json(200, CONFIG);
  if (api === "/v1/slots") {
    fake.slotQueries.push(url.search);
    return json(200, { timeZone: "America/Denver", service: "estimate", from: "2030-11-01", to: "2030-11-14", closed: false, slots: fake.slots });
  }
  if (api === "/v1/request") {
    fake.requests.push(body);
    const slot = fake.slots.find((s) => s.slotId === body.slotId);
    if (!slot || fake.takeOnRequest.has(String(body.slotId))) {
      fake.takeOnRequest.delete(String(body.slotId));
      fake.slots = fake.slots.filter((s) => s.slotId !== body.slotId);
      return refuse(409, "slot_unavailable", "That time is no longer open.");
    }
    return json(201, {
      visit: publicVisit({ ...slot, status: "requested", customerName: body.name, address: body.address }),
      manageToken: "tok_1",
      manageUrl: `${ORIGIN}/visit/tok_1`,
      repeated: false,
    });
  }
  const manage = api.match(/^\/v1\/visit\/([^/]+)(\/[a-z]+)?$/);
  if (manage) {
    if (manage[1] !== "tok_1") return refuse(404, "not_found");
    const action = manage[2] ?? "";
    if (action === "") return json(200, { visit: fake.visit });
    if (action === "/ics") return { status: 200, contentType: "text/calendar", body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" };
    fake.manageCalls.push({ action, body });
    if (action === "/reschedule") {
      const slot = fake.slots.find((s) => s.slotId === body.slotId)!;
      fake.visit = { ...fake.visit, ...slot };
      return json(200, { visit: fake.visit });
    }
    if (action === "/cancel") {
      fake.visit = { ...fake.visit, status: "cancelled", cancelledBy: "customer", canCancel: false, canReschedule: false, changeDeadline: null, googleCalendarUrl: null };
      return json(200, { visit: fake.visit });
    }
  }
  return refuse(404, "not_found");
}

function respondAdmin(fake: Fake, api: string, url: URL, body: Record<string, unknown>): Reply {
  fake.admin.push({ path: api, body });
  if (api === "/calendar") {
    const from = url.searchParams.get("from")!;
    const to = url.searchParams.get("to")!;
    return json(200, {
      timeZone: "America/Denver",
      today: "2030-11-04",
      from,
      to,
      slotStepMinutes: 30,
      resources: [
        { id: "crew-a", name: "Crew A", isActive: true, acceptsPublicBookings: true, maxJobsPerDay: 6 },
        { id: "crew-b", name: "Crew B", isActive: true, acceptsPublicBookings: true, maxJobsPerDay: 6 },
      ],
      windows: ["crew-a", "crew-b"].map((resourceId) => ({ resourceId, date: "2030-11-04", windows: [{ start: "08:00", end: "17:00" }] })),
      visits: fake.calendarVisits,
      pending: [],
    });
  }
  if (api === "/settings") return json(200, { settings: { timeZone: "America/Denver", businessName: "Acme Windows", services: CONFIG.services } });
  // A crew's Start / Complete go to /progress (schedule.route); the office's status menu to /status.
  const move = api.match(/^\/visits\/([^/]+)\/(reschedule|assign|status|progress)$/);
  if (move) {
    const id = move[1]!;
    if (move[2] === "status" || move[2] === "progress") {
      const stop = fake.stops.find((s) => s.id === id)!;
      Object.assign(stop, { status: body.status, ...(body.status === "completed" ? { completedAt: "2030-11-04T17:42:00.000Z" } : {}) });
      return json(200, { visit: stop });
    }
    const visit = fake.calendarVisits.find((v) => v.id === id)!;
    Object.assign(visit, move[2] === "reschedule" ? { date: body.date, startTime: body.startTime, endTime: "11:00" } : { resourceId: body.resourceId, resourceName: "Crew B" });
    return json(200, { visit, warnings: [] });
  }
  if (api === "/crew-day") {
    return json(200, {
      timeZone: "America/Denver",
      date: "2030-11-04",
      today: "2030-11-04",
      resource: { id: "crew-a", name: "Crew A", homeBaseAddress: "1 Depot Rd" },
      windows: [{ start: "08:00", end: "17:00" }],
      stops: fake.stops.map((visit, i) => ({
        order: i + 1,
        visit,
        driveFromPrevious: { minutes: 18 - i * 6, miles: 9.2 - i * 5, from: i === 0 ? "home_base" : "previous_stop", estimated: false },
        directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(String(visit.address))}&travelmode=driving`,
        telUrl: i === 0 ? "tel:+18015550100" : null,
      })),
      totals: { visits: fake.stops.length, driveMinutes: 30, distanceMiles: 13.4, estimated: false },
      routeUrl: "https://www.google.com/maps/dir/?api=1&origin=1%20Depot%20Rd&destination=9%20Oak%20Ave&travelmode=driving",
    });
  }
  return refuse(404, "not_found");
}

type Mode = "picker" | "manage" | "calendar" | "crew" | "settings";

async function mount(page: Page, fake: Fake, mode: Mode, props: Record<string, unknown> = {}, beforeBundle?: (page: Page) => Promise<void>) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? ((request.postDataJSON() as Record<string, unknown>) ?? {}) : {};
    return route.fulfill(respond(fake, new URL(request.url()), body));
  });
  await page.goto(`${ORIGIN}/`);
  if (beforeBundle) await beforeBundle(page);
  await page.evaluate((cfg) => {
    (window as unknown as { __sw: unknown }).__sw = cfg;
  }, { mode, props });
  await page.addScriptTag({ content: bundle });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

// ---------------------------------------------------------------------------
// The customer, on a phone
// ---------------------------------------------------------------------------

test.describe("a customer at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("books a visit, in the business's time zone, with no sideways scroll", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "picker");
    await expect(page.getByText("Times are Mountain Time (MST)")).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByRole("button", { name: /9:00 AM to 10:00 AM/ }).click();
    await expect(page.getByRole("heading", { name: "Your details" })).toBeFocused();
    await page.getByLabel("Your name").fill("Jane Doe");
    await page.getByLabel("Email").fill("jane@example.com");
    await page.getByLabel("Address for the visit").fill("123 Main St, Salt Lake City");
    await noSidewaysScroll(page);
    // Faster than the server's 1.5 s floor: the button waits it out instead of failing.
    await page.getByRole("button", { name: "Request this visit" }).click();
    await expect(page.getByRole("button", { name: "Sending…" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
    expect(Number(fake.requests[0]!.fillMs)).toBeGreaterThanOrEqual(1500);
    expect(fake.requests[0]!.website).toBeUndefined();
    await expect(page.getByText("We've emailed you a copy of your request with a link to change it.")).toBeVisible();
    await noSidewaysScroll(page);
  });

  test("the time is taken while they type: back to the times, form kept", async ({ page }) => {
    const fake = makeFake();
    fake.takeOnRequest.add("s1");
    await mount(page, fake, "picker", { lockService: true, service: "estimate" });
    await page.getByRole("button", { name: /9:00 AM to 10:00 AM/ }).click();
    await page.getByLabel("Your name").fill("Jane Doe");
    await page.getByLabel("Email").fill("jane@example.com");
    await page.getByLabel("Address for the visit").fill("123 Main St");
    await page.getByRole("button", { name: "Request this visit" }).click();
    await expect(page.getByText("That time was just taken. Pick another.")).toBeVisible();
    await expect(page.getByRole("button", { name: /9:00 AM to 10:00 AM/ })).toHaveCount(0);
    await page.getByRole("button", { name: /1:30 PM to 2:30 PM/ }).click();
    await expect(page.getByLabel("Your name")).toHaveValue("Jane Doe");
    await expect(page.getByLabel("Address for the visit")).toHaveValue("123 Main St");
  });

  test("the manage page: move the visit, then cancel it", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "manage");
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pick another time" }).click();
    expect(fake.slotQueries.at(-1)).toContain("manage=tok_1");
    await page.locator('.aisw-day[data-date="2030-11-05"]').click();
    await page.getByRole("button", { name: /10:00 AM to 11:00 AM/ }).click();
    await expect(page.getByRole("heading", { name: "Move to Tue, Nov 5, 10:00 AM?" })).toBeVisible();
    await page.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page.getByText(/Moved to Tuesday, November 5/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel visit" }).click();
    await page.getByLabel(/Anything you'd like/).fill("Moving house");
    await page.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(page.getByText("You cancelled this visit.")).toBeVisible();
    expect(fake.manageCalls.map((c) => c.action)).toEqual(["/reschedule", "/cancel"]);
    expect(fake.manageCalls[1]!.body).toEqual({ reason: "Moving house" });
    await noSidewaysScroll(page);
  });
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

test.describe("the calendar", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a real mouse drag moves a visit, snapped to the grid", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "calendar", { initialView: "day", initialDate: "2030-11-04" });
    const visit = page.locator('[data-visit-id="v1"]');
    await expect(visit).toBeVisible();
    const box = (await visit.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    // 70 minutes at 1.6 px a minute, in steps, like a hand.
    await page.mouse.move(box.x + box.width / 2, box.y + 10 + 56, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, box.y + 10 + 112, { steps: 4 });
    await page.mouse.up();
    const prompt = page.getByRole("dialog", { name: "Email the customer about this change?" });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Yes, email them" }).click();
    await expect(page.getByText("Jane Doe moved to Mon, Nov 4, 10:00 AM.")).toBeVisible();
    const call = fake.admin.find((c) => c.path === "/visits/v1/reschedule")!;
    expect(call.body).toEqual({ date: "2030-11-04", startTime: "10:00", notify: true });
  });

  test("a touch drag across to another crew gives it to that crew", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
    const page = await context.newPage();
    const fake = makeFake();
    await mount(page, fake, "calendar", { initialView: "day", initialDate: "2030-11-04" });
    await page.evaluate(() => sessionStorage.setItem("aisw-notify-choice", "no"));
    const visit = page.locator('[data-visit-id="v1"]');
    const from = (await visit.boundingBox())!;
    const to = (await page.locator('[data-drop][data-resource="crew-b"]').boundingBox())!;
    const start = { x: from.x + from.width / 2, y: from.y + 10 };
    const end = { x: to.x + to.width / 2, y: start.y };
    await visit.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 3, isPrimary: true, clientX: start.x, clientY: start.y, button: 0 });
    for (const t of [0.25, 0.5, 0.75, 1]) {
      await page.evaluate(
        ([x, y]) => window.dispatchEvent(new PointerEvent("pointermove", { pointerType: "touch", pointerId: 3, isPrimary: true, clientX: x, clientY: y, bubbles: true })),
        [start.x + (end.x - start.x) * t, end.y],
      );
    }
    await page.evaluate(
      ([x, y]) => window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", pointerId: 3, isPrimary: true, clientX: x, clientY: y, bubbles: true })),
      [end.x, end.y],
    );
    await expect(page.getByText("Jane Doe is now with Crew B.")).toBeVisible();
    expect(fake.admin.find((c) => c.path === "/visits/v1/assign")!.body).toEqual({ resourceId: "crew-b", notify: false });
    await context.close();
  });

  test("axe finds nothing on the calendar or the open visit panel", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "calendar", { initialView: "day", initialDate: "2030-11-04" });
    await expect(page.locator('[data-visit-id="v1"]')).toBeVisible();
    let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aisw-root").analyze();
    expect(results.violations).toEqual([]);
    await page.locator('[data-visit-id="v1"]').click();
    await expect(page.getByRole("dialog")).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aisw-root").analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("today's route", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Start, then Complete, on a phone", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "crew");
    await expect(page.getByText("2 stops · 30 min driving")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open route in Maps/ })).toBeVisible();
    const first = page.locator('[data-stop-id="v1"]');
    await first.getByRole("button", { name: /Start stop 1/ }).click();
    await first.getByRole("button", { name: /Complete stop 1/ }).click();
    await expect(first.getByText("Done 10:42 AM")).toBeVisible();
    await noSidewaysScroll(page);
  });
});

// ---------------------------------------------------------------------------
// Theme and accessibility
// ---------------------------------------------------------------------------

test.describe("theme", () => {
  test("html.dark makes the widget dark", async ({ page }) => {
    await mount(page, makeFake(), "picker", {}, async (p) => {
      await p.evaluate(() => document.documentElement.classList.add("dark"));
    });
    await expect(page.locator(".aisw-root")).toHaveAttribute("data-theme", "dark");
    const background = await page.locator(".aisw-root").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(20, 27, 34)");
  });

  test("an OS that's dark under a site that pins light stays light", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await mount(page, makeFake(), "picker", {}, async (p) => {
      await p.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    });
    await expect(page.locator(".aisw-root")).toHaveAttribute("data-theme", "light");
    const background = await page.locator(".aisw-root").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(255, 255, 255)");
    await context.close();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on the picker and the manage page — ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await mount(page, makeFake(), "picker");
      await expect(page.getByText("Times are Mountain Time (MST)")).toBeVisible();
      let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aisw-root").analyze();
      expect(results.violations).toEqual([]);
      await page.getByRole("button", { name: /9:00 AM to 10:00 AM/ }).click();
      results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aisw-root").analyze();
      expect(results.violations).toEqual([]);
      await context.close();

      const manageContext = await browser.newContext({ colorScheme: scheme });
      const manage = await manageContext.newPage();
      await mount(manage, makeFake(), "manage");
      await expect(manage.getByText("Confirmed", { exact: true })).toBeVisible();
      results = await new AxeBuilder({ page: manage }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aisw-root").analyze();
      expect(results.violations).toEqual([]);
      await manageContext.close();
    });
  }
});
