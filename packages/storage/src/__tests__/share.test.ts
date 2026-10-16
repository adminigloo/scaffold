import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORAGE_SHARE_FULL_KIND, storageAlertKinds, storageUsageAlert } from "../alerts.js";
import { StorageError } from "../types.js";
import { createTestDb, pngOfSize, tenant, type TestDb } from "./pglite.js";
import { buildWorld, ESTIMATE_PHOTO } from "./world.js";

/**
 * A purpose's share of the allowance (review G6) and who it is for (review
 * SEC-02). The share exists so STRANGERS can't fill a company's room: the
 * estimator's customers' photos stop at a fifth. Once they had filled it,
 * staff could no longer add photos to their own estimates (the same purpose,
 * the same share), and nobody was told. Now:
 *
 *  - a share refusal reaches `onUsage` (`outcome: "share_full"`), and
 *    `storageUsageAlert` turns it into a once-a-day alert to the people who
 *    manage files;
 *  - an upload a signed-in person makes (`addedBy` set) is an ordinary file
 *    of the purpose: never refused by the share, not counted in it, and
 *    refused like any file when the company itself is full.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function refusal(promise: Promise<unknown>): Promise<StorageError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  return error as StorageError;
}

describe("a share refusal is heard (review SEC-02)", () => {
  it("onUsage hears share_full with the share's numbers, and no 'refused' (the company itself isn't full)", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(1500) });
    await refusal(w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(600) }));
    expect(w.usage.some((e) => e.outcome === "refused")).toBe(false);
    expect(w.usage.at(-1)).toEqual({
      tenantId: a,
      outcome: "share_full",
      purpose: "estimator.photo",
      usage: { usedBytes: 1500, fileCount: 1, allowanceBytes: 10_000 },
      share: { purposeLabel: "Estimate photo", usedBytes: 1500, limitBytes: 2000 },
    });
  });

  it("storageUsageAlert turns it into a once-a-day alert for the people who manage files", () => {
    const draft = storageUsageAlert(
      {
        tenantId: "a",
        usage: { usedBytes: 1500, allowanceBytes: 5 * 1024 ** 3 },
        outcome: "share_full",
        purpose: "estimator.photo",
        share: { purposeLabel: "Estimate photo", usedBytes: 1024 ** 3, limitBytes: 1024 ** 3 },
      },
      { href: "/app/files", now: new Date("2026-10-15T23:30:00Z"), platformName: "Igloo Back Office", locale: "en-US" },
    );
    expect(draft).toEqual({
      tenantId: "a",
      kind: STORAGE_SHARE_FULL_KIND,
      title: "Estimate photos can't be added: they've used their part of your storage",
      body: "Estimate photos may use up to 1 GB of your storage (1 GB used), so they can't crowd out your other files. Remove the ones you no longer need where they're used, or ask Igloo Back Office for more room.",
      href: "/app/files",
      dedupeKey: "storage.files.share-full:estimator.photo:2026-10-15",
      subject: null,
      actorUserId: null,
    });
    const kind = storageAlertKinds.kinds.find((k) => k.key === STORAGE_SHARE_FULL_KIND);
    expect(kind).toMatchObject({ category: "Files", audience: { permission: "files.manage" }, defaultChannel: "email", email: true });
  });
});

describe("a person's upload of a shared purpose is an ordinary file (review SEC-02)", () => {
  it("staff still add an estimate photo after customers filled the share", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(1900) });
    await refusal(w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(500) }));
    const staff = await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(500), addedBy: "u-gail" });
    expect([staff.purpose, staff.addedBy]).toEqual(["estimator.photo", "u-gail"]);
  });

  it("staff photos don't count toward the customers' share", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    for (let i = 0; i < 4; i += 1) await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(900), addedBy: "u-gail" });
    // 3,600 bytes of staff photos and none from customers: a customer's 1,900 still fits the 2,000 share.
    expect((await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(1900) })).addedBy).toBeNull();
  });

  it("but a person's upload is refused like any file when the company is full (the exemption is for customers' photos)", async () => {
    const w = buildWorld(t, { allowance: 2000 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(1900) });
    const error = await refusal(w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(300), addedBy: "u-gail" }));
    expect([error.code, error.share]).toEqual(["storage_full", undefined]);
    expect(w.usage.at(-1)?.outcome).toBe("refused");
    // A customer's photo still goes in: a lead (review BO-06).
    expect((await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: pngOfSize(300) })).purpose).toBe(ESTIMATE_PHOTO.key);
  });

  it("purposeStore().put takes who added it, so the estimator can say a photo is staff's", async () => {
    const w = buildWorld(t, { allowance: 10_000 });
    const a = tenant();
    const photos = w.storage.purposeStore("estimator.photo");
    await photos?.put({ tenantId: a, bytes: pngOfSize(1900), contentType: "image/png", filename: "porch.png" });
    const put = await photos?.put({ tenantId: a, bytes: pngOfSize(500), contentType: "image/png", filename: "side.png", addedBy: "u-gail" });
    expect((await w.storage.get({ tenantId: a, fileId: put?.fileId ?? "" }))?.addedBy).toBe("u-gail");
  });

  it("a purpose without a share keeps its exemption for everyone: a full company's owner still fixes the logo", async () => {
    const w = buildWorld(t, { allowance: 700 });
    const a = tenant();
    await w.storage.store({ tenantId: a, purpose: "library", bytes: pngOfSize(600) });
    expect((await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: pngOfSize(500), addedBy: "u-gail" })).purpose).toBe("company.logo");
  });
});
