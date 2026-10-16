/**
 * One route of a handler, as data (Tenancy 2a, 3.1; 2b-1, 3.1). The tests
 * read it back; the emitted isolation proof drives every row as another
 * company and expects not-found, or nothing of the first company, from each.
 *
 * Declared here, not imported from a shared package (2a D4): every feature
 * package carries the same structural shape.
 *
 * `permission: null` on a PRIVATE route means "the row it reads decides"
 * (D12): the file's record, or the record named in the query. Such a row
 * carries `access`, so the proof's role pass can work out the expected
 * answer per role instead of skipping it (review G14, BO-18).
 */
export interface StorageRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/files/{file}/content". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes, and on private routes where the row decides. */
  readonly permission: string | null;
  /** Required when `permission` is null on a private route: what the row it reads must grant (D12). */
  readonly access?: {
    /** "file": the `{file}` placeholder's file decides; "record": the `record`/`id` query's record decides. */
    readonly scope: "file" | "record";
    /** "view" (open, list, link), "manage" (remove), "add" (attach). */
    readonly needs: "view" | "manage" | "add";
  };
  /** Query parameters to send: literal values, or a placeholder like "{record-type}". */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * A minimal valid body for a POST. `{ multipart: "file" }` means a
   * multipart/form-data upload with one file part named `file`: the proof
   * and the package test send a 1×1 PNG in it.
   */
  readonly body?: unknown;
}

export type StorageAdminRouteKind =
  | "usage"
  | "files"
  | "upload"
  | "file-get"
  | "file-content"
  | "file-link"
  | "file-remove"
  | "attachments"
  | "attach";

export type StoragePublicRouteKind = "link" | "public";

function freeze<T extends readonly StorageRoute[]>(routes: T): T {
  for (const route of routes) {
    if (route.access) Object.freeze(route.access);
    if (route.query) Object.freeze(route.query);
    if (route.body && typeof route.body === "object") Object.freeze(route.body);
    Object.freeze(route);
  }
  return Object.freeze(routes) as T;
}

/**
 * Every signed-in route (6.7), in the router's own terms. Placeholders:
 * `{file}` one of A's files, `{record-type}` and `{record}` one of A's
 * records of the first installed record type.
 */
export const STORAGE_ADMIN_ROUTES: readonly StorageRoute<StorageAdminRouteKind>[] = freeze([
  { kind: "usage", method: "GET", path: "v1/admin/usage", permission: "files.view" },
  { kind: "files", method: "GET", path: "v1/admin/files", permission: "files.view" },
  { kind: "upload", method: "POST", path: "v1/admin/files", permission: "files.manage", body: { multipart: "file" } },
  { kind: "file-get", method: "GET", path: "v1/admin/files/{file}", permission: null, access: { scope: "file", needs: "view" } },
  { kind: "file-content", method: "GET", path: "v1/admin/files/{file}/content", permission: null, access: { scope: "file", needs: "view" } },
  { kind: "file-link", method: "POST", path: "v1/admin/files/{file}/link", permission: null, access: { scope: "file", needs: "view" }, body: {} },
  { kind: "file-remove", method: "POST", path: "v1/admin/files/{file}/remove", permission: null, access: { scope: "file", needs: "manage" }, body: {} },
  {
    kind: "attachments",
    method: "GET",
    path: "v1/admin/attachments",
    permission: null,
    access: { scope: "record", needs: "view" },
    query: { record: "{record-type}", id: "{record}" },
  },
  {
    kind: "attach",
    method: "POST",
    path: "v1/admin/attachments",
    permission: null,
    access: { scope: "record", needs: "add" },
    query: { record: "{record-type}", id: "{record}" },
    body: { multipart: "file" },
  },
] as const);

/**
 * The public routes (6.8), mounted at `/api/files/` in both modes: a signed
 * link (`{file-token}`) and a public file by the random part of its key
 * (`{public-key}`).
 */
export const STORAGE_PUBLIC_ROUTES: readonly StorageRoute<StoragePublicRouteKind>[] = freeze([
  { kind: "link", method: "GET", path: "v1/f/{file-token}", permission: null },
  { kind: "public", method: "GET", path: "v1/p/{public-key}", permission: null },
] as const);
