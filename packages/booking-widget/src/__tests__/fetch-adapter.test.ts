import { describe, expect, it } from "vitest";
import { BookingAdminRequestError, createBookingAdminFetchAdapter } from "../admin/fetch-adapter.js";
import { buildBookRequest, friendlyError } from "../requests.js";

/** The admin adapter over the package's admin routes (0.2), and the public widget's honeypot and closed sentence. */

function fake(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${url}`] ?? { status: 404, body: { error: { code: "not_found", message: "Not found." } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createBookingAdminFetchAdapter", () => {
  it("speaks the admin route table under the company's mount", async () => {
    const { impl, calls } = fake({
      "GET /api/app/c1/calls/v1/bookings?scope=upcoming": { body: { bookings: [{ id: "b1" }] } },
      "POST /api/app/c1/calls/v1/hosts/h1": { body: { host: { id: "h1" } } },
      "POST /api/app/c1/calls/v1/types": { status: 201, body: { type: { id: "t1" } } },
      "GET /api/app/c1/calls/v1/holds": { body: { live: 3, subjects: 2 } },
      "POST /api/app/c1/calls/v1/bookings/b1/move": { body: { booking: { id: "b1" } } },
    });
    const adapter = createBookingAdminFetchAdapter({ baseUrl: "/api/app/c1/calls/", emailsEnabled: false, fetch: impl });
    expect(adapter.emailsEnabled).toBe(false);
    expect(await adapter.listBookings({ scope: "upcoming" })).toEqual([{ id: "b1" }]);
    expect(await adapter.upsertHost({ id: "h1", displayName: "Pat", email: "pat@x.test", timezone: "UTC" })).toEqual({ id: "h1" });
    expect(calls[1]!.body).toEqual({ displayName: "Pat", email: "pat@x.test", timezone: "UTC" });
    expect((await adapter.upsertType({ key: "intro" } as never)).id).toBe("t1");
    expect(await adapter.countLiveHolds!()).toBe(3);
    await adapter.rescheduleBooking({ id: "b1", start: "2031-03-11T15:00:00.000Z" });
    expect(calls.at(-1)).toEqual({ method: "POST", url: "/api/app/c1/calls/v1/bookings/b1/move", body: { start: "2031-03-11T15:00:00.000Z" } });
  });

  it("another company's booking is null; a refusal throws the server's own words", async () => {
    const { impl } = fake({
      "POST /api/app/c1/calls/v1/hosts": {
        status: 400,
        body: { error: { code: "invalid", message: "Some details need another look.", issues: [{ path: ["email"], message: "Only people on your team can take calls." }] } },
      },
      "POST /api/app/c1/calls/v1/holidays": { status: 403, body: { error: { code: "forbidden", message: "You don't have permission to change this." } } },
    });
    const adapter = createBookingAdminFetchAdapter({ baseUrl: "/api/app/c1/calls", emailsEnabled: true, fetch: impl });
    expect(await adapter.getBooking("someone-elses")).toBeNull();
    await expect(adapter.upsertHost({ displayName: "X", email: "x@y.test", timezone: "UTC" })).rejects.toThrow("Only people on your team can take calls.");
    await expect(adapter.addBlackout({ date: "2031-12-25", label: null })).rejects.toBeInstanceOf(BookingAdminRequestError);
  });
});

describe("the public widget (0.2)", () => {
  const values = { name: "Pat", email: "pat@x.test", phone: "", company: "", notes: "", medium: "video" as const };
  it("sends the honeypot only when something filled it", () => {
    const base = { type: "intro", start: "2031-03-11T15:00:00.000Z", values, medium: "video" as const, timezone: "UTC" };
    expect(buildBookRequest({ ...base, website: "" })).not.toHaveProperty("website");
    expect(buildBookRequest({ ...base, website: "http://spam.test" }).website).toBe("http://spam.test");
  });
  it("a closed business is named in its own sentence", () => {
    const message = "Green Acres isn't taking requests online right now. Call 801-555-0100.";
    expect(friendlyError({ code: "closed", message, status: 403, issues: [] }, "config")).toBe(message);
  });
});

describe("the adapter's 0.2 extras", () => {
  it("lists the team and cancels all from one email", async () => {
    const { impl, calls } = fake({
      "GET /a/v1/team": { body: { available: true, people: [{ userId: "u1", name: "Pat", email: "pat@x.test", hostId: null }], limit: 1, limitMessage: null } },
      "POST /a/v1/bookings/cancel-from-email": { body: { cancelled: 3 } },
    });
    const adapter = createBookingAdminFetchAdapter({ baseUrl: "/a", emailsEnabled: true, fetch: impl });
    expect((await adapter.listTeam!()).people[0]?.name).toBe("Pat");
    expect(await adapter.cancelAllFromEmail!("junk@spam.test")).toEqual({ cancelled: 3 });
    expect(calls.at(-1)?.body).toEqual({ email: "junk@spam.test" });
  });
});
