import { describe, expect, it } from "vitest";
import {
  getTemplate,
  requireEmailSubject,
  seedDefaultTemplates,
  setTemplateActive,
  upsertTemplate,
  upsertTemplateSchema,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

const T = "t1";

describe("upsertTemplate", () => {
  it("refuses an email template with no subject", async () => {
    const { db } = createFakeDb();
    await expect(upsertTemplate(db, { tenantId: T, key: "confirm", channel: "email", subject: "  ", body: "Hi" })).rejects.toThrow(
      /needs a subject/,
    );
    await expect(upsertTemplate(db, { tenantId: T, key: "confirm", body: "Hi" })).rejects.toThrow(/needs a subject/);
  });

  it("allows an SMS template with no subject", async () => {
    const { db } = createFakeDb();
    const row = await upsertTemplate(db, { tenantId: T, key: "text", channel: "sms", body: "Hi" });
    expect(row).toMatchObject({ channel: "sms", subject: null, isActive: true });
  });

  it("does NOT switch a deactivated template back on when its wording is edited", async () => {
    const { db } = createFakeDb();
    await upsertTemplate(db, { tenantId: T, key: "confirm", subject: "Hi", body: "v1" });
    expect(await setTemplateActive(db, T, "confirm", false)).toBe(true);
    const edited = await upsertTemplate(db, { tenantId: T, key: "confirm", subject: "Hi", body: "v2" });
    expect(edited).toMatchObject({ body: "v2", isActive: false });
    expect((await getTemplate(db, T, "confirm"))?.isActive).toBe(false);
  });

  it("the exported rule applies to a host's derived input schema", () => {
    const hostInput = upsertTemplateSchema.omit({ tenantId: true }).superRefine(requireEmailSubject);
    expect(hostInput.safeParse({ key: "confirm", channel: "email", body: "Hi" }).success).toBe(false);
    expect(hostInput.safeParse({ key: "confirm", channel: "email", subject: "Hi", body: "Hi" }).success).toBe(true);
  });
});

describe("setTemplateActive", () => {
  it("reports false for a template the tenant does not have", async () => {
    const { db } = createFakeDb();
    await upsertTemplate(db, { tenantId: "other", key: "confirm", subject: "Hi", body: "v1" });
    expect(await setTemplateActive(db, T, "confirm", false)).toBe(false);
    expect((await getTemplate(db, "other", "confirm"))?.isActive).toBe(true);
  });
});

describe("seedDefaultTemplates", () => {
  it("is race-safe and idempotent: a second seed inserts nothing and does not throw", async () => {
    const fake = createFakeDb();
    const [a, b] = await Promise.all([seedDefaultTemplates(fake.db, T), seedDefaultTemplates(fake.db, T)]);
    expect(a + b).toBe(3);
    expect(await seedDefaultTemplates(fake.db, T)).toBe(0);
    expect(fake.rows("comms_templates")).toHaveLength(3);
  });
});
