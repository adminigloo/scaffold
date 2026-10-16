import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilesManager, RecordFiles, UsageMeter } from "../admin/index.js";
import { fakeTransport } from "./dom.js";

/**
 * Server rendering (section 7: SSR-safe). In a plain Node environment (no
 * window, no document), every component renders its first frame without
 * touching a browser API: the loading state, the theme left to the media
 * query, the desktop layout.
 */

describe("SSR", () => {
  it("renders all three with no DOM", () => {
    expect(typeof document).toBe("undefined");
    const { transport } = fakeTransport({});
    const record = renderToStaticMarkup(<RecordFiles transport={transport} record={{ type: "scheduling.visit", id: "v1" }} />);
    expect(record).toContain("aifw-root");
    expect(record).toContain("Photos and files");
    expect(record).toContain("Loading photos and files");
    const files = renderToStaticMarkup(<FilesManager transport={transport} />);
    expect(files).toContain("Files");
    const meter = renderToStaticMarkup(<UsageMeter usage={{ usedBytes: 1024, fileCount: 1, allowanceBytes: 2048 }} />);
    expect(meter).toContain('role="meter"');
    expect(meter).toContain("Using 1 KB of 2 KB");
  });
});
