import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFilesClient, type FilesTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { PhotoEncoder } from "../shrink.js";
import type { AttachmentsWire, FileWire } from "../types.js";
import { DocumentIcon, PhotoIcon, Root, Spinner, type ChromeProps } from "../ui.js";
import { useFileActions } from "./actions.js";
import { Uploader, type DropHandlers } from "./Uploader.js";
import { formatBytes, isHeicFile, kindLabel, WORDS } from "./words.js";

/**
 * The photos and files of ONE visit, estimate or invoice (section 7): what a
 * crew member adds from their phone at the job, and what the office opens
 * from the record's page.
 *
 *   <RecordFiles baseUrl={`/api/app/${company.id}/files`} record={{ type: "scheduling.visit", id: visit.id }}
 *                hint="Your team sees these; they aren't sent to the customer." />
 *
 * Photos are thumbnails, each opening the photo in a new tab; documents (and
 * an iPhone's HEIC, which a desktop browser can't draw) are rows. On a phone
 * there are two buttons, "Take a photo" (the camera, straight away) and "Add
 * photos or files"; on a desktop, one button and drop-on-the-card. A photo
 * that doesn't send stays on screen until it does (see Uploader.tsx).
 *
 * Never throws: every failure is a sentence on the screen, and a network
 * failure has Retry. Outcomes are announced in one `role="status"` region.
 */

export interface RecordFilesProps extends ChromeProps {
  /** Where @adminigloo/storage's `createStorageHandlers` is mounted. */
  baseUrl?: string;
  /** Your own transport (wins over `baseUrl`). */
  transport?: FilesTransport;
  record: { type: string; id: string };
  /** The card's heading. Default "Photos and files". */
  title?: string;
  /** One muted line under the heading (review BO-13, BO-22), e.g. "Your team sees these; they aren't sent to the customer." */
  hint?: string | null;
  /** A "Back" link (the visit files page). */
  backHref?: string | null;
  locale?: string;
  /** Milliseconds before a photo that hit a network failure is sent again by itself. Default 3000. */
  retryDelayMs?: number;
  /** For tests and unusual browsers: the photo encoder used to shrink photos before upload. */
  photoEncoder?: PhotoEncoder;
}

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This screen isn't connected to the files server yet.", status: 0 },
};

export function missingTransport(): FilesTransport {
  const fail = () => Promise.resolve(MISSING);
  return { usage: fail, files: fail, upload: fail, file: fail, link: fail, remove: fail, attachments: fail, attach: fail, contentUrl: () => "#" };
}

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; error: ClientError };

async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
  }
}

