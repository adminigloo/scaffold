"use client";

import { useEffect, useRef, useState } from "react";
import { PLATFORMS } from "../platforms.js";
import type { DraftImage, Platform } from "../types.js";
import { canShareFiles, imageFileName } from "./share.js";

/**
 * "MAKE A VIDEO" (social 0.3): a TikTok draft's 9:16 slides as a short MP4,
 * made in the browser (../video/render.ts), then "Send video to TikTok" on a
 * phone or "Download video" anywhere. The same clip works as an Instagram
 * Reel or a YouTube Short. It has no sound: the person picks one in the app.
 * Shown only where the browser can make it and the slides are full screen.
 */

/** The clip's file name: "launch-saturdays-tiktok.mp4". */
export function videoFileName(key: string, platform: Platform): string {
  return imageFileName(key, platform, 0, 1).replace(/\.png$/, ".mp4");
}

/** Every slide tall (9:16), so the clip fills a phone's screen without cropping. */
export function fullScreenSlides(images: readonly DraftImage[]): boolean {
  return images.length > 0 && images.every((i) => i.height >= i.width * 1.7);
}

type Made = { readonly kind: "made"; readonly url: string; readonly file: File; readonly seconds: number };
type State = { readonly kind: "idle" } | { readonly kind: "making"; readonly done: number } | Made | { readonly kind: "failed"; readonly message: string };

export interface MakeVideoProps {
  readonly postKey: string;
  readonly platform: Platform;
  readonly images: readonly DraftImage[];
  /** The caption, for the share sheet and the clipboard. */
  readonly text: string;
}

export function MakeVideo({ postKey, platform, images, text }: MakeVideoProps) {
  const tall = fullScreenSlides(images);
  const [able, setAble] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const url = useRef<string | null>(null);
  const name = PLATFORMS[platform].name;

  useEffect(() => {
    if (!tall) return;
    let live = true;
    setCanShare(canShareFiles());
    import("../video/render.js")
      .then((m) => m.canMakeVideo())
      .then((ok) => live && setAble(ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tall]);

  // The clip lives in memory: let it go when the card does.
  useEffect(
    () => () => {
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  if (!tall || !able) return null;

  const make = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setNote(null);
    setState({ kind: "making", done: 0 });
    try {
      const { makeSlideshowVideo } = await import("../video/render.js");
      let shown = 0;
      const made = await makeSlideshowVideo(
        images.map((i) => i.url),
        {
          signal: controller.signal,
          onProgress: (done) => {
            // A redraw per percent, not per frame.
            if (Math.floor(done * 100) > shown) {
              shown = Math.floor(done * 100);
              setState({ kind: "making", done });
            }
          },
        },
      );
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(made.blob);
      setState({ kind: "made", url: url.current, file: new File([made.blob], videoFileName(postKey, platform), { type: "video/mp4" }), seconds: made.seconds });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") return setState({ kind: "idle" });
      setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const send = (made: Made) => {
    setNote(null);
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    navigator
      .share({ files: [made.file], text })
      .then(() => setNote(`The caption is on the clipboard: paste it in ${name}.`))
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name !== "AbortError") setNote("This phone wouldn't share the video: use Download video, then add it in the app.");
      });
  };

  if (state.kind === "making") {
    return (
      <>
        <button type="button" className="social-button" disabled>
          Making the video… {Math.round(state.done * 100)}%
        </button>
        <button type="button" className="social-button social-button-quiet" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      </>
    );
  }

  if (state.kind === "made") {
    const shareable = canShare && navigator.canShare?.({ files: [state.file] });
    return (
      <div className="social-video-made">
        {/* A preview: muted, looping, inline, as the app will show it. */}
        <video className="social-video" src={state.url} controls muted playsInline loop aria-label={`The ${name} video, ${Math.round(state.seconds)} seconds`} />
        <div className="social-actions">
          {shareable ? (
            <button type="button" className="social-button social-button-primary" onClick={() => send(state)}>
              Send video to {name}
            </button>
          ) : null}
          <a className="social-button" href={state.url} download={state.file.name}>
            Download video
          </a>
          <button type="button" className="social-button social-button-quiet" onClick={() => void make()}>
            Make it again
          </button>
        </div>
        <p className="social-note">
          {Math.round(state.seconds)} seconds, with no sound: pick one in {name} before you post. The same video works as an Instagram Reel or a YouTube Short.
        </p>
        {note ? (
          <p className="social-note" role="status">
            {note}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <button type="button" className="social-button" onClick={() => void make()}>
        {state.kind === "failed" ? "Try the video again" : "Make a video"}
      </button>
      {state.kind === "failed" ? (
        <p className="social-note" role="alert">
          The video couldn&rsquo;t be made in this browser ({state.message}). The photos still work.
        </p>
      ) : null}
    </>
  );
}
