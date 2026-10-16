import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  archiveTicket,
  createEpic,
  createFeedbackAdminHandlers,
  createStaffTicket,
  createTicket,
  deleteEpic,
  EpicChangeError,
  epicProgress,
  FEEDBACK_ADMIN_ROUTES,
  findEpic,
  getEpic,
  listEpics,
  moveTicket,
  setEpicStatus,
  setEpicTickets,
  submitPayloadSchema,
  updateEpic,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * The 0.12 review's findings, each as the case that showed it:
 *
 *   M1  an epic led by someone who left the team could not be edited at all
 *   M2  a NUL character in a path id was a 500 and an error report
 *   L1  two same-name epics made at the same moment were both made
 *   L2  a delete racing an add left a ticket pointing at a deleted epic
 *   L4  an archived ticket that never finished held its epic below 100%
 *   L5  reopening an epic whose tickets were under way said "not started"
 *
 * (L3 and L6 are screens: review-0.12-ui.test.tsx.)
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ADA = { id: "u-ada", name: "Ada" };

async function intake(tenantId: string, description = "The export button does nothing at all today.") {
  return createTicket(t.db, { tenantId, payload: submitPayloadSchema.parse(report(description)) });
}

async function rowsOf(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

async function orphans(): Promise<Record<string, unknown>[]> {
  return rowsOf(sql`select id, epic_id from feedback_tickets where epic_id is not null and epic_id not in (select id from feedback_epics)`);
}

function handlers(reported: string[] = []) {
  return createFeedbackAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, _permission, tenantId) => ({ userId: `user-of-${tenantId}` }),
    staffName: () => "Ada",
    // The team today: Ada and Ben. Cy has left.
    listPeople: () => [
      { id: "u-ada", name: "Ada" },
      { id: "u-ben", name: "Ben" },
    ],
    onError: (error, context) => void reported.push(`${context.route}: ${String((error as Error)?.message ?? error)}`),
  });
}

const call = (handle: (req: Request) => Promise<Response>, tenantId: string, method: "GET" | "POST", path: string, body?: unknown) =>
  handle(
    new Request(`http://localhost/api/app/${tenantId}/feedback/v1/admin/${path}`, {
      method,
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    }),
  );

describe("M1: an epic led by someone who has left the team", () => {
  it("can still be renamed and re-dated (its leader sent back unchanged is no change), and keeps its leader", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Led by Cy", owner: { id: "u-cy", name: "Cy" } }, ADA);
    const { handle } = handlers();
    // What the 0.12.0 edit dialog sent: every field, the owner included.
    const res = await call(handle, co, "POST", `epics/${epic.id}`, { name: "Led by Cy, renamed", targetDate: "2026-12-01", ownerId: "u-cy" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await findEpic(t.db, co, epic.id)).toMatchObject({ name: "Led by Cy, renamed", targetDate: "2026-12-01", ownerId: "u-cy", ownerName: "Cy" });
  });

  it("still refuses a NEW leader who isn't on the team, and takes one who is", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Leader change", owner: { id: "u-cy", name: "Cy" } }, ADA);
    const { handle } = handlers();
    expect((await call(handle, co, "POST", `epics/${epic.id}`, { ownerId: "u-stranger" })).status).toBe(400);
    expect((await call(handle, co, "POST", `epics/${epic.id}`, { ownerId: "u-ben" })).status).toBe(200);
    expect(await findEpic(t.db, co, epic.id)).toMatchObject({ ownerId: "u-ben", ownerName: "Ben" });
  });
});

