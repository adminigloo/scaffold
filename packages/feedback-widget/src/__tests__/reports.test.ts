import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReports, removeReport, saveReport, type StoredReport } from "../reports.js";

const KEY = "aik_" + "ab".repeat(20);

/**
 * A Map with localStorage's shape. The suite runs in node, where localStorage
 * does not exist — which doubles as the test of the module's first promise:
 * with no storage at all, every call returns instead of throwing.
 */
function stubStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  });
  return backing;
}

function report(n: number): StoredReport {
  return {
    ticketNumber: `FB-${String(n).padStart(5, "0")}`,
    title: `Report ${n}`,
    token: "aft_" + "cd".repeat(20),
    createdAt: n,
  };
}

describe("the report registry", () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a report, newest first", () => {
    saveReport(KEY, report(1));
    saveReport(KEY, report(2));
    expect(loadReports(KEY).map((r) => r.ticketNumber)).toEqual(["FB-00002", "FB-00001"]);
  });

  it("replaces a re-saved ticket instead of duplicating it", () => {
    saveReport(KEY, report(1));
    saveReport(KEY, { ...report(1), title: "Updated" });
    const reports = loadReports(KEY);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.title).toBe("Updated");
  });

  it("caps the list, dropping the oldest", () => {
    for (let n = 1; n <= 25; n++) saveReport(KEY, report(n));
    const reports = loadReports(KEY);
    expect(reports).toHaveLength(20);
    expect(reports[0]?.ticketNumber).toBe("FB-00025");
    expect(reports.at(-1)?.ticketNumber).toBe("FB-00006");
  });

  it("removes an entry the platform no longer recognises", () => {
    saveReport(KEY, report(1));
    saveReport(KEY, report(2));
    const remaining = removeReport(KEY, "FB-00001");
    expect(remaining.map((r) => r.ticketNumber)).toEqual(["FB-00002"]);
    expect(loadReports(KEY).map((r) => r.ticketNumber)).toEqual(["FB-00002"]);
  });

  it("keeps two installs' lists apart", () => {
    const otherKey = "aik_" + "ff".repeat(20);
    saveReport(KEY, report(1));
    saveReport(otherKey, report(2));
    expect(loadReports(KEY)).toHaveLength(1);
    expect(loadReports(otherKey)).toHaveLength(1);
    expect(loadReports(KEY)[0]?.ticketNumber).toBe("FB-00001");
  });

  it("returns empty on corrupted storage instead of throwing", () => {
    const backing = stubStorage();
    saveReport(KEY, report(1));
    const storageKey = [...backing.keys()][0] ?? "";
    backing.set(storageKey, "{not json");
    expect(loadReports(KEY)).toEqual([]);
    backing.set(storageKey, JSON.stringify([{ ticketNumber: 42 }, report(2)]));
    // A malformed entry is dropped; a valid neighbour survives.
    expect(loadReports(KEY).map((r) => r.ticketNumber)).toEqual(["FB-00002"]);
  });

  it("survives an environment with no storage at all", () => {
    vi.unstubAllGlobals();
    // node has no localStorage: every call must degrade, never throw —
    // a feedback tool that crashes the page it reports on has inverted its job.
    expect(loadReports(KEY)).toEqual([]);
    expect(() => saveReport(KEY, report(1))).not.toThrow();
    expect(() => removeReport(KEY, "FB-00001")).not.toThrow();
  });
});
