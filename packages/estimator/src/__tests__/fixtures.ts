import type { OutboundEmail } from "@adminigloo/comms";
import type { EstimatorEvent } from "../events.js";
import type { EstimatorPhotoStore } from "../photos.js";
import type { TakeoffModel, TakeoffModelRequest, TakeoffModelResponse } from "../takeoff.js";

/**
 * Shared fakes for the 0.3 suites: image headers built by hand, a counting
 * takeoff model, an in-memory photo store, a recording email sender, an event
 * recorder, and Request builders. Not a suite (vitest runs *.test.ts only).
 */

// --- Images -------------------------------------------------------------------------

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/**
 * A JPEG header: SOI, an optional APP1 (Exif) segment, a COM segment carrying
 * `tag` (so two fixtures hash differently), a SOF0 — or SOF2, progressive —
 * with the dimensions, then EOI.
 */
export function jpeg(width: number, height: number, options: { tag?: string; app1?: boolean; progressive?: boolean } = {}): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (options.app1) {
    const exif = [...ascii("Exif"), 0, 0, ...new Array(20).fill(0x2a)];
    bytes.push(0xff, 0xe1, ...be16(exif.length + 2), ...exif);
  }
  const comment = ascii(options.tag ?? "fixture");
  bytes.push(0xff, 0xfe, ...be16(comment.length + 2), ...comment);
  bytes.push(0xff, options.progressive ? 0xc2 : 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes);
}

export function png(width: number, height: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const body = [...ascii("WEBP"), ...ascii(chunk), ...le32(payload.length), ...payload];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

export function webpVp8(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0, 0, 0]);
}

export function webpVp8l(width: number, height: number): Uint8Array {
  const v = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff, 0, 0, 0]);
}

export function webpVp8x(width: number, height: number): Uint8Array {
  return riff("VP8X", [0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0]);
}

export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0]);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A photo body for the routes: a 768×576 JPEG with its own tag. */
export function photo(tag: string, width = 768, height = 576): { imageBase64: string; mediaType: "image/jpeg" } {
  return { imageBase64: toBase64(jpeg(width, height, { tag })), mediaType: "image/jpeg" };
}

// --- The takeoff model ------------------------------------------------------------------

export interface FakeModel extends TakeoffModel {
  calls: TakeoffModelRequest[];
  /** What the next unknown photo answers (default: not seen). */
  fallback: unknown;
}

/**
 * A `TakeoffModel` that answers by the photo it was sent (its base64) and
 * counts every call. Reports `inputTokens` / `outputTokens` per call
 * (default 4 000 / 50: 4 250 micro-dollars at Haiku's rates). A photo mapped
 * to `"throw"` throws, like a timeout.
 */
export function fakeModel(
  answers: Record<string, unknown> = {},
  usage: { inputTokens?: number; outputTokens?: number } = {},
): FakeModel {
  const model: FakeModel = {
    model: "claude-haiku-4-5",
    rates: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
    calls: [],
    fallback: { seen: false, risers: null, riserHeightIn: null, confidence: "high" },
    async read(request: TakeoffModelRequest): Promise<TakeoffModelResponse> {
      model.calls.push(request);
      const answer = request.image.base64 in answers ? answers[request.image.base64] : model.fallback;
      if (answer === "throw") throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
      return {
        output: answer,
        inputTokens: usage.inputTokens ?? 4_000,
        outputTokens: usage.outputTokens ?? 50,
        stopReason: "end_turn",
      };
    },
  };
  return model;
}

// --- The photo store -------------------------------------------------------------------------

export interface MemoryPhotoStore extends EstimatorPhotoStore {
  files: Map<string, { tenantId: string; bytes: Uint8Array; contentType: string; filename: string }>;
  puts: number;
  deletes: number;
  failPut: boolean;
  failDelete: boolean;
}

export function memoryPhotoStore(): MemoryPhotoStore {
  let next = 0;
  const store: MemoryPhotoStore = {
    files: new Map(),
    puts: 0,
    deletes: 0,
    failPut: false,
    failDelete: false,
    async put(input) {
      if (store.failPut) throw new Error("storage is down");
      store.puts += 1;
      next += 1;
      const fileId = `file-${next}`;
      store.files.set(fileId, { ...input });
      return { fileId, url: `https://files.test/${fileId}/${input.filename}` };
    },
    async delete(input) {
      if (store.failDelete) throw new Error("storage is down");
      store.deletes += 1;
      store.files.delete(input.fileId);
    },
    urlFor(input) {
      return `${input.url}?signed=1`;
    },
  };
  return store;
}

// --- Email, events, requests -------------------------------------------------------------

/** An email sender that records every message (and can be told to fail). */
export function recordingSender() {
  const sent: OutboundEmail[] = [];
  let failing = false;
  return {
    sent,
    fail(on: boolean) {
      failing = on;
    },
    to(address: string) {
      return sent.filter((message) => message.to === address);
    },
    senders: {
      email: async (message: OutboundEmail) => {
        if (failing) throw new Error("mail server down");
        sent.push(message);
        return { id: `msg-${sent.length}` };
      },
    },
  };
}

/** Records events; `fail` makes the listener throw (after recording). */
export function eventRecorder(options: { fail?: boolean } = {}) {
  const events: EstimatorEvent[] = [];
  return {
    events,
    onEvent: async (event: EstimatorEvent) => {
      events.push(event);
      if (options.fail) throw new Error("listener broke");
    },
    types: () => events.map((event) => event.type),
  };
}

export const PUBLIC_BASE = "https://summit.test/api/estimator";
export const ADMIN_BASE = "https://summit.test/api/admin/estimator";

/** A same-origin browser request (Sec-Fetch-Site: same-origin) to a handler. */
export function request(
  method: "GET" | "POST" | "OPTIONS",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

export async function readJson<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
