// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompaniesConsole, companyHref } from "../admin/CompaniesConsole.js";
import { CompanyDetail } from "../admin/CompanyDetail.js";
import { StaffPeople } from "../admin/StaffPeople.js";
import type { AdminCompanyListWire } from "../types.js";
import {
  adminDetail,
  adminRow,
  button,
  check,
  choose,
  click,
  dialog,
  fail,
  fakeAdmin,
  labelled,
  link,
  mount,
  ok,
  people,
  person,
  submit,
  text,
  type,
  wait,
} from "./fakes.js";

/**
 * The operator console (contract 8.10–8.12): the companies list searches
 * after 300 ms of quiet, keeps its view in the address bar, filters and
 * pages; a company's detail shows its facts, members and activity and
 * suspends only with a reason; the People screen gives and takes staff roles
 * only where the server allows, says why a select is locked, and asks before
 * giving a role.
 */

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/companies");
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const list = (n: number, total = n, page = 1, pageSize = 25): AdminCompanyListWire => ({
  companies: Array.from({ length: n }, (_, i) => adminRow({ id: `t-${i}`, name: `Company ${i}`, slug: `company-${i}` })),
  total,
  page,
  pageSize,
});

describe("<CompaniesConsole>", () => {
  it("lists companies with their address, people, owner, created date and status; names link to the detail", async () => {
    const f = fakeAdmin({ companies: () => ok({ companies: [adminRow(), adminRow({ id: "t-gig", name: "Side Gig", slug: "side-gig", status: "suspended", owner: null })], total: 2, page: 1, pageSize: 25 }) });
    const { container, unmount } = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => `/admin/companies/${id}`} />);
    expect(f.of("companies").map((c) => c.args[0])).toEqual([{ kind: "org", status: "all", page: 1, pageSize: 25 }]);
    expect([...container.querySelectorAll('th[scope="col"]')].map((th) => text(th))).toEqual(["Name", "Web address", "People", "Owner", "Created", "Status"]);
    const summit = container.querySelector('[data-company="t-summit"]')!;
    expect(link(summit, "Summit Window Co.")!.getAttribute("href")).toBe("/admin/companies/t-summit");
    expect(text(summit)).toContain("/t/summit-window-co");
    expect(text(summit)).toContain("olivia@summitwindows.test");
    expect(text(summit)).toContain("Oct 12, 2026");
    expect(text(container.querySelector('[data-company="t-gig"] .aitw-tag-warn'))).toBe("Suspended");
    expect(text(container.querySelector("[data-aitw-pager]"))).toContain("Showing 1–2 of 2");
    await unmount();
  });

  it("searches after 300 ms of quiet, from the first page, and mirrors the view into the address bar", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    const f = fakeAdmin({ companies: () => ok(list(1)) });
    const { container, unmount } = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => `/c/${id}`} />);
    const search = labelled(container, "Search companies by name, web address or owner's email")!;
    await type(search, "su");
    await type(search, "summit");
    await wait(100);
    expect(f.of("companies")).toHaveLength(1);
    await wait(300);
    expect(f.of("companies").map((c) => c.args[0])).toEqual([
      { kind: "org", status: "all", page: 1, pageSize: 25 },
      { q: "summit", kind: "org", status: "all", page: 1, pageSize: 25 },
    ]);
    expect(window.location.search).toBe("?q=summit");
    expect(replace).toHaveBeenCalled();
    await choose(labelled(container, "Status"), "suspended");
    await choose(labelled(container, "Show"), "all");
    expect(f.of("companies").at(-1)!.args[0]).toEqual({ q: "summit", kind: "all", status: "suspended", page: 1, pageSize: 25 });
    expect(new URLSearchParams(window.location.search).get("kind")).toBe("all");
    expect(new URLSearchParams(window.location.search).get("status")).toBe("suspended");
    await unmount();
  });

  it("reads the view back from the address bar on load (a refresh or a shared link)", async () => {
    window.history.replaceState(null, "", "/admin/companies?q=summit&kind=personal&status=active&page=3");
    const f = fakeAdmin({ companies: () => ok(list(2, 52, 3)) });
    const { container, unmount } = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} />);
    expect(f.of("companies").map((c) => c.args[0])).toEqual([{ q: "summit", kind: "personal", status: "active", page: 3, pageSize: 25 }]);
    expect((labelled(container, "Search companies by name, web address or owner's email") as HTMLInputElement).value).toBe("summit");
    expect((labelled(container, "Show") as HTMLSelectElement).value).toBe("personal");
    await unmount();
  });

  it("pages with Previous and Next, each disabled at its end", async () => {
    const f = fakeAdmin({ companies: (q) => ok(list(q.page === 2 ? 5 : 25, 30, q.page ?? 1)) });
    const { container, unmount } = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} />);
    expect(text(container.querySelector("[data-aitw-pager]"))).toContain("Showing 1–25 of 30");
    expect(button(container, "Previous")!.disabled).toBe(true);
    await click(button(container, "Next"));
    expect(f.of("companies").at(-1)!.args[0]).toMatchObject({ page: 2 });
    expect(text(container.querySelector("[data-aitw-pager]"))).toContain("Showing 26–30 of 30");
    expect(button(container, "Next")!.disabled).toBe(true);
    expect(window.location.search).toBe("?page=2");
    await unmount();
  });

  it("says plainly when there's nothing: none yet, or nothing matching", async () => {
    const f = fakeAdmin({ companies: () => ok(list(0)) });
    const a = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} noun={{ singular: "shop", plural: "shops" }} />);
    expect(text(a.container.querySelector("[data-aitw-empty]"))).toBe("No shops yet. They appear here when someone signs up.");
    await type(labelled(a.container, "Search shops by name, web address or owner's email"), "zzz");
    await wait(350);
    expect(text(a.container.querySelector("[data-aitw-empty]"))).toBe("Nothing matches “zzz”.");
    await a.unmount();
  });

  it("detailHref works from a server page: a '{id}' pattern (the default) or a function", async () => {
    expect(companyHref(undefined, "t 1")).toBe("/admin/companies/t%201");
    expect(companyHref("/ops/{id}/view", "t-1")).toBe("/ops/t-1/view");
    expect(companyHref("/ops/companies/", "t-1")).toBe("/ops/companies/t-1");
    expect(companyHref((id) => `/x/${id}`, "t-1")).toBe("/x/t-1");
    const f = fakeAdmin({ companies: () => ok(list(1)) });
    const { container, unmount } = await mount(<CompaniesConsole transport={f.transport} />);
    expect(link(container, "Company 0")!.getAttribute("href")).toBe("/admin/companies/t-0");
    await unmount();
  });

  it("personal workspaces are hidden by default; single-business projects pass defaultKind='all'", async () => {
    const f = fakeAdmin({ companies: () => ok(list(1)) });
    const { unmount } = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} defaultKind="all" />);
    expect(f.of("companies")[0]!.args[0]).toMatchObject({ kind: "all" });
    expect(window.location.search).toBe("");
    await unmount();
  });
});

