import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { life, NOW, row } from "../../__tests__/fixtures.js";
import { postAnchor, postView } from "../../view.js";
import { PostQueue } from "../PostQueue.js";

/**
 * THE QUEUE ON A PAGE (src/social/ui), as the server draws it before any
 * click: one card a post, a tab a platform, the first draft's tab open,
 * "Approve all" for the post's drafts, and why it's empty when it is.
 */
describe("the queue on a page", () => {
  const rows = [row({ platform: "x" }), row({ platform: "threads", status: "approved" }), row({ platform: "instagram" }), row({ key: "board:2026-10-28", kind: "board", author: "Mercury", platform: "x" })];
  const noop = async () => undefined;
  const html = renderToStaticMarkup(h(PostQueue, { posts: rows.map((r) => postView(r, life, NOW)), actions: { save: noop, approve: noop, markPosted: noop, skip: noop }, kinds: { results: "Yesterday's results" } }));

  it("draws one card a post, with a tab a platform and the first draft's tab open", () => {
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*data-status="draft"[^>]*>.*?X/);
    expect(html).toContain(`id="${postAnchor("results:2026-10-27")}"`);
    expect(html).toContain("Yesterday&#x27;s results");
    // The kind as written where the app gave no words for it.
    expect(html).toContain("Board");
  });

  it("offers Approve all for the post's drafts, and says where each platform stands", () => {
    expect(html).toContain("Approve all (2)");
    expect(html).toContain("2 drafts");
    expect(html).toContain("1 approved");
    expect(html).toContain("Good for a day.");
  });

  it("is read and copy without actions: no box to type in, no button that changes a post", () => {
    const readOnly = renderToStaticMarkup(h(PostQueue, { posts: rows.map((r) => postView(r, life, NOW)), kinds: { results: "Yesterday's results" } }));
    expect(readOnly.match(/<article/g)).toHaveLength(2);
    expect(readOnly).toContain("Copy text");
    expect(readOnly).toContain("2 drafts");
    for (const control of ["<textarea", "<input", "<form", "Approve all", ">Approve<", "Save edits", ">Skip<", "Mark posted", ">Open X<"]) expect(readOnly, control).not.toContain(control);
    // With them, every one is there.
    for (const control of ["<textarea", "Approve all (2)", ">Approve<", ">Skip<", "Mark posted", ">Open X<"]) expect(html, control).toContain(control);
  });

  it("says why when there's nothing", () => {
    expect(renderToStaticMarkup(h(PostQueue, { posts: [], actions: { save: noop, approve: noop, markPosted: noop, skip: noop }, empty: "Nothing yet: the board comes at 10 AM." }))).toContain("Nothing yet: the board comes at 10 AM.");
  });
});
