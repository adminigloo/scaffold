import { FilesHttpError } from "./http.js";
import { formatBytes } from "./file-types.js";

/**
 * Reading an upload (D11, review G10).
 *
 * WHY COUNT THE BYTES AS THEY STREAM. `Content-Length` is a promise the
 * client makes, and a chunked request makes none. A platform with a body cap
 * (Vercel's 4.5 MB) stops a big upload before the code runs; a self-hosted
 * Node server has no cap at all, so `await req.formData()` on a 2 GB chunked
 * body holds 2 GB in memory before anything can say no. Here the body is
 * read through a counting reader that stops at the cap (`maxUploadBytes` +
 * 64 KiB of multipart framing), cancels the rest, and answers `413`; a
 * declared `Content-Length` over the cap is refused before a byte is read.
 * Only then is the multipart parsed.
 *
 * EXACTLY ONE PART, A FILE NAMED `file`. Any other part, a second file, or no
 * `file` part is "Send one file at a time." A form field nobody reads is a
 * place for a client to hide a second payload.
 */

/** Room for the multipart framing around one file: boundaries, headers, the part's name. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function tooBig(maxUploadBytes: number): FilesHttpError {
  return new FilesHttpError("file_too_big", `That file is too big. Files can be up to ${formatBytes(maxUploadBytes)}.`);
}

/** The whole body, or a 413 the moment more than `cap` bytes have arrived. `read` is how many bytes were taken from the stream. */
export async function readBodyCapped(req: Request, cap: number, maxUploadBytes: number): Promise<{ readonly bytes: Uint8Array; readonly read: number }> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > cap) throw tooBig(maxUploadBytes);
  const body = req.body;
  if (!body) return { bytes: new Uint8Array(0), read: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // Stop pulling: the rest of the body is never read into memory.
        await reader.cancel().catch(() => undefined);
        throw tooBig(maxUploadBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, read: total };
}

export interface UploadedFile {
  readonly bytes: Uint8Array;
  /** The name the browser sent, as is (the instance cleans it). */
  readonly name: string | null;
  /** The browser's type: a hint only. */
  readonly type: string | null;
}

const ONE_FILE = "Send one file at a time.";

/** One `multipart/form-data` upload with exactly one part, a file named `file`. */
export async function readSingleFileUpload(req: Request, maxUploadBytes: number): Promise<UploadedFile> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(contentType)) {
    throw new FilesHttpError("invalid", "Send the file as a form upload (multipart/form-data).");
  }
  const { bytes } = await readBodyCapped(req, maxUploadBytes + MULTIPART_OVERHEAD_BYTES, maxUploadBytes);
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new FilesHttpError("invalid", "That upload couldn't be read. Try again.");
  }
  const entries: [string, FormDataEntryValue][] = [];
  form.forEach((value, name) => {
    entries.push([name, value]);
  });
  const only = entries[0];
  if (entries.length !== 1 || !only || only[0] !== "file" || typeof only[1] === "string") throw new FilesHttpError("invalid", ONE_FILE);
  const file = only[1] as File;
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length > maxUploadBytes) throw tooBig(maxUploadBytes);
  if (data.length === 0) throw new FilesHttpError("invalid", "That file is empty.");
  return { bytes: data, name: typeof file.name === "string" && file.name !== "" ? file.name : null, type: file.type || null };
}
