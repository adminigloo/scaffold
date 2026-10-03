import { describe, expect, it } from "vitest";
import { csvCell, formatAgo, formatDuration, formatValue, toCsv } from "../dashboard.js";

describe("CSV export", () => {
  it("neutralizes formula injection from visitor-supplied cells", () => {
    expect(csvCell('=HYPERLINK("https://evil.test","x")')).toBe(`"'=HYPERLINK(""https://evil.test"",""x"")"`);
    expect(csvCell("+1 555")).toBe(`"'+1 555"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell("chatgpt.com")).toBe(`"chatgpt.com"`);
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell(42)).toBe(`"42"`);
  });

  it("joins rows with CRLF", () => {
    expect(toCsv(["Path", "Views"], [["/", 3], ["/pricing", 1]])).toBe(`"Path","Views"\r\n"/","3"\r\n"/pricing","1"`);
  });
});

describe("formatting", () => {
  it("formats durations, percents and ages", () => {
    expect(formatDuration(9_400)).toBe("9s");
    expect(formatDuration(75_000)).toBe("1m 15s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(4.25, "percent")).toBe("4.3%");
    expect(formatValue(42.4, "percent")).toBe("42%");
    expect(formatValue(12_345)).toBe("12.3K");
    const now = new Date("2026-10-02T12:00:00Z");
    expect(formatAgo(null, now)).toBe("never");
    expect(formatAgo("2026-10-02T11:59:30Z", now)).toBe("just now");
    expect(formatAgo("2026-10-02T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-09-28T12:00:00Z", now)).toBe("4 d ago");
  });
});
