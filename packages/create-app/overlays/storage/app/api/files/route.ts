import { FIRM_WIDE } from "__SCOPE__/permissions";
import { storeFile } from "__SCOPE__/storage";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { getBlobStore } from "@/server/blob-store";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * The upload endpoint for the staff file library — a plain route handler, not
 * a tRPC procedure, per the root router's rule: a file has no business being
 * serialised through superjson.
 *
 * Same authorization ladder the staff procedures climb, spelled out because
 * there is no `requireStaff` wrapper here to climb it for us: a verified
 * principal, then staff permissions resolved from OUR tables (never from a
 * session claim), then the same key the /admin/files page is gated on.
 *
 * 4 MB cap, below @__SCOPE_NAME__/storage's 10 MB default, because this body
 * rides one serverless invocation and the platform's own request limit is
 * the real ceiling — better to state a number we chose than to relay a 413
 * nobody can act on.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const principal = await currentPrincipal();
  if (!principal) {
    return Response.json({ error: "sign in first" }, { status: 401 });
  }
  const can = await loadStaffPermissions({ principal });
  if (!can || !can.can("staff.dashboard.view")) {
    return Response.json({ error: "not staff" }, { status: 403 });
  }

  const store = getBlobStore();
  if (!store) {
    return Response.json(
      { error: "file storage is not configured — set BLOB_READ_WRITE_TOKEN" },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "send multipart form data with a 'file' field" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `file is ${file.size} bytes; this endpoint accepts up to ${MAX_UPLOAD_BYTES}` },
      { status: 413 },
    );
  }

  const row = await storeFile(db, store, {
    tenantId: FIRM_WIDE,
    ownerId: principal.userId,
    kind: "library.file",
    filename: file.name || "file",
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    body: file,
  });

  return Response.json(row, { status: 201 });
}
