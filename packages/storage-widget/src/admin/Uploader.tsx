import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { NO_SIGNAL_MESSAGE, type ClientError, type Result } from "../http.js";
import { shrinkPhoto, type PhotoEncoder } from "../shrink.js";
import type { FileResponse, UploadRulesWire } from "../types.js";
import { DocumentIcon } from "../ui.js";
import { WORDS } from "./words.js";

/**
 * Adding photos and files (section 7, review BO-05), shared by
 * `<RecordFiles>` and `<FilesManager>`.
 *
 * NO LOST PHOTO. A photo taken with "Take a photo" is usually NOT in the
 * phone's gallery: the in-memory `File` is the only copy there is. So a file
 * that fails is never dropped: it stays as a card with its preview, the
 * server's sentence (or "It didn't send. Check your signal."), "Try again"
 * (the same File again, made smaller once more if it was refused as too big)
 * and "Save to phone" (a download of the very bytes). A network failure is
 * retried once by itself after 3 seconds before the card shows. While any
 * file is still on its way, or failed, leaving the page asks first.
 *
 * Files go one at a time (a phone on one bar of signal sends one photo
 * faster than five at once), and one file's failure never stops the next.
 */

export interface UploaderProps {
  rules: UploadRulesWire;
  send: (file: Blob, name: string, onProgress?: (fraction: number) => void) => Promise<Result<FileResponse>>;
  onAdded: (response: FileResponse) => void;
  onStatus: (text: string) => void;
  /** "record": a phone gets "Take a photo" and "Add photos or files"; "library": one "Upload a file" button. */
  mode: "record" | "library";
  /** Wired by the parent to the card it sits in, so a desktop can drop files on it. */
  registerDrop?: (handlers: DropHandlers | null) => void;
  /** Milliseconds before a network failure is tried again by itself. Default 3000. */
  retryDelayMs?: number;
  /** For the tests: the photo encoder `shrinkPhoto` uses. */
  encoder?: PhotoEncoder;
  /** Told about each file that ended as a failed card (review BO-10: a storage_full refusal turns the meter to full). */
  onFailed?: (error: ClientError) => void;
}

export interface DropHandlers {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

interface Item {
  readonly key: number;
  readonly file: File;
  status: "working" | "failed";
  phase: "making" | "sending";
  progress: number;
  message: string | null;
  lastCode: ClientError["code"] | null;
  autoRetried: boolean;
  preview: string | null;
}

/** Phones (a coarse pointer, or a narrow screen) get the camera button. Desktop on the server and before mount. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      let coarse = false;
      try {
        coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      } catch {
        coarse = false;
      }
      setPhone(coarse || window.innerWidth < 640);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return phone;
}

function objectUrl(file: Blob): string | null {
  try {
    return typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

function revoke(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* nothing to free */
  }
}

let counter = 0;

/**
 * The failed card's sentence (review BO-4): the server's own sentence for a
 * refusal it explained; for no answer, the signal; for anything else (a
 * platform's timeout or crash), what to do, and that nothing is lost.
 */
export function failedSentence(error: ClientError, file: Blob): string {
  if (error.code === "network") return NO_SIGNAL_MESSAGE;
  if (error.code === "bad_response" || error.code === "internal") {
    return `It didn't send. Try again in a minute; the ${file.type.startsWith("image/") ? "photo" : "file"} is still here.`;
  }
  return error.message;
}

