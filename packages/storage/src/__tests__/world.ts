import { createStorageHandlers, type CreateStorageHandlersOptions } from "../handlers.js";
import { createStorageLinkHandlers } from "../link-handlers.js";
import { createStorage, type CreateStorageOptions, type Storage } from "../instance.js";
import { createMemoryBlobStore, type MemoryBlobStore } from "../memory.js";
import { STORAGE_BUILT_IN_PURPOSES, type StoragePurpose } from "../purposes.js";
import type { StorageRecordInfo, StorageRecordType } from "../records.js";
import type { StorageUsageEvent } from "../types.js";
import type { TestDb } from "./pglite.js";

/**
 * The world the service and handler suites share: two memory stores, three
 * record types over in-memory records (each answering only its own
 * company's), an estimator-shaped photo purpose, members with permissions
 * per company (a fake `authorize` that behaves like 2a's gate: a Response
 * for the signed-out and for non-members, false for a missing permission),
 * and the requests a browser would send.
 */

/** The estimator's photo purpose (10.5), as the estimator declares it: structurally. */
export const ESTIMATE_PHOTO: StoragePurpose = {
  key: "estimator.photo",
  label: "Estimate photo",
  access: "private",
  types: ["jpeg", "png", "webp"],
  maxBytes: 4 * 1024 * 1024,
  exemptFromAllowance: true,
  maxShareOfAllowance: 0.2,
  view: ["estimator.view"],
  removableFromFiles: false,
  hiddenUntilAttached: true,
};

export const SECRET = "test-signing-secret-of-thirty-two-plus-characters";

export interface FakeRecords {
  readonly types: readonly StorageRecordType[];
  readonly finds: { type: string; tenantId: string; ids: string[] }[];
  add(type: string, tenantId: string, id: string, info: { label: string; href?: string | null; assignedUserIds?: string[] }): void;
  remove(type: string, tenantId: string, id: string): void;
}

export function fakeRecords(): FakeRecords {
  const rows = new Map<string, StorageRecordInfo>();
  const finds: { type: string; tenantId: string; ids: string[] }[] = [];
  const make = (type: string, label: string, pluralLabel: string, view: string[], manage: string[], assigned?: string): StorageRecordType => ({
    type,
    label,
    pluralLabel,
    view,
    manage,
    ...(assigned ? { assigned: { permission: assigned } } : {}),
    async find({ tenantId, ids }) {
      finds.push({ type, tenantId, ids: [...ids] });
      const out = new Map<string, StorageRecordInfo>();
      for (const id of ids) {
        const found = rows.get(`${type}|${tenantId}|${id}`);
        if (found) out.set(id, found);
      }
      return out;
    },
  });
  return {
    types: [
      make("scheduling.visit", "Visit", "Visits", ["schedule.view"], ["schedule.manage"], "schedule.route"),
      make("estimator.estimate", "Estimate", "Estimates", ["estimator.view"], ["estimator.estimates.manage"]),
      make("invoicing.invoice", "Invoice", "Invoices", ["invoices.view"], ["invoices.manage"]),
    ],
    finds,
    add(type, tenantId, id, info) {
      rows.set(`${type}|${tenantId}|${id}`, { label: info.label, href: info.href ?? null, assignedUserIds: info.assignedUserIds ?? [] });
    },
    remove(type, tenantId, id) {
      rows.delete(`${type}|${tenantId}|${id}`);
    },
  };
}

export interface World {
  readonly storage: Storage;
  readonly priv: MemoryBlobStore;
  readonly pub: MemoryBlobStore;
  readonly records: FakeRecords;
  readonly errors: { error: unknown; step: string; tenantId: string | null }[];
  readonly usage: StorageUsageEvent[];
  readonly clock: { now: Date };
  /** Who passes a link's stillValid: "{tenant}|{user}" entries. */
  readonly valid: Set<string>;
}

// ---------------------------------------------------------------------------
// D10, suite-wide: a PRIVATE object's key never leaves the server. Every
// private key a world's store is handed, and every answer a handler built by
// `handlersFor` / `linksFor` gives, is recorded; each suite that drives the
// handlers ends with `assertNoPrivateKeyLeaked()` in an afterAll.
// ---------------------------------------------------------------------------

const privateKeysHanded = new Set<string>();
const answersSeen: string[] = [];

