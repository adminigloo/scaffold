"use client";

import { useEffect, useRef, useState } from "react";
import { PLATFORMS } from "../platforms.js";
import type { DraftImage, Platform } from "../types.js";
import { canShareFiles, imageFileName } from "./share.js";

/**
 * "MAKE A VIDEO" (social 0.3; on every platform with pictures since 0.5): a
 * draft's pictures as a short MP4, made in the browser
 * (../video/render.ts), then "Send video to TikTok" on a phone or
 * "Download video" anywhere. Since 0.5 each card's parts move their own way
 * (its look's pieces come on, then its words), and the clip is the pictures'
 * own size: TikTok's 9:16 (it works as an Instagram Reel or a YouTube Short
 * too), Instagram's and Facebook's 4:5, X's 1:1. It has no sound: the person
 * picks one in the app. Shown only where the browser can make it and the
 * pictures are all one size.
 */

/** The clip's file name: "launch-saturdays-tiktok.mp4" (or "launch-saturdays.mp4" with no platform). */
export function videoFileName(key: string, platform?: Platform): string {
  if (platform) return imageFileName(key, platform, 0, 1).replace(/\.png$/, ".mp4");
  return imageFileName(key, "x", 0, 1).replace(/-x\.png$/, ".mp4");
}

/** Every slide tall (9:16), so the clip fills a phone's screen without cropping. */
export function fullScreenSlides(images: readonly DraftImage[]): boolean {
  return images.length > 0 && images.every((i) => i.height >= i.width * 1.7);
}

/** The pictures' one size, or null when there are none or they differ (a video is one size). */
export function videoSize(images: readonly DraftImage[]): { width: number; height: number } | null {
  const first = images[0];
  if (!first || images.some((i) => i.width !== first.width || i.height !== first.height)) return null;
  return { width: first.width, height: first.height };
}

type Made = { readonly kind: "made"; readonly url: string; readonly file: File; readonly seconds: number };
type State = { readonly kind: "idle" } | { readonly kind: "making"; readonly done: number } | Made | { readonly kind: "failed"; readonly message: string };

export interface MakeVideoProps {
  readonly postKey: string;
  /** The platform it's for: its name on the buttons. Left out (a sample), the video is only downloaded. */
  readonly platform?: Platform;
  readonly images: readonly DraftImage[];
  /** The caption, for the share sheet and the clipboard. */
  readonly text?: string;
  /** The button's words; "Make a video" when left out. */
  readonly label?: string;
}

export function MakeVideo({ postKey, platform, images, text = "", label = "Make a video" }: MakeVideoProps) {
  const size = videoSize(images);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const [able, setAble] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const url = useRef<string | null>(null);
  const name = platform ? PLATFORMS[platform].name : null;

  useEffect(() => {
    if (!width || !height) return;
    let live = true;
    setCanShare(canShareFiles());
    import("../video/render.js")
      .then((m) => m.canMakeVideo(width, height))
      .then((ok) => live && setAble(ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [width, height]);

  // The clip lives in memory: let it go when the card does.
  useEffect(
    () => () => {
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  if (!size || !able) return null;

  const make = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setNote(null);
    setState({ kind: "making", done: 0 });
    try {
      const { makeCardVideo } = await import("../video/render.js");
      let shown = 0;
      const made = await makeCardVideo(
        images.map((i) => ({ url: i.url, width: i.width, height: i.height })),
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
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    navigator
      .share({ files: [made.file], ...(text ? { text } : {}) })
      .then(() => setNote(text ? `The caption is on the clipboard: paste it in ${name ?? "the app"}.` : null))
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
    const shareable = Boolean(name) && canShare && navigator.canShare?.({ files: [state.file] });
    const seconds = Math.round(state.seconds);
    return (
      <div className="social-video-made">
        {/* A preview: muted, looping, inline, as the app will show it. */}
        <video className="social-video" src={state.url} width={width} height={height} controls muted playsInline loop aria-label={`The ${name ? `${name} ` : ""}video, ${seconds} seconds`} />
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
          {fullScreenSlides(images)
            ? `${seconds} seconds, with no sound: pick one in ${name ?? "the app"} before you post. The same video works as an Instagram Reel or a YouTube Short.`
            : `${seconds} seconds at ${width}×${height}, with no sound${name ? `: post it in ${name} as a video, in place of the pictures` : ""}.`}
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
        {state.kind === "failed" ? "Try the video again" : label}
      </button>
      {state.kind === "failed" ? (
        <p className="social-note" role="alert">
          The video couldn&rsquo;t be made in this browser ({state.message}). The pictures still work.
        </p>
      ) : null}
    </>
  );
}