describe("M2: a NUL character in an id in the path", () => {
  it("is 'not found' on every route that reads a row — never a 500, never an error report", async () => {
    const co = tenant();
    const reported: string[] = [];
    const { handle } = handlers(reported);
    let driven = 0;
    for (const route of FEEDBACK_ADMIN_ROUTES.filter((r) => /\{/.test(r.path))) {
      const path = route.path.replace(/^v1\/admin\//, "").replace(/\{[a-z-]+\}/g, "%00");
      const body = JSON.parse(JSON.stringify(route.body ?? {}).replace(/\{[a-z-]+\}/g, "x"));
      const res = await call(handle, co, route.method, path, route.method === "POST" ? body : undefined);
      const answer = (await res.json()) as { error?: { code?: string } };
      expect([res.status, answer.error?.code], `${route.kind} ${path}`).toEqual([404, "not_found"]);
      driven += 1;
    }
    // tickets/%00, columns/%00, categories/%00, keys/%00/revoke, epics/%00 and the rest.
    expect(driven).toBeGreaterThanOrEqual(20);
    expect(reported).toEqual([]);
  });
});

describe("L1: one epic per name, even when two are made at the same moment", () => {
  it("of two same-name creates at once, exactly one is made; the other is refused in words", async () => {
    const co = tenant();
    const results = await Promise.allSettled([
      createEpic(t.db, co, { name: "Race" }, ADA),
      createEpic(t.db, co, { name: "  race " }, ADA),
      createEpic(t.db, co, { name: "RACE" }, ADA),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(EpicChangeError);
      expect((r.reason as EpicChangeError).message).toMatch(/already an epic with that name/);
    }
    expect((await listEpics(t.db, co)).map((e) => e.name)).toHaveLength(1);
  });

  it("two renames to one name at once: one wins, the other is refused in words", async () => {
    const co = tenant();
    const one = await createEpic(t.db, co, { name: "One" }, ADA);
    const two = await createEpic(t.db, co, { name: "Two" }, ADA);
    const results = await Promise.allSettled([updateEpic(t.db, co, one.id, { name: "Same" }), updateEpic(t.db, co, two.id, { name: "same" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(EpicChangeError);
  });

  it("the shipped SQL makes the same name index as the schema", async () => {
    const fromSql = await createTestDb({ sql: [readFileSync(join(__dirname, "..", "..", "sql", "feedback-0.12.0.sql"), "utf8")] });
    const def = async (db: TestDb) =>
      ((await db.client.query(`select indexdef from pg_indexes where indexname = 'feedback_epics_tenant_name_idx'`)).rows as Array<{ indexdef: string }>)[0]?.indexdef;
    expect(await def(fromSql)).toBeDefined();
    expect(await def(fromSql)).toBe(await def(t));
    await fromSql.close();
  });
});

describe("L2: a delete at the same moment as an add never leaves a ticket pointing at a deleted epic", () => {
  it("delete vs add tickets: no orphan, and the add either lands (then cleared) or is refused in words", async () => {
    const co = tenant();
    for (let round = 0; round < 4; round += 1) {
      const epic = await createEpic(t.db, co, { name: `Doomed ${round}` }, ADA);
      const kept = await intake(co);
      const racing = await intake(co);
      await setEpicTickets(t.db, co, epic.id, { add: [kept.id] }, ADA);
      const [deleted, added] = await Promise.allSettled([
        deleteEpic(t.db, co, epic.id, ADA),
        setEpicTickets(t.db, co, epic.id, { add: [racing.id] }, ADA),
      ]);
      expect(deleted.status).toBe("fulfilled");
      if (added.status === "rejected") expect(added.reason).toBeInstanceOf(EpicChangeError);
      expect(await orphans(), `round ${round}`).toEqual([]);
    }
  });

  it("delete vs New ticket into the epic: no orphan, no 500", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Doomed again" }, ADA);
    const [, made] = await Promise.allSettled([
      deleteEpic(t.db, co, epic.id, ADA),
      createStaffTicket(t.db, co, { title: "Filed as it went", epicId: epic.id }, ADA),
    ]);
    if (made.status === "rejected") expect(made.reason).toBeInstanceOf(EpicChangeError);
    expect(await orphans()).toEqual([]);
  });

  it("the database itself refuses a ticket pointing at an epic that doesn't exist, and clears its tickets when one goes", async () => {
    const co = tenant();
    const ticket = await intake(co);
    await expect(t.db.execute(sql`update feedback_tickets set epic_id = 'no-such-epic' where id = ${ticket.id}`)).rejects.toThrow();
    const epic = await createEpic(t.db, co, { name: "Removed by hand" }, ADA);
    await setEpicTickets(t.db, co, epic.id, { add: [ticket.id] }, ADA);
    await t.db.execute(sql`delete from feedback_epics where id = ${epic.id}`);
    expect((await rowsOf(sql`select epic_id from feedback_tickets where id = ${ticket.id}`))[0]?.epic_id).toBeNull();
  });
});

describe("L4: an archived ticket counts as done", () => {
  it("an epic whose only unfinished ticket was archived reads 100% and asks 'mark it completed?'", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Shelved work" }, ADA);
    const finished = await intake(co);
    const shelved = await intake(co);
    await setEpicTickets(t.db, co, epic.id, { add: [finished.id, shelved.id] }, ADA);
    await moveTicket(t.db, co, { ticketId: finished.id, statusKey: "resolved" });
    await archiveTicket(t.db, co, { ticketId: shelved.id, archivedBy: "Ada" }); // still in Open
    const detail = (await getEpic(t.db, co, epic.id))!;
    expect(detail.progress).toMatchObject({ total: 2, done: 2, open: 0, percent: 100, allDone: true });
    expect(detail.tickets.find((x) => x.id === shelved.id)?.bucket).toBe("done");
    expect((await listEpics(t.db, co)).find((e) => e.id === epic.id)?.progress).toEqual(detail.progress);
    // The rule itself, for a host counting its own tickets.
    expect(epicProgress([{ status: "open", archivedAt: new Date() }], [{ key: "open" }])).toMatchObject({ done: 1, allDone: true });
  });
});

describe("L5: reopening or restoring an epic whose tickets are under way", () => {
  it("lands on In progress, not Not started", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Back to it" }, ADA);
    const ticket = await intake(co);
    await setEpicTickets(t.db, co, epic.id, { add: [ticket.id] }, ADA);
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: "in_progress" });
    await setEpicStatus(t.db, co, epic.id, "archived");
    const restored = await setEpicStatus(t.db, co, epic.id, "open");
    expect(restored?.epic.status).toBe("in_progress");
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("in_progress");
    // With nothing under way, restoring is "not started".
    const quiet = await createEpic(t.db, co, { name: "Nothing yet" }, ADA);
    await setEpicStatus(t.db, co, quiet.id, "archived");
    expect((await setEpicStatus(t.db, co, quiet.id, "open"))?.epic.status).toBe("open");
  });
});
