"use client";

import { useEffect, useState } from "react";
import { PLATFORMS } from "../platforms.js";
import type { DraftImage, Platform } from "../types.js";

/**
 * A DRAFT'S IMAGES, OUT OF THE QUEUE AND INTO THE APP (social 0.3).
 *
 * On a phone, "Send to TikTok" (or "Share to X", "Send to Instagram"…) hands
 * the draft's images to the share sheet, in posting order, with the text: the
 * app opens with the pictures, a TikTok or Instagram carousel already laid
 * out. The text goes on the clipboard too, because some apps take the
 * pictures and drop the words. Nothing is posted by this package: a person
 * finishes the post in the app (TikTok asks for a sound) and taps Post.
 *
 * On a computer, "Download images" saves them, named in order, for the
 * platform's own upload page.
 *
 * A phone shares only from inside the tap, so the images are fetched as files
 * ahead of it, when the button shows.
 */

/** A draft's image as a file name, in posting order: "launch-saturdays-tiktok-2-of-4.png". */
export function imageFileName(key: string, platform: Platform, index: number, count: number): string {
  const slug =
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "post";
  return count > 1 ? `${slug}-${platform}-${index + 1}-of-${count}.png` : `${slug}-${platform}.png`;
}

/** The share button's words: "Send to TikTok" where the app is the only way in (a photo post, the link in the bio), "Share to X" elsewhere. */
export function shareLabel(platform: Platform): string {
  const rule = PLATFORMS[platform];
  return rule.linkIn === "bio" ? `Send to ${rule.name}` : `Share to ${rule.name}`;
}

/** Can this browser hand image files to a share sheet? A phone, mostly; false wherever it can't say. */
export function canShareFiles(nav: Pick<Navigator, "share" | "canShare"> | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function" || typeof File === "undefined") return false;
  try {
    return nav.canShare({ files: [new File([new Uint8Array([0])], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

/** Each image as a file, in posting order. Throws with the number of the one that didn't load. */
export async function imageFiles(images: readonly DraftImage[], key: string, platform: Platform, fetcher: typeof fetch = fetch): Promise<File[]> {
  return Promise.all(
    images.map(async (image, i) => {
      const res = await fetcher(image.url);
      if (!res.ok) throw new Error(`image ${i + 1} didn't load (${res.status})`);
      const blob = await res.blob();
      return new File([blob], imageFileName(key, platform, i, images.length), { type: blob.type || "image/png" });
    }),
  );
}

/** Save each image, one after another (a browser asks once before it saves several). */
async function downloadAll(images: readonly DraftImage[], key: string, platform: Platform): Promise<void> {
  for (const [i, image] of images.entries()) {
    const a = document.createElement("a");
    a.href = image.url;
    a.download = imageFileName(key, platform, i, images.length);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export interface ShareImagesProps {
  /** The post's key, for the file names. */
  readonly postKey: string;
  readonly platform: Platform;
  readonly images: readonly DraftImage[];
  /** What goes with the pictures: the platform's text (TikTok's caption) as typed. */
  readonly text: string;
}

/** "Send to TikTok" on a phone, "Download images" everywhere: nothing when the draft has no images. */
export function ShareImages({ postKey, platform, images, text }: ShareImagesProps) {
  // Decided in the browser, after the first paint, so the server's HTML and the phone's agree.
  const [canShare, setCanShare] = useState(false);
  const [files, setFiles] = useState<File[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const urls = images.map((i) => i.url).join("\n");

  useEffect(() => {
    setCanShare(canShareFiles());
  }, []);

  useEffect(() => {
    if (!canShare || !images.length) return;
    let live = true;
    setFiles(null);
    imageFiles(images, postKey, platform)
      .then((f) => live && setFiles(f))
      .catch(() => live && setNote("The images didn't load here: use Download images, then add them in the app."));
    return () => {
      live = false;
    };
    // The images by address: a new set of images is a new set of files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canShare, postKey, platform, urls]);

  if (!images.length) return null;

  const share = () => {
    if (!files) return;
    setNote(null);
    // The words on the clipboard as well: some apps keep the pictures and drop the text.
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    navigator
      .share({ files, text })
      .then(() => setNote(`The text is on the clipboard: paste it in ${PLATFORMS[platform].name} if it isn't there already.`))
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        setNote("This phone wouldn't share the images: use Download images, then add them in the app.");
      });
  };

  return (
    <>
      {canShare ? (
        <button type="button" className="social-button social-button-primary" disabled={!files} onClick={share}>
          {files ? shareLabel(platform) : "Getting the images…"}
        </button>
      ) : null}
      <button type="button" className="social-button" onClick={() => void downloadAll(images, postKey, platform)}>
        {images.length > 1 ? `Download ${images.length} images` : "Download image"}
      </button>
      {note ? (
        <p className="social-note" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
}
