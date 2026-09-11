import { describe, expect, it } from "vitest";
import { parseBrowserInfo, parseOSInfo, RingBuffer } from "../recorder.js";

describe("RingBuffer", () => {
  it("keeps the newest entries once past capacity, in order", () => {
    const buffer = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => buffer.push(n));
    expect(buffer.toArray()).toEqual([3, 4, 5]);
  });

  it("returns entries in insertion order below capacity", () => {
    const buffer = new RingBuffer<string>(5);
    buffer.push("a");
    buffer.push("b");
    expect(buffer.toArray()).toEqual(["a", "b"]);
  });

  it("clears completely", () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
  });
});

describe("user agent parsing", () => {
  const chromeOnWindows =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const edgeOnWindows = chromeOnWindows + " Edg/120.0";
  const safariOnMac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  it("tells Edge apart from Chrome (both carry 'Chrome')", () => {
    expect(parseBrowserInfo(chromeOnWindows)).toBe("Chrome");
    expect(parseBrowserInfo(edgeOnWindows)).toBe("Edge");
  });

  it("reads OS names", () => {
    expect(parseOSInfo(chromeOnWindows)).toBe("Windows");
    expect(parseOSInfo(safariOnMac)).toBe("macOS");
  });
});
