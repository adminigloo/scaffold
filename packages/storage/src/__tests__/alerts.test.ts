import { describe, expect, it } from "vitest";
import { STORAGE_ALMOST_FULL_KIND, STORAGE_FULL_KIND, storageAlertKinds, storageUsageAlert } from "../alerts.js";

/**
 * Storage's alert kinds (6.15, review BO-07): almost full at 90 % (once a
 * month), full on a refusal (once a day), both to the people who manage
 * files; and the fragment passes notifications' definition rules (4.2),
 * checked STRUCTURALLY here: storage never imports notifications (2a D4).
 */

const OPTIONS = { href: "/app/files", now: new Date("2026-10-15T23:30:00Z"), platformName: "Igloo Back Office", locale: "en-US" };
const GB = 1024 ** 3;

describe("storageUsageAlert", () => {
  it("89 % → nothing", () => {
    expect(storageUsageAlert({ tenantId: "a", usage: { usedBytes: 0.89 * GB, allowanceBytes: GB }, outcome: "stored" }, OPTIONS)).toBeNull();
  });

  it("90 % → the almost-full draft, keyed by this month (UTC)", () => {
    expect(storageUsageAlert({ tenantId: "a", usage: { usedBytes: 0.9 * GB, allowanceBytes: GB }, outcome: "stored" }, OPTIONS)).toEqual({
      tenantId: "a",
      kind: STORAGE_ALMOST_FULL_KIND,
      title: "Your files are almost full: 922 MB of 1 GB used",
      body: "Delete files you no longer need in Files, or ask Igloo Back Office for more room.",
      href: "/app/files",
      dedupeKey: "storage.files.almost-full:2026-10",
      subject: null,
      actorUserId: null,
    });
  });

  it("a refusal → the full draft, keyed by today (UTC)", () => {
    expect(storageUsageAlert({ tenantId: "a", usage: { usedBytes: GB, allowanceBytes: GB }, outcome: "refused" }, OPTIONS)).toEqual({
      tenantId: "a",
      kind: STORAGE_FULL_KIND,
      title: "A file couldn't be added: your storage is full",
      body: "Delete files you no longer need in Files, or ask Igloo Back Office for more room.",
      href: "/app/files",
      dedupeKey: "storage.files.full:2026-10-15",
      subject: null,
      actorUserId: null,
    });
  });

  it("no allowance → nothing to say about room", () => {
    expect(storageUsageAlert({ tenantId: "a", usage: { usedBytes: 10 * GB, allowanceBytes: null }, outcome: "stored" }, OPTIONS)).toBeNull();
  });

  it("with the platform's address, the alert says where to write for more room (review BO-6)", () => {
    const withEmail = { ...OPTIONS, supportEmail: "help@igloo.test" };
    for (const outcome of ["stored", "refused"] as const) {
      expect(storageUsageAlert({ tenantId: "a", usage: { usedBytes: GB, allowanceBytes: GB }, outcome }, withEmail)?.body).toBe(
        "Delete files you no longer need in Files, or write to Igloo Back Office at help@igloo.test for more room.",
      );
    }
  });

  it("titles are one line (they become an email subject, D18)", () => {
    const draft = storageUsageAlert({ tenantId: "a", usage: { usedBytes: GB, allowanceBytes: GB }, outcome: "stored" }, OPTIONS);
    expect(draft?.title).not.toMatch(new RegExp("[\r\n\u2028\u2029]"));
    expect((draft?.title.length ?? 0) <= 200).toBe(true);
  });
});

/** notifications' 4.2 rules, copied as a structural check (no notifications import). */
function definitionProblems(fragment: typeof storageAlertKinds): string[] {
  const problems: string[] = [];
  const KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
  const ROUTING = /^[a-z][a-z0-9-]{1,31}$/;
  const keys = new Set<string>();
  for (const kind of fragment.kinds) {
    if (!KEY.test(kind.key) || kind.key.length > 64) problems.push(`${kind.key}: key`);
    if (keys.has(kind.key)) problems.push(`${kind.key}: duplicate`);
    keys.add(kind.key);
    if (kind.label.length < 1 || kind.label.length > 80) problems.push(`${kind.key}: label`);
    if (kind.category.length < 1 || kind.category.length > 40) problems.push(`${kind.key}: category`);
    if ((kind.description?.length ?? 0) > 200) problems.push(`${kind.key}: description`);
    if (!kind.audience.permission) problems.push(`${kind.key}: permission`);
    if (kind.email === false && kind.defaultChannel === "email") problems.push(`${kind.key}: email default on a kind never emailed`);
    if (kind.email === false && kind.emailBy === "producer") problems.push(`${kind.key}: producer email on a kind never emailed`);
    if (kind.audience.routing && !fragment.routings.some((r) => r.key === kind.audience.routing)) problems.push(`${kind.key}: unknown routing`);
  }
  for (const routing of fragment.routings) if (!ROUTING.test(routing.key)) problems.push(`${routing.key}: routing key`);
  return problems;
}

describe("storageAlertKinds", () => {
  it("passes notifications' definition rules", () => {
    expect(definitionProblems(storageAlertKinds)).toEqual([]);
  });

  it("is the contract's table: three Files kinds (the third for a share used up, review SEC-02), to files.manage, emailed by default", () => {
    expect(storageAlertKinds.kinds.map((k) => [k.key, k.label, k.category, k.audience.permission, k.defaultChannel, k.email])).toEqual([
      ["storage.files.almost-full", "Your files are almost full", "Files", "files.manage", "email", true],
      ["storage.files.full", "A file couldn't be added because storage is full", "Files", "files.manage", "email", true],
      ["storage.files.share-full", "Customers' photos couldn't be added: their part of storage is used up", "Files", "files.manage", "email", true],
    ]);
    expect(storageAlertKinds.routings).toEqual([]);
    expect(Object.isFrozen(storageAlertKinds.kinds)).toBe(true);
  });
});
