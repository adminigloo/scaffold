import { describe, expect, it } from "vitest";
import { asOf, effectiveStatus, isOpen } from "../expiry.js";
import { queueSectionsOf } from "../sections.js";
import type { QueuedPost } from "../store.js";
import type { PostStatus } from "../types.js";
import { dayText, groupPosts, postAnchor, postView } from "../view.js";
import { life, NOW, row } from "./fixtures.js";

/**
 * ONE CARD A POST (the founder, Oct 28, 2026: eight cards a post read as the
 * same post over and over): the rows grouped by post, its platforms in
 * order, where each stands, each set of images once; the queue's sections,
 * each post in one; and a post going stale.
 */
describe("a post's platforms, grouped", () => {
  const rows = [
    row({ platform: "tiktok" }),
    row({ platform: "x", status: "approved" }),
    row({ platform: "instagram" }),
    row({ platform: "threads", status: "posted", postedUrl: "https://threads.net/p/1" }),
    row({ platform: "bluesky", hook: "A person's own hook." }),
    row({ platform: "facebook", status: "approved" }),
    row({ key: "board:2026-10-28", kind: "board", author: "Mercury", platform: "x" }),
  ];
  const groups = groupPosts(rows.map((r) => postView(r, life, NOW)));
  const results = groups[0]!;

  it("makes one post per key, in the order the rows came, each post's platforms in platform order", () => {
    expect(groups.map((g) => [g.key, g.author])).toEqual([
      ["results:2026-10-27", "Al"],
      ["board:2026-10-28", "Mercury"],
    ]);
    expect(results.platforms.map((p) => p.platform)).toEqual(["x", "threads", "bluesky", "facebook", "instagram", "tiktok"]);
    expect(results).toMatchObject({ kind: "results", day: "2026-10-28", title: "How the daily highs settled on Oct 27", open: true, expiresLabel: "Good for a day" });
  });

  it("says where its platforms stand: a chip a status, in working order", () => {
    expect(results.summary).toEqual([
      { status: "draft", count: 3 },
      { status: "approved", count: 2 },
      { status: "posted", count: 1 },
    ]);
    // "Approve all" approves the drafts, and only them: bluesky, instagram and tiktok here.
    expect(results.draftIds).toEqual(["bluesky", "instagram", "tiktok"].map((p) => results.platforms.find((r) => r.platform === p)!.id));
  });

  it("shows each set of images once, with the platforms that post it", () => {
    expect(results.imageSets.map((s) => [s.images.length, s.platforms])).toEqual([
      [1, ["x", "threads", "bluesky"]],
      [3, ["facebook", "instagram"]],
      [3, ["tiktok"]],
    ]);
  });

  it("puts the hook most platforms carry on the card, not one person's edit", () => {
    expect(results.hook).toBe("Oct 27: 1 of 3 favorites came in.");
  });

  it("has nothing to approve once every platform is posted, skipped or expired", () => {
    const done = groupPosts([row({ platform: "x", status: "posted" }), row({ platform: "threads", status: "skipped" })].map((r) => postView(r)));
    expect(done[0]).toMatchObject({ open: false, draftIds: [] });
  });
});

describe("a post going stale", () => {
  const stale = row({ key: "results:2026-10-25", day: "2026-10-26", platform: "x" });

  it("reads a draft or an approved post past its life as expired, and nothing else", () => {
    expect(effectiveStatus(stale, life, NOW)).toBe("expired");
    expect(effectiveStatus({ ...stale, status: "approved" }, life, NOW)).toBe("expired");
    for (const status of ["posted", "skipped", "expired"] as const satisfies readonly PostStatus[]) expect(effectiveStatus({ ...stale, status }, life, NOW)).toBe(status);
    expect(effectiveStatus(stale, undefined, NOW)).toBe("draft");
    expect(effectiveStatus({ ...stale, kind: "story" }, life, NOW)).toBe("draft");
    expect(isOpen("approved") && isOpen("draft") && !isOpen("expired")).toBe(true);
    const [same] = asOf([row({ platform: "x" })], life, NOW);
    expect(same!.status).toBe("draft");
  });

  it("carries the expiry to the screens", () => {
    expect(postView(stale, life, NOW)).toMatchObject({ status: "expired", expiresAt: "2026-10-27T04:00:00.000Z", expiresLabel: "Good for a day" });
    expect(postView(stale)).toMatchObject({ status: "draft", expiresAt: null, expiresLabel: null });
  });
});

describe("the queue's sections, each post in one", () => {
  const today = "2026-10-28";
  const rows = [
    // Today's results: one approved, one draft.
    row({ key: "results:2026-10-27", day: today, platform: "x", status: "approved" }),
    row({ key: "results:2026-10-27", day: today, platform: "threads" }),
    // A story from Monday, still good, half posted.
    row({ key: "story:week:2026-10-19", kind: "story", day: "2026-10-26", platform: "x", status: "posted" }),
    row({ key: "story:week:2026-10-19", kind: "story", day: "2026-10-26", platform: "threads", status: "approved" }),
    // Yesterday's board, all done.
    row({ key: "board:2026-10-27", kind: "board", day: "2026-10-27", platform: "x", status: "posted" }),
    row({ key: "board:2026-10-27", kind: "board", day: "2026-10-27", platform: "threads", status: "skipped" }),
    // Two days ago: nobody posted it. Still "draft" in the table; stale all the same.
    row({ key: "results:2026-10-25", day: "2026-10-26", platform: "x" }),
    row({ key: "results:2026-10-25", day: "2026-10-26", platform: "threads", status: "approved" }),
    // Marked expired by a build already.
    row({ key: "board:2026-10-25", kind: "board", day: "2026-10-25", platform: "x", status: "expired" }),
  ];
  const sections = queueSectionsOf([...rows, rows[0]!], { today, life, now: NOW });
  const keys = (list: readonly QueuedPost[]) => [...new Set(list.map((r) => r.key))];

  it("puts today's posts under today, whatever their status", () => {
    expect(keys(sections.today)).toEqual(["results:2026-10-27"]);
    expect(sections.today).toHaveLength(2);
  });

  it("keeps an earlier post that's still good, every platform of it, posted ones too", () => {
    expect(keys(sections.earlier)).toEqual(["story:week:2026-10-19"]);
    expect(sections.earlier.map((r) => r.status).sort()).toEqual(["approved", "posted"]);
  });

  it("files a finished post under history and a stale one under expired, newest first", () => {
    expect(keys(sections.history)).toEqual(["board:2026-10-27"]);
    expect(keys(sections.expired)).toEqual(["results:2026-10-25", "board:2026-10-25"]);
    expect(sections.expired.every((r) => r.status === "expired")).toBe(true);
  });

  it("hands a posting session only what's approved and still good", () => {
    expect(sections.ready.map((r) => r.key)).toEqual(["results:2026-10-27", "story:week:2026-10-19"]);
  });

  it("keeps a dozen past posts at most in each", () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ key: `board:2026-09-${String(i + 1).padStart(2, "0")}`, kind: "board", day: `2026-09-${String(i + 1).padStart(2, "0")}`, platform: "x" }));
    expect(keys(queueSectionsOf(many, { today, life, now: NOW }).expired)).toHaveLength(12);
  });
});

describe("the words for a day", () => {
  it("writes a day as it's written, whatever the reader's zone, and anchors a post by its key", () => {
    expect(dayText("2026-10-28")).toBe("Wed Oct 28");
    expect(dayText("not a day")).toBe("not a day");
    expect(postAnchor("story:nyc:2026-10-19")).toBe("post-story-nyc-2026-10-19");
  });
});
