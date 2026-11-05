/* eslint-disable @next/next/no-img-element -- the cards are PNGs from the app's own card route, shown at their own size */
"use client";

import type { CardFormatImage, CardFormatSet, LookChoices } from "../wire.js";
import { LookControls } from "./LookControls.js";
import { SocialStyles } from "./styles.js";
import { MakeVideo } from "./video.js";
import { useImageViewer, viewOnPlainClick } from "./viewer.js";

/**
 * EVERY CARD FORMAT AT ONCE: the quote card at 1:1 and 4:5, and each
 * carousel at 4:5 and 9:16, drawn by the same signed route the posts use.
 * Samples only: made-up words, nothing here is posted. Each opens the viewer
 * with its set (social 0.5), and a set in one of the app's looks can be made
 * into a video at each of its sizes, to see how the look moves.
 *
 * With the app's looks (social 0.7) every format shows in one look at a time,
 * chosen with the same two controls a post has (the background, and the
 * switch over it), where a set per look was too much to read.
 */

/** "9:16" for a 1080 × 1920 card. */
function ratioOf(width: number, height: number): string {
  const r = height / width;
  if (Math.abs(r - 1) < 0.01) return "1:1";
  if (Math.abs(r - 1.25) < 0.01) return "4:5";
  if (Math.abs(r - 16 / 9) < 0.01) return "9:16";
  return `${width}×${height}`;
}

/** A set's pictures by size, in the order the sizes first come. */
function bySize(images: readonly CardFormatImage[]): { ratio: string; images: CardFormatImage[] }[] {
  const groups = new Map<string, { ratio: string; images: CardFormatImage[] }>();
  for (const image of images) {
    const key = `${image.width}x${image.height}`;
    const group = groups.get(key) ?? { ratio: ratioOf(image.width, image.height), images: [] };
    group.images.push(image);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Does a card wear one of the app's looks? Its signed address names it. */
function wearsLook(image: CardFormatImage): boolean {
  try {
    return new URL(image.url, "https://card.invalid").searchParams.has("look");
  } catch {
    return false;
  }
}
export function CardFormats({
  sets,
  looks,
  look,
  onLook,
  loading = false,
}: {
  readonly sets: readonly CardFormatSet[];
  /** The app's looks (social 0.7): the formats show in `look`, and `onLook` asks for them in another. */
  readonly looks?: LookChoices;
  readonly look?: string | null;
  readonly onLook?: (look: string) => void;
  /** Another look's formats are on their way. */
  readonly loading?: boolean;
}) {
  const { open, viewer } = useImageViewer();
  return (
    <div className="social social-formats">
      <SocialStyles />
      <p className="social-section-hint">Every card on this page is a sample: the words and numbers are made up, to show the formats. A real post&rsquo;s cards are drawn from its own words.</p>
      {looks?.options.length && onLook ? (
        <div className="social-look-row">
          <LookControls id="social-formats-look" choices={looks} value={look ?? ""} onChange={onLook} disabled={loading} />
          {loading ? (
            <span className="social-note" role="status">
              Drawing the cards…
            </span>
          ) : null}
        </div>
      ) : null}
      {sets.length === 0 ? <p className="social-empty">No card formats to show.</p> : null}
      {sets.map((set) => (
        <section key={set.key} className="social-format-set" aria-labelledby={`social-formats-${set.key}`} data-sample-set={set.key}>
          <h3 id={`social-formats-${set.key}`} className="social-group-title">
            {set.title}
            <span className="social-sample-chip">Sample</span>
          </h3>
          <p className="social-section-hint">{set.about}</p>
          <ol className="social-format-images">
            {set.images.map((image, i) => {
              const shown = image.height > image.width * 1.5 ? 180 : 220;
              return (
                <li key={`${i}:${image.url}`}>
                  <a href={image.url} target="_blank" rel="noopener noreferrer" title="View the images" onClick={viewOnPlainClick(() => open(set.images, i))}>
                    <img src={image.url} alt={image.alt} width={shown} height={Math.round((shown * image.height) / image.width)} loading="lazy" />
                  </a>
                  <span>{image.label}</span>
                </li>
              );
            })}
          </ol>
          {set.images.some(wearsLook) ? (
            <div className="social-actions">
              {bySize(set.images).map((group) => (
                <MakeVideo key={group.ratio} postKey={`sample-${set.key}-${group.ratio.replace(":", "x")}`} images={group.images} label={`Make a ${group.ratio} video`} />
              ))}
            </div>
          ) : null}
        </section>
      ))}
      {viewer}
    </div>
  );
}
