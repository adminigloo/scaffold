import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileListWire, WireErrorBody } from "../wire.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";
import { assertNoPrivateKeyLeaked, buildWorld, handlersFor, Members, readJson, request } from "./world.js";

/**
 * What a host that isn't the template meets (review FH-11): the package
 * mustn't assume the template's own permission names or pages. Ridgeline's
 * "office" role holds `files.view` (the permission the README gives for the
 * Files screen) and no `tenant.view`, which is the template's; and it has no
 * page called "company settings".
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  assertNoPrivateKeyLeaked();
  await t.close();
});

describe("the logo on a host without the template's permissions (review FH-11)", () => {
  it("someone holding files.view (and no tenant.view) is listed the logo: the list and the usage agree", async () => {
    const w = buildWorld(t);
    const members = new Members();
    const a = tenant();
    members.set(a, "office", ["files.view"]);
    const h = handlersFor(w, members);
    await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG, filename: "Company file.png" });
    await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG, filename: "Company logo" });
    const list = await readJson<FileListWire>(await h.handle(request(a, "office", "v1/admin/files")));
    expect(list.files.map((f) => f.purpose).sort()).toEqual(["company.logo", "library"]);
    expect(list.usage.fileCount).toBe(list.files.length);
    expect(members.asked.some((q) => q.permission === "tenant.view")).toBe(false);
  });

  it("the logo's 'removed where it's used' names no page of the template's; a host can name its own", async () => {
    const w = buildWorld(t);
    const members = new Members();
    const a = tenant();
    members.set(a, "owner", ["files.view", "files.manage"]);
    const logo = await w.storage.store({ tenantId: a, purpose: "company.logo", bytes: PNG });
    const plain = await handlersFor(w, members).handle(request(a, "owner", `v1/admin/files/${logo.id}/remove`, { method: "POST", json: {} }));
    expect(plain.status).toBe(409);
    const said = (await readJson<WireErrorBody>(plain)).error.message;
    expect(said).toBe("This is your logo: change it where you set it, not here.");
    expect(said).not.toMatch(/company settings/);
    const named = await handlersFor(w, members, { logoSettings: "Organization settings" }).handle(
      request(a, "owner", `v1/admin/files/${logo.id}/remove`, { method: "POST", json: {} }),
    );
    expect((await readJson<WireErrorBody>(named)).error.message).toBe("This is removed where it's used: in Organization settings.");
  });
});
