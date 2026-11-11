"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

/** One picture in the viewer: a card as stored, and what to call it. */
export interface ViewerImage {
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  /** Which set or slide it is ("Facebook · Instagram, 2 of 3"). */
  readonly label?: string;
}

type Mode = "one" | "all";

/**
 * THE IMAGE VIEWER (social 0.5; the founder, Nov 5, 2026: "a modal pop up where
 * i can scroll through them or see them side by side instead of opening up a
 * new browser window"). One picture at a time, with arrows and the ← → keys,
 * or every picture side by side in a row that scrolls; a picture in the row
 * opens on its own. Esc, the close button or the backdrop closes it.
 *
 * A native `<dialog>` opened with `showModal()`: it sits in the top layer over
 * any app's chrome without a portal (this package doesn't depend on
 * react-dom), keeps focus inside, takes Esc, and gives focus back to the
 * picture it was opened from. It is an in-page modal, never a browser alert.
 * The page behind doesn't scroll while it's open.
 *
 * `data-feedback-overlay` and `data-html-to-image-ignore` are what an
 * AdminIgloo app's feedback screenshot looks for, so a report taken over the
 * viewer shows it.
 */
export function ImageViewer({
  images,
  start,
  onClose,
}: {
  readonly images: readonly ViewerImage[];
  readonly start: number;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, images.length - 1)));
  const [mode, setMode] = useState<Mode>("one");
  const count = images.length;
  const image = images[index];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  const step = useCallback((by: number) => setIndex((i) => Math.min(Math.max(0, i + by), count - 1)), [count]);

  if (!image) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (mode !== "one" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    }
  };

  // The backdrop is the dialog's own box around the panel: a click there closes it.
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="social-viewer"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
    >
      <div className="social-viewer-panel" data-feedback-overlay data-html-to-image-ignore>
        <div className="social-viewer-bar">
          <h2 id={titleId} className="social-viewer-title">
            {mode === "one" && count > 1 ? `${index + 1} of ${count}` : count === 1 ? "Image" : `${count} images`}
            {mode === "one" && image.label ? <span className="social-viewer-label">{image.label}</span> : null}
          </h2>
          {count > 1 ? (
            <div className="social-viewer-modes" role="group" aria-label="How to show them">
              <button type="button" className="social-button" aria-pressed={mode === "one"} onClick={() => setMode("one")}>
                One at a time
              </button>
              <button type="button" className="social-button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
                Side by side
              </button>
            </div>
          ) : null}
          <button type="button" className="social-button social-viewer-close" onClick={onClose} aria-label="Close" autoFocus>
            ✕
          </button>
        </div>

        {mode === "one" ? (
          <div className="social-viewer-stage" data-steps={count > 1 || undefined}>
            {count > 1 ? (
              <button type="button" className="social-button social-viewer-step" onClick={() => step(-1)} disabled={index === 0} aria-label="Previous image">
                ‹
              </button>
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element -- a card PNG at its own size; this drops into any React app */}
            <img src={image.url} alt={image.alt} width={image.width} height={image.height} />
            {count > 1 ? (
              <button type="button" className="social-button social-viewer-step" onClick={() => step(1)} disabled={index === count - 1} aria-label="Next image">
                ›
              </button>
            ) : null}
          </div>
        ) : (
          <ol className="social-viewer-strip" aria-label="Side by side">
            {images.map((item, i) => (
              <li key={`${i}:${item.url}`}>
                <button
                  type="button"
                  className="social-viewer-pick"
                  onClick={() => {
                    setIndex(i);
                    setMode("one");
                  }}
                  aria-label={`Open ${item.label ?? `image ${i + 1}`} on its own`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt={item.alt} width={item.width} height={item.height} loading="lazy" />
                </button>
                {item.label ? <span>{item.label}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </dialog>
  );
}

/**
 * The viewer's state for one screen: `open(images, start)` shows it, and
 * `viewer` is what to render (nothing while it's closed).
 */
export function useImageViewer(): { readonly open: (images: readonly ViewerImage[], start: number) => void; readonly viewer: ReactNode } {
  const [shown, setShown] = useState<{ images: readonly ViewerImage[]; start: number } | null>(null);
  const open = useCallback((images: readonly ViewerImage[], start: number) => setShown({ images, start }), []);
  const viewer = shown ? <ImageViewer images={shown.images} start={shown.start} onClose={() => setShown(null)} /> : null;
  return { open, viewer };
}

/**
 * A picture's link opens the viewer on a plain click; Ctrl/Cmd/Shift-click and
 * the middle button still open the image itself, as a link does.
 */
export function viewOnPlainClick(open: () => void): (e: MouseEvent<HTMLAnchorElement>) => void {
  return (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  };
}
