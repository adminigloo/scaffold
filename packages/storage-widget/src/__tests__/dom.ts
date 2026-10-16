import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FilesTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { AttachmentsWire, FileListWire, FileWire, UploadRulesWire, UsageWire } from "../types.js";

/**
 * A tiny DOM harness (React's act + createRoot, no testing library) and fake
 * transports. COPIED from @adminigloo/comms-widget's test fakes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: ClientError["code"], message: string = code, extra: Partial<ClientError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, status: code === "network" ? 0 : code === "not_found" ? 404 : 400, ...extra },
});

export interface Call {
  method: string;
  args: unknown[];
}

export type Handlers = Partial<{ [K in keyof FilesTransport]: (...args: Parameters<FilesTransport[K]>) => unknown }>;

/** A transport whose every method records its call and answers from `handlers`. */
export function fakeTransport(handlers: Handlers) {
  const calls: Call[] = [];
  const transport = new Proxy({} as FilesTransport, {
    get(_target, prop) {
      if (prop === "contentUrl") return (id: string) => `/files/${id}/content`;
      const handler = handlers[prop as keyof FilesTransport] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}

export const RULES: UploadRulesWire = {
  available: true,
  offReason: null,
  maxBytes: 4 * 1024 * 1024,
  accept: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "application/pdf", ".heic", ".heif"],
  rule: "Photos (JPEG, PNG, WebP, GIF, HEIC) or PDFs, up to 4 MB",
};

export function fileWire(extra: Partial<FileWire> = {}): FileWire {
  return {
    id: "f1",
    name: "front porch.jpg",
    contentType: "image/jpeg",
    kind: "photo",
    sizeBytes: 412 * 1024,
    width: 2048,
    height: 1536,
    purpose: "attachment",
    purposeLabel: "Photo or file",
    record: { type: "scheduling.visit", label: "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM", href: "/app/schedule?visit=v1" },
    addedBy: "Ana",
    at: "2026-10-15T12:00:00.000Z",
    url: "/api/app/c1/files/v1/admin/files/f1/content",
    canRemove: true,
    canLink: true,
    ...extra,
  };
}

export function attachments(extra: Partial<AttachmentsWire> = {}): AttachmentsWire {
  return {
    record: { type: "scheduling.visit", label: "Visit · Pat Rivera · Tue, Nov 3, 9:00 AM", href: "/app/schedule?visit=v1" },
    files: [],
    canAdd: true,
    uploads: RULES,
    ...extra,
  };
}

export function usage(extra: Partial<UsageWire> = {}): UsageWire {
  return { usedBytes: 120 * 1024 * 1024, fileCount: 40, allowanceBytes: 5 * 1024 ** 3, ...extra };
}

export function list(extra: Partial<FileListWire> = {}): FileListWire {
  return {
    files: [],
    nextCursor: null,
    usage: usage(),
    uploads: RULES,
    canUpload: true,
    purposes: [],
    recordTypes: [],
    ...extra,
  };
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Let every resolved promise and the renders it causes run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("click: no element");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

/** Choose files in a file input the way a person does (the browser sets `files`, then fires change). */
export async function choose(input: Element | null | undefined, files: File[]): Promise<void> {
  if (!input) throw new Error("choose: no input");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

/** The first button whose text (or aria-label) matches `label`. */
export function button(container: ParentNode, label: string): HTMLButtonElement | null {
  const all = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return (
    all.find((b) => (b.textContent ?? "").trim() === label) ??
    all.find((b) => (b.getAttribute("aria-label") ?? "") === label) ??
    all.find((b) => (b.textContent ?? "").includes(label) || (b.getAttribute("aria-label") ?? "").includes(label)) ??
    null
  );
}

/** The text a person reads, whitespace collapsed. */
export function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Pin the viewport a component sees: its width, and whether the pointer is coarse (a phone). */
export function viewport(width: number, coarse: boolean): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse") ? coarse : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

export function jpegFile(name = "IMG_0001.jpg", size = 1000): File {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return new File([bytes], name, { type: "image/jpeg" });
}