export function Uploader(props: UploaderProps) {
  const { rules, send, onAdded, onStatus, mode, registerDrop, retryDelayMs = 3000, encoder, onFailed } = props;
  const phone = useIsPhone();
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const filesInput = useRef<HTMLInputElement | null>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const timer of pending) clearTimeout(timer);
      for (const item of itemsRef.current) revoke(item.preview);
    };
  }, []);

  const commit = useCallback((next: Item[]) => {
    itemsRef.current = next;
    if (alive.current) setItems(next);
  }, []);
  const update = useCallback(
    (key: number, change: Partial<Item>) => commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...change } : item))),
    [commit],
  );

  // Leaving the page while a photo is on its way, or failed, asks first.
  const waiting = items.length > 0;
  useEffect(() => {
    if (!waiting || typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = WORDS.notYetAdded;
      return WORDS.notYetAdded;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [waiting]);

  // The latest props, read when a queued file's turn comes (a file chosen
  // before a re-render still goes to the transport the screen has now).
  const latest = useRef({ send, onAdded, onStatus, retryDelayMs, encoder, onFailed });
  latest.current = { send, onAdded, onStatus, retryDelayMs, encoder, onFailed };

  const run = useCallback(
    async (key: number, harder: boolean): Promise<void> => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item || !alive.current) return;
      const props = latest.current;
      update(key, { status: "working", phase: "making", progress: 0, message: null });
      const encode = props.encoder ? { encode: props.encoder } : {};
      const shrunk = await shrinkPhoto(item.file, harder ? { maxSide: 1600, quality: 0.75, minBytes: 0, ...encode } : encode);
      if (!alive.current) return;
      update(key, { phase: "sending" });
      let res: Result<FileResponse>;
      try {
        res = await props.send(shrunk.blob, shrunk.name, (fraction) => update(key, { progress: fraction }));
      } catch {
        res = { ok: false, error: { code: "network", message: NO_SIGNAL_MESSAGE, status: 0 } };
      }
      if (!alive.current) return;
      if (res.ok) {
        revoke(itemsRef.current.find((i) => i.key === key)?.preview ?? null);
        commit(itemsRef.current.filter((i) => i.key !== key));
        props.onStatus(`Added ${res.data.file.name}.`);
        props.onAdded(res.data);
        return;
      }
      const current = itemsRef.current.find((i) => i.key === key);
      if (res.error.code === "network" && current && !current.autoRetried) {
        // One retry by itself: a phone at the job often loses signal for a moment.
        update(key, { autoRetried: true, phase: "sending", progress: 0 });
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          enqueueRef.current(key, false);
        }, props.retryDelayMs);
        timers.current.add(timer);
        return;
      }
      const message = failedSentence(res.error, item.file);
      update(key, { status: "failed", message, lastCode: res.error.code });
      props.onStatus(`${item.file.name || "A file"} wasn't added. ${message}`);
      try {
        props.onFailed?.(res.error);
      } catch {
        /* a host callback must not break the queue */
      }
    },
    [update, commit],
  );

  const enqueueRef = useRef<(key: number, harder: boolean) => void>(() => undefined);
  enqueueRef.current = (key: number, harder: boolean) => {
    chain.current = chain.current.then(() => run(key, harder)).catch(() => undefined);
  };
  const enqueue = useCallback((key: number, harder: boolean) => enqueueRef.current(key, harder), []);

  const addFiles = useCallback(
    (list: FileList | readonly File[] | null) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      const added: Item[] = files.map((file) => ({
        key: (counter += 1),
        file,
        status: "working",
        phase: "making",
        progress: 0,
        message: null,
        lastCode: null,
        autoRetried: false,
        preview: file.type.startsWith("image/") && !/hei[cf]/i.test(file.type) ? objectUrl(file) : null,
      }));
      commit([...itemsRef.current, ...added]);
      for (const item of added) enqueue(item.key, false);
    },
    [commit, enqueue],
  );

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(event.target.files);
    // The same photo can be chosen again after a failure.
    event.target.value = "";
  };

  useEffect(() => {
    if (!registerDrop) return;
    registerDrop({
      onDragOver: (event) => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      },
      onDragLeave: () => setDropping(false),
      onDrop: (event) => {
        event.preventDefault();
        setDropping(false);
        addFiles(event.dataTransfer?.files ?? null);
      },
    });
    return () => registerDrop(null);
  }, [registerDrop, addFiles]);

  const tryAgain = (item: Item) => enqueue(item.key, item.lastCode === "file_too_big");
  const accept = rules.accept.join(",");

  let buttons: ReactNode;
  if (mode === "library") {
    buttons = (
      <button type="button" className="aifw-btn aifw-btn-primary" onClick={() => filesInput.current?.click()}>
        {WORDS.uploadFile}
      </button>
    );
  } else if (phone) {
    buttons = (
      <>
        <button type="button" className="aifw-btn aifw-btn-primary" onClick={() => cameraInput.current?.click()}>
          {WORDS.takePhoto}
        </button>
        <button type="button" className="aifw-btn aifw-btn-secondary" onClick={() => filesInput.current?.click()}>
          {WORDS.addPhotosOrFiles}
        </button>
      </>
    );
  } else {
    buttons = (
      <button type="button" className="aifw-btn aifw-btn-primary" onClick={() => filesInput.current?.click()}>
        {WORDS.addPhotosOrFiles}
      </button>
    );
  }

  return (
    <div className="aifw-stack aifw-drop" data-dropping={dropping ? "true" : undefined}>
      <div className="aifw-row">
        <div className="aifw-actions">{buttons}</div>
        <span className="aifw-small">
          {rules.rule}
          {mode === "record" && !phone ? ` ${WORDS.dropHere}` : ""}
        </span>
      </div>
      {mode === "record" && phone ? (
        <input
          ref={cameraInput}
          className="aifw-file-input"
          type="file"
          accept="image/*"
          capture="environment"
          tabIndex={-1}
          aria-hidden="true"
          data-aifw-input="camera"
          onChange={onPick}
        />
      ) : null}
      <input
        ref={filesInput}
        className="aifw-file-input"
        type="file"
        accept={accept}
        multiple={mode === "record"}
        tabIndex={-1}
        aria-hidden="true"
        data-aifw-input="files"
        onChange={onPick}
      />
      {items.length > 0 ? (
        <ul className="aifw-queue" aria-label="Photos and files being added">
          {items.map((item) => (
            <li key={item.key} className="aifw-pending" data-failed={item.status === "failed" ? "true" : undefined} data-aifw-pending={item.status}>
              {item.preview ? <img className="aifw-pending-preview" src={item.preview} alt="" /> : <DocumentIcon />}
              <div className="aifw-stack">
                <span className="aifw-doc-name">{item.file.name || "Photo"}</span>
                {item.status === "working" ? (
                  <>
                    <span className="aifw-small">{item.phase === "making" ? WORDS.making : WORDS.uploading}</span>
                    <div
                      className="aifw-progress"
                      role="progressbar"
                      aria-label={`Sending ${item.file.name || "photo"}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(item.progress * 100)}
                    >
                      <div className="aifw-progress-bar" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  </>
                ) : (
                  <>
                    <span className="aifw-danger-text">{item.message}</span>
                    <div className="aifw-actions">
                      <button type="button" className="aifw-btn aifw-btn-primary aifw-btn-sm" onClick={() => tryAgain(item)}>
                        {WORDS.tryAgain}
                      </button>
                      <SaveLink file={item.file} />
                    </div>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Save to phone": a download of the very bytes that didn't send, so a photo is never lost. */
function SaveLink({ file }: { file: File }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = objectUrl(file);
    setHref(url);
    return () => revoke(url);
  }, [file]);
  if (!href) return null;
  return (
    <a className="aifw-btn aifw-btn-secondary aifw-btn-sm" href={href} download={file.name || "photo.jpg"}>
      {WORDS.saveToPhone}
    </a>
  );
}
