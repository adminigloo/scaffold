"use client";

import { useRef, useState } from "react";
import { api } from "@/trpc/client";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";

/** "412 KB" / "3.1 MB" — a size a human compares, not a byte count. */
function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ageOf(value: Date | string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The firm's file library, from @__SCOPE_NAME__/storage: every row is a receipt
 * in our own stored_files table, every delete removes the receipt first and
 * the bytes second. The upload posts multipart to /api/files rather than
 * through tRPC — files don't ride superjson — and the whole page degrades to
 * one sentence naming BLOB_READ_WRITE_TOKEN when storage isn't configured.
 */
export default function FilesPage() {
  const overview = api.files.overview.useQuery();
  const remove = api.files.remove.useMutation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = overview.data?.configured ?? true;
  const files = overview.data?.files ?? [];

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/files", { method: "POST", body });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `upload failed (${response.status})`);
      }
      await overview.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <>
      <PageHeader
        title="Files"
        description="Tenant-scoped storage with receipts: rows in our own database, bytes in the blob store behind the adapter."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              variant="primary"
              disabled={!configured || uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload a file"}
            </Button>
          </>
        }
      />

      {!configured && (
        <Notice tone="warn">
          File storage is not configured. Create a Blob store for this project and set{" "}
          <code className="font-mono text-[12px]">BLOB_READ_WRITE_TOKEN</code> — the library
          turns on with the variable, no deploy flag needed.
        </Notice>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      <div className="mt-4">
        {files.length === 0 ? (
          <EmptyState title="No files yet">
            Uploads land here with their size, type and owner — and deleting one removes the
            bytes along with the row.
          </EmptyState>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {files.map((file) => (
                <li key={file.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block max-w-full truncate text-sm font-medium text-ink underline-offset-2 hover:text-accent hover:underline"
                    >
                      {file.filename}
                    </a>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
                      {file.contentType} · {prettySize(file.sizeBytes)} · {ageOf(file.createdAt)}
                    </p>
                  </div>
                  <Badge tone="neutral">{file.kind}</Badge>
                  <Button
                    variant="danger"
                    disabled={remove.isPending}
                    onClick={() =>
                      void remove
                        .mutateAsync({ id: file.id })
                        .then(() => overview.refetch())
                    }
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