async function captured(res: Response): Promise<Response> {
  try {
    answersSeen.push(await res.clone().text(), [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"));
  } catch {
    /* a body already read by the handler's caller: its headers were still seen */
  }
  return res;
}

export function assertNoPrivateKeyLeaked(): void {
  for (const key of privateKeysHanded) {
    const random = key.split("/").at(-1)?.split(".")[0] ?? key;
    for (const answer of answersSeen) {
      if (answer.includes(key) || answer.includes(random)) throw new Error(`An answer carried a private key (${key}).`);
    }
  }
}

export function buildWorld(t: TestDb, extra: Partial<CreateStorageOptions> & { readonly allowance?: number | null } = {}): World {
  const priv = createMemoryBlobStore({ access: "private" });
  const put = priv.put.bind(priv);
  priv.put = async (key, bytes, options) => {
    privateKeysHanded.add(key);
    return put(key, bytes, options);
  };
  const pub = createMemoryBlobStore({ access: "public" });
  const records = fakeRecords();
  const errors: World["errors"] = [];
  const usage: StorageUsageEvent[] = [];
  const clock = { now: new Date("2026-10-15T12:00:00.000Z") };
  const valid = new Set<string>();
  const { allowance, ...rest } = extra;
  const storage = createStorage({
    db: t.db,
    tables: t.tables,
    stores: { private: priv, public: pub },
    purposes: [...STORAGE_BUILT_IN_PURPOSES, ESTIMATE_PHOTO],
    records: records.types,
    urls: {
      content: (tenantId, fileId) => `/api/app/${tenantId}/files/v1/admin/files/${fileId}/content`,
      publicBase: "https://app.test/api/files",
    },
    signing: { secret: SECRET, stillValid: async ({ tenantId, userId }) => valid.has(`${tenantId}|${userId}`) },
    onError: (error, context) => {
      errors.push({ error, step: context.step, tenantId: context.tenantId });
    },
    onUsage: (event) => {
      usage.push(event);
    },
    now: () => clock.now,
    ...(allowance !== undefined ? { allowanceBytes: () => allowance } : {}),
    ...rest,
  });
  return { storage, priv, pub, records, errors, usage, clock, valid };
}

/** Members per company: who holds what. A request names its person in `x-user`. */
export class Members {
  private readonly grants = new Map<string, Set<string>>();
  readonly asked: { permission: string; tenantId: string; userId: string | null }[] = [];
  set(tenantId: string, userId: string, permissions: readonly string[]): void {
    this.grants.set(`${tenantId}|${userId}`, new Set(permissions));
  }
  drop(tenantId: string, userId: string): void {
    this.grants.delete(`${tenantId}|${userId}`);
  }
  authorize = (req: Request, permission: string, tenantId: string) => {
    const userId = req.headers.get("x-user");
    this.asked.push({ permission, tenantId, userId });
    if (!userId) return Response.json({ error: { code: "forbidden", message: "You have been signed out." } }, { status: 401 });
    const held = this.grants.get(`${tenantId}|${userId}`);
    if (!held) return Response.json({ error: { code: "forbidden", message: "You are not part of this company." } }, { status: 403 });
    return held.has(permission) ? { userId } : false;
  };
}

export const OWNER_PERMISSIONS = [
  "files.view",
  "files.manage",
  "schedule.view",
  "schedule.manage",
  "estimator.view",
  "estimator.estimates.manage",
  "invoices.view",
  "invoices.manage",
  "tenant.view",
];
export const MEMBER_PERMISSIONS = ["files.view", "schedule.view", "estimator.view", "invoices.view", "tenant.view"];
export const CREW_PERMISSIONS = ["schedule.route"];

/** `/api/app/{tenant}/files/`: the companies mount. */
export function resolveFromPath(req: Request): string | null {
  const match = /\/api\/app\/([^/]+)\/files\//.exec(new URL(req.url).pathname);
  return match ? decodeURIComponent(match[1] as string) : null;
}

export function handlersFor(world: World, members: Members, extra: Partial<CreateStorageHandlersOptions> = {}) {
  const handlers = createStorageHandlers({
    storage: world.storage,
    resolveTenant: resolveFromPath,
    authorize: members.authorize,
    names: async (_tenantId, ids) => new Map(ids.map((id) => [id, `Person ${id}`])),
    companyName: async () => "Green Acres",
    now: () => world.clock.now,
    ...extra,
  });
  return { handle: async (req: Request) => captured(await handlers.handle(req)) };
}

/** The public handlers over a world, every answer recorded for the suite-wide key check. */
export function linksFor(world: World) {
  const links = createStorageLinkHandlers({ storage: world.storage });
  return { handle: async (req: Request) => captured(await links.handle(req)) };
}

export interface RequestInitLite {
  method?: string;
  query?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
  body?: BodyInit;
  duplex?: boolean;
}

export function request(tenantId: string, userId: string | null, path: string, init: RequestInitLite = {}): Request {
  const url = new URL(`https://app.test/api/app/${encodeURIComponent(tenantId)}/files/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(userId ? { "x-user": userId } : {}), ...(init.headers ?? {}) };
  let payload: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(init.json);
  }
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
    ...(init.duplex ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** A multipart upload with one file part named `field` (default `file`), plus any `extra` parts. */
export function upload(
  tenantId: string,
  userId: string | null,
  path: string,
  bytes: Uint8Array,
  options: { filename?: string; type?: string; field?: string; query?: Record<string, string>; extra?: [string, string | Blob][] } = {},
): Request {
  const form = new FormData();
  form.append(options.field ?? "file", new Blob([bytes as BlobPart], { type: options.type ?? "image/png" }), options.filename ?? "photo.png");
  for (const [k, v] of options.extra ?? []) form.append(k, v);
  return request(tenantId, userId, path, { method: "POST", body: form, ...(options.query ? { query: options.query } : {}) });
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
