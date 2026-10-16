import { useRef, useState } from "react";
import type { FilesTransport } from "../client.js";
import type { Result } from "../http.js";
import type { FileWire } from "../types.js";
import { Dialog } from "../ui.js";
import { removeQuestion, WORDS } from "./words.js";

/**
 * Copy a link and Remove, shared by `<RecordFiles>` and `<FilesManager>`.
 *
 * Remove always asks first ("Remove {name}? It's deleted for good."): the
 * bytes go from the store, not only from the list. Copy a link puts a
 * one-hour link on the clipboard; where the browser won't allow that, the
 * link is shown to copy by hand.
 */

async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
  }
}

export function useFileActions(transport: FilesTransport, onStatus: (text: string) => void, onRemoved: (file: FileWire) => void) {
  const [confirm, setConfirm] = useState<FileWire | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; url: string } | null>(null);
  const [busyLink, setBusyLink] = useState<string | null>(null);
  const linkBox = useRef<HTMLInputElement | null>(null);

  const copyLink = async (file: FileWire) => {
    setBusyLink(file.id);
    const res = await safely(() => transport.link(file.id));
    setBusyLink(null);
    if (!res.ok) {
      onStatus(res.error.message);
      return;
    }
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(res.data.url);
      onStatus(WORDS.linkCopied);
    } catch {
      setShown({ name: file.name, url: res.data.url });
    }
  };

  const remove = async () => {
    if (!confirm) return;
    setRemoving(true);
    setRemoveError(null);
    const res = await safely(() => transport.remove(confirm.id));
    setRemoving(false);
    if (!res.ok) {
      setRemoveError(res.error.message);
      return;
    }
    const gone = confirm;
    setConfirm(null);
    onStatus(`Removed ${gone.name}.`);
    onRemoved(gone);
  };

  const buttons = (file: FileWire) => (
    <>
      {file.canLink ? (
        <button type="button" className="aifw-btn aifw-btn-quiet aifw-btn-sm" disabled={busyLink === file.id} onClick={() => void copyLink(file)}>
          {WORDS.copyLink}
        </button>
      ) : null}
      {file.canRemove ? (
        <button
          type="button"
          className="aifw-btn aifw-btn-quiet aifw-btn-sm"
          aria-label={`${WORDS.remove} ${file.name}`}
          onClick={() => {
            setRemoveError(null);
            setConfirm(file);
          }}
        >
          {WORDS.remove}
        </button>
      ) : null}
    </>
  );

  const dialogs = (
    <>
      {confirm ? (
        <Dialog title={removeQuestion(confirm.name)} onClose={() => (removing ? undefined : setConfirm(null))}>
          {removeError ? (
            <p className="aifw-notice aifw-notice-error" role="alert">
              {removeError}
            </p>
          ) : null}
          <div className="aifw-actions">
            <button type="button" className="aifw-btn aifw-btn-danger" data-autofocus disabled={removing} onClick={() => void remove()}>
              {WORDS.remove}
            </button>
            <button type="button" className="aifw-btn aifw-btn-secondary" disabled={removing} onClick={() => setConfirm(null)}>
              Keep it
            </button>
          </div>
        </Dialog>
      ) : null}
      {shown ? (
        <Dialog title={`A link to ${shown.name}`} onClose={() => setShown(null)}>
          <label className="aifw-small" htmlFor="aifw-link-box">
            {WORDS.linkReady}
          </label>
          <input
            id="aifw-link-box"
            ref={linkBox}
            className="aifw-link-box"
            readOnly
            value={shown.url}
            data-autofocus
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="aifw-actions">
            <button type="button" className="aifw-btn aifw-btn-secondary" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );

  return { buttons, dialogs };
}