/** A same-site path or an http(s) address: what a link on this card may point at. */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string" || href === "") return null;
  if (/^\/(?![/\\])[^\\\s\u0000-\u001f]{0,1999}$/.test(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function RecordFiles(props: RecordFilesProps) {
  const { baseUrl, transport: given, record, title = WORDS.photosAndFiles, hint, backHref, locale, retryDelayMs, photoEncoder, ...chrome } = props;
  const transport = useMemo(() => given ?? (baseUrl ? createFilesClient({ baseUrl }) : missingTransport()), [given, baseUrl]);
  const [load, setLoad] = useState<Load<AttachmentsWire>>({ state: "loading" });
  const [announce, setAnnounce] = useState("");
  const alive = useRef(true);
  const drop = useRef<DropHandlers | null>(null);
  const [, setDropReady] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const res = await safely(() => transport.attachments(record));
    if (!alive.current) return;
    setLoad(res.ok ? { state: "ready", data: res.data } : { state: "error", error: res.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, record.type, record.id]);

  useEffect(() => {
    setLoad({ state: "loading" });
    void refresh();
  }, [refresh]);

  const actions = useFileActions(transport, setAnnounce, (gone) =>
    setLoad((current) => (current.state === "ready" ? { state: "ready", data: { ...current.data, files: current.data.files.filter((f) => f.id !== gone.id) } } : current)),
  );

  const registerDrop = useCallback((handlers: DropHandlers | null) => {
    drop.current = handlers;
    setDropReady((n) => n + 1);
  }, []);

  const send = useCallback(
    (file: Blob, name: string, onProgress?: (fraction: number) => void) => transport.attach(record, file, name, onProgress),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transport, record.type, record.id],
  );

  const onAdded = useCallback(() => {
    void refresh();
  }, [refresh]);

  const back = safeHref(backHref ?? null);
  let body: React.ReactNode;
  if (load.state === "loading") {
    body = <Spinner label={WORDS.loading} />;
  } else if (load.state === "error") {
    const notFound = load.error.code === "not_found" || load.error.status === 404;
    body = (
      <div className="aifw-stack">
        <p className={`aifw-notice ${notFound ? "aifw-notice-info" : "aifw-notice-error"}`} role="alert">
          {notFound ? WORDS.notAvailable : load.error.message}
        </p>
        {notFound ? null : (
          <div className="aifw-actions">
            <button
              type="button"
              className="aifw-btn aifw-btn-secondary"
              onClick={() => {
                setLoad({ state: "loading" });
                void refresh();
              }}
            >
              {WORDS.retry}
            </button>
          </div>
        )}
      </div>
    );
  } else {
    const data = load.data;
    const photos = data.files.filter((f) => f.kind === "photo" && !isHeicFile(f));
    const documents = data.files.filter((f) => !(f.kind === "photo" && !isHeicFile(f)));
    body = (
      <>
        {data.canAdd ? (
          data.uploads.available ? (
            <Uploader
              rules={data.uploads}
              send={send}
              onAdded={onAdded}
              onStatus={setAnnounce}
              mode="record"
              registerDrop={registerDrop}
              {...(retryDelayMs !== undefined ? { retryDelayMs } : {})}
              {...(photoEncoder ? { encoder: photoEncoder } : {})}
            />
          ) : (
            <p className="aifw-notice aifw-notice-warn">{data.uploads.offReason ?? "Files can't be added right now."}</p>
          )
        ) : null}
        {data.files.length === 0 ? <p className="aifw-small">{WORDS.empty}</p> : null}
        {photos.length > 0 ? (
          <ul className="aifw-grid" aria-label="Photos">
            {photos.map((file) => (
              <li key={file.id} className="aifw-thumb">
                <a className="aifw-thumb-link" href={safeHref(file.url) ?? "#"} target="_blank" rel="noopener noreferrer">
                  <img src={safeHref(file.url) ?? ""} alt={file.name} loading="lazy" />
                </a>
                <div className="aifw-thumb-actions">{actions.buttons(file)}</div>
              </li>
            ))}
          </ul>
        ) : null}
        {documents.length > 0 ? (
          <ul className="aifw-docs" aria-label="Files">
            {documents.map((file) => (
              <DocumentRow key={file.id} file={file} locale={locale}>
                {actions.buttons(file)}
              </DocumentRow>
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  const handlers = drop.current;
  return (
    <Root {...chrome}>
      <section
        className="aifw-card"
        aria-label={title}
        onDragOver={handlers?.onDragOver}
        onDragLeave={handlers?.onDragLeave}
        onDrop={handlers?.onDrop}
      >
        <div className="aifw-head">
          {back ? (
            <a className="aifw-small" href={back}>
              {WORDS.back}
            </a>
          ) : null}
          <h2 className="aifw-h2">{title}</h2>
          {load.state === "ready" ? <span className="aifw-sub">{load.data.record.label}</span> : null}
          {hint ? <span className="aifw-small">{hint}</span> : null}
        </div>
        {body}
        <p className="aifw-sr" role="status" aria-live="polite">
          {announce}
        </p>
      </section>
      {actions.dialogs}
    </Root>
  );
}

/** One document (or HEIC) row: its icon, name, what it is and its size; it opens in a new tab. */
export function DocumentRow({ file, locale, children }: { file: FileWire; locale?: string | undefined; children?: React.ReactNode }) {
  return (
    <li className="aifw-doc">
      {isHeicFile(file) ? <PhotoIcon /> : <DocumentIcon />}
      <div className="aifw-grow">
        <a className="aifw-doc-name" href={safeHref(file.url) ?? "#"} target="_blank" rel="noopener noreferrer">
          {file.name}
        </a>
        <div className="aifw-small">
          {kindLabel(file)} · {formatBytes(file.sizeBytes, locale)}
        </div>
      </div>
      <div className="aifw-actions">{children}</div>
    </li>
  );
}