describe("<CompanyDetail>", () => {
  it("shows the facts, members and recent activity, access changes marked", async () => {
    const f = fakeAdmin({ company: () => ok(adminDetail()) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container.querySelector("h2"))).toBe("Summit Window Co.");
    expect(link(container, "Back to companies")!.getAttribute("href")).toBe("/admin/companies");
    const facts = text(container.querySelector("dl"));
    expect(facts).toContain("Oct 12, 2026 by Olivia");
    expect(facts).toContain("Mountain Time (Denver)");
    expect(facts).toContain("office@summitwindows.test");
    expect(facts).toContain("(801) 555-0143");
    expect(text(container.querySelector('[data-member="u-sam"]'))).toContain("Member");
    const activity = text(container.querySelector("[data-aitw-activity]"));
    expect(activity).toContain("Olivia");
    expect(activity).toContain("Handed ownership of the company to someone else");
    expect(container.querySelectorAll("[data-aitw-activity] [data-aitw-access-change]")).toHaveLength(1);
    await unmount();
  });

  it("activity not connected, and an owner whose account was closed, are said in words", async () => {
    const f = fakeAdmin({ company: () => ok(adminDetail({ activity: null }, { ownerDeleted: true })) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container)).toContain("Activity isn't connected on this site.");
    expect(text(container.querySelector("[data-aitw-owner]"))).toContain(
      "olivia@summitwindows.test (account closed). Use Change owner to hand it to someone on the team.",
    );
    await unmount();
  });

  it("change owner: staff hand a company whose owner is gone to an active member (review T1-03)", async () => {
    const after = adminDetail({}, { owner: { userId: "u-sam", email: "sam@summitwindows.test", name: "Sam Lee" }, ownerDeleted: false });
    const f = fakeAdmin({ company: () => ok(adminDetail({}, { ownerDeleted: true })), assignOwner: () => ok(after) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    await click(button(container, "Change owner"));
    const d = dialog()!;
    expect(text(d.querySelector("h2"))).toBe("Give Summit Window Co. a new owner?");
    await choose(d.querySelector("select"), "u-sam");
    expect(text(d)).toContain("Sam Lee becomes the owner, with full control.");
    await click(button(d, "Make them the owner"));
    expect(f.of("assignOwner").map((c) => c.args)).toEqual([["t-summit", { toUserId: "u-sam" }]]);
    expect(text(container.querySelector("[data-aitw-owner]"))).toContain("sam@summitwindows.test");
    await unmount();
  });

  it("without the permission the words don't promise a control that isn't there", async () => {
    const f = fakeAdmin({ company: () => ok(adminDetail({ can: { suspend: true, assignOwner: false, releaseAddresses: false, delete: false } }, { ownerDeleted: true })) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(button(container, "Change owner")).toBeNull();
    expect(text(container.querySelector("[data-aitw-owner]"))).not.toContain("Use Change owner");
    await unmount();
  });

  it("old web addresses are listed and can be released (review T1-07); activity shows the time and the detail (review T1-17)", async () => {
    const f = fakeAdmin({
      company: () => ok(adminDetail({ retiredAddresses: ["summit-windows-old"] })),
      releaseAddresses: () => ok(adminDetail({ retiredAddresses: [] })),
    });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container.querySelector("[data-aitw-old-addresses]"))).toContain("/t/summit-windows-old");
    const activity = text(container.querySelector("[data-aitw-activity]"));
    expect(activity).toMatch(/\d{1,2}:\d{2}/);
    expect(activity).toContain("(Sam Lee)");
    await click(button(container, "Release old addresses"));
    await click(button(dialog()!, "Release old addresses"));
    expect(f.of("releaseAddresses").map((c) => c.args)).toEqual([["t-summit"]]);
    expect(container.querySelector("[data-aitw-old-addresses]")).toBeNull();
    await unmount();
  });

  it("suspending needs a reason, warns what happens, then re-renders from the answer", async () => {
    const suspended = adminDetail({}, { status: "suspended", suspendedAt: "2026-10-12T18:00:00.000Z", suspendedReason: "Unpaid for three months", suspendedBy: { userId: "u-ava", email: "ava@igloo.test", name: "Ava" } });
    const f = fakeAdmin({ company: () => ok(adminDetail()), suspend: () => ok(suspended) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    await click(button(container, "Suspend company"));
    const d = dialog()!;
    expect(text(d.querySelector("h2"))).toBe("Suspend Summit Window Co.?");
    expect(text(d)).toContain("Everyone in Summit Window Co. loses access until you reactivate it.");
    await submit(d.querySelector("form"));
    expect(f.of("suspend")).toHaveLength(0);
    const reason = labelled(d, "Why (only staff see this)")!;
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    await type(reason, "Unpaid for three months");
    await submit(dialog()!.querySelector("form"));
    expect(f.of("suspend").map((c) => c.args)).toEqual([["t-summit", { reason: "Unpaid for three months" }]]);
    expect(dialog()).toBeNull();
    expect(text(container.querySelector("[data-aitw-suspension]"))).toBe("Suspended Oct 12, 2026 by Ava: Unpaid for three months");
    expect(button(container, "Reactivate")).not.toBeNull();
    await unmount();
  });

  it("reactivating asks first, then shows the company active", async () => {
    const suspended = adminDetail({}, { status: "suspended", suspendedAt: "2026-10-12T18:00:00.000Z", suspendedReason: "Unpaid", suspendedBy: null });
    const f = fakeAdmin({ company: () => ok(suspended), reactivate: () => ok(adminDetail()) });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    await click(button(container, "Reactivate"));
    expect(text(dialog()!.querySelector("h2"))).toBe("Reactivate Summit Window Co.?");
    await click(button(dialog()!, "Reactivate"));
    expect(f.of("reactivate").map((c) => c.args)).toEqual([["t-summit"]]);
    expect(container.querySelector("[data-aitw-suspension]")).toBeNull();
    expect(button(container, "Suspend company")).not.toBeNull();
    await unmount();
  });

  it("delete (tenancy 0.8): offered only with the permission; the web address must be typed; then the page says what was removed", async () => {
    const none = fakeAdmin({ company: () => ok(adminDetail()) });
    const a = await mount(<CompanyDetail transport={none.transport} tenantId="t-summit" />);
    expect(a.container.querySelector("[data-aitw-delete-section]")).toBeNull();
    await a.unmount();

    const deleted = { id: "t-summit", name: "Summit Window Co.", slug: "summit-window-co", deletedAt: "2026-10-20T09:30:00.000Z", rows: 42, counts: { customers: 12 }, forced: false };
    const f = fakeAdmin({
      company: () => ok(adminDetail({ can: { suspend: true, assignOwner: true, releaseAddresses: true, delete: true } })),
      deleteCompany: () => ok(deleted),
    });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container.querySelector("[data-aitw-delete-section]"))).toContain("It can't be undone.");
    await click(button(container, "Delete company…"));
    const d = dialog()!;
    expect(text(d.querySelector("h2"))).toBe("Delete Summit Window Co. for good?");
    await type(labelled(d, "Web address"), "summit");
    await submit(d.querySelector("form"));
    expect(f.of("deleteCompany")).toHaveLength(0);
    expect(text(dialog()!)).toContain("Type the web address exactly: summit-window-co");
    await type(labelled(dialog()!, "Web address"), "summit-window-co");
    await submit(dialog()!.querySelector("form"));
    expect(f.of("deleteCompany").map((c) => c.args)).toEqual([["t-summit", { confirmSlug: "summit-window-co" }]]);
    expect(text(container)).toContain("Summit Window Co. was deleted: 42 records removed.");
    expect(link(container, "Back to companies")).not.toBeNull();
    await unmount();
  });

  it("delete: a company still paying is named before anything is typed; Delete waits for 'anyway' and a reason", async () => {
    const f = fakeAdmin({
      company: () =>
        ok(adminDetail({ can: { suspend: true, assignOwner: true, releaseAddresses: true, delete: true }, deletion: { available: true, stillPaying: "Pro, active" } })),
      deleteCompany: () => ok({ id: "t-summit", name: "Summit Window Co.", slug: "summit-window-co", deletedAt: "2026-10-20T09:30:00.000Z", rows: 3, counts: {}, forced: true }),
    });
    const { container, unmount } = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(text(container.querySelector("[data-aitw-still-paying]"))).toBe(
      "Summit Window Co. is still paying for Pro, active. Cancel it in Stripe first — deleting doesn't stop the charges.",
    );
    await click(button(container, "Delete company…"));
    await type(labelled(dialog()!, "Web address"), "summit-window-co");
    expect((button(dialog()!, "Delete for good") as HTMLButtonElement).disabled).toBe(true);
    await check(labelled(dialog()!, "Delete it anyway"), true);
    await submit(dialog()!.querySelector("form"));
    expect(f.of("deleteCompany")).toHaveLength(0);
    await type(labelled(dialog()!, "Why it's being deleted anyway"), "Refunded by phone");
    await submit(dialog()!.querySelector("form"));
    expect(f.of("deleteCompany").map((c) => c.args)).toEqual([["t-summit", { confirmSlug: "summit-window-co", force: { reason: "Refunded by phone" } }]]);
    await unmount();
  });

  it("staff without the suspend permission see no lever; a non-staff caller gets the plain refusal", async () => {
    const f = fakeAdmin({ company: () => ok(adminDetail({ can: { suspend: false, assignOwner: false, releaseAddresses: false, delete: false } })) });
    const a = await mount(<CompanyDetail transport={f.transport} tenantId="t-summit" />);
    expect(button(a.container, "Suspend company")).toBeNull();
    await a.unmount();
    const g = fakeAdmin({ company: () => fail("not_staff", "That needs a staff role.", { status: 403 }) });
    const b = await mount(<CompanyDetail transport={g.transport} tenantId="t-summit" />);
    expect(text(b.container)).toContain("That needs a staff role.");
    await b.unmount();
  });
});

describe("<StaffPeople>", () => {
  it("roles the caller can't give are disabled options; a locked row says why in words", async () => {
    const f = fakeAdmin({ people: () => ok(people()) });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    const ava = container.querySelector('[data-person="u-ava"]')!;
    expect(text(ava)).toContain("Ava (you)");
    expect((ava.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect(text(ava)).toContain("You can't change your own role.");
    const olivia = container.querySelector('[data-person="u-olivia"]')!;
    const select = olivia.querySelector("select") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ["No staff role", false],
      ["Administrator", true],
      ["Customer service lead", false],
      ["Customer service agent", false],
    ]);
    expect(labelled(olivia, "Staff role for olivia@summitwindows.test")).toBe(select);
    await unmount();
  });

  it("someone above you: the select is locked with 'Only someone above them can change this.'", async () => {
    const f = fakeAdmin({ people: () => ok(people({ people: [person({ userId: "u-boss", staffRole: { key: "admin", name: "Administrator", rank: 30 }, canChange: false })] })) });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    expect(text(container.querySelector('[data-person="u-boss"]'))).toContain("Only someone above them can change this.");
    await unmount();
  });

  it("giving a role asks first, then updates the row from the answer", async () => {
    const f = fakeAdmin({
      people: () => ok(people()),
      setStaffRole: () => ok({ person: person({ staffRole: { key: "cs_agent", name: "Customer service agent", rank: 10 } }) }),
    });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    await choose(container.querySelector('[data-person="u-olivia"] select'), "cs_agent");
    expect(f.of("setStaffRole")).toHaveLength(0);
    expect(text(dialog())).toContain(
      "Give olivia@summitwindows.test the Customer service agent staff role? They'll be able to use the staff screens that role allows.",
    );
    await click(button(dialog()!, "Give role"));
    expect(f.of("setStaffRole").map((c) => c.args)).toEqual([["u-olivia", { templateKey: "cs_agent" }]]);
    expect((container.querySelector('[data-person="u-olivia"] select') as HTMLSelectElement).value).toBe("cs_agent");
    await unmount();
  });

  it("removing asks with its own sentence; Cancel changes nothing", async () => {
    const f = fakeAdmin({ people: () => ok(people({ people: [person({ staffRole: { key: "cs_lead", name: "Customer service lead", rank: 20 } })] })) });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    await choose(container.querySelector('[data-person="u-olivia"] select'), "");
    expect(text(dialog())).toContain("Remove olivia@summitwindows.test's staff role?");
    await click(button(dialog()!, "Cancel"));
    expect(f.of("setStaffRole")).toHaveLength(0);
    expect((container.querySelector('[data-person="u-olivia"] select') as HTMLSelectElement).value).toBe("cs_lead");
    await unmount();
  });

  it("the last administrator can't be removed: the server's sentence lands on the row", async () => {
    const f = fakeAdmin({
      people: () => ok(people({ people: [person({ staffRole: { key: "admin", name: "Administrator", rank: 30 } })] })),
      setStaffRole: () => fail("last_admin", "That's the only administrator. Make someone else an administrator first."),
    });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    await choose(container.querySelector('[data-person="u-olivia"] select'), "cs_agent");
    await click(button(dialog()!, "Give role"));
    const row = container.querySelector('[data-person="u-olivia"]')!;
    expect(text(row)).toContain("That's the only administrator. Make someone else an administrator first.");
    expect(row.querySelector("select")!.getAttribute("aria-invalid")).toBe("true");
    await unmount();
  });

  it("search and 'Staff only' filter the list and live in the address bar", async () => {
    window.history.replaceState(null, "", "/admin/people");
    const f = fakeAdmin({ people: () => ok(people()) });
    const { container, unmount } = await mount(<StaffPeople transport={f.transport} />);
    await check(labelled(container, "Staff only"), true);
    expect(f.of("people").at(-1)!.args[0]).toEqual({ staffOnly: true, page: 1, pageSize: 25 });
    await type(labelled(container, "Search people by name or email"), "olivia");
    await wait(350);
    expect(f.of("people").at(-1)!.args[0]).toEqual({ q: "olivia", staffOnly: true, page: 1, pageSize: 25 });
    expect(new URLSearchParams(window.location.search).get("staffOnly")).toBe("true");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("olivia");
    await unmount();
  });
});
