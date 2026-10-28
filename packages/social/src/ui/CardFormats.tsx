/* eslint-disable @next/next/no-img-element -- the cards are PNGs from the app's own card route, shown at their own size */
import type { CardFormatSet } from "../wire.js";
import { SocialStyles } from "./styles.js";

/**
 * EVERY CARD FORMAT AT ONCE: the quote card at 1:1 and 4:5, and each
 * carousel at 4:5 and 9:16, drawn by the same signed route the posts use.
 * Samples only: made-up words, nothing here is posted. Each opens full size.
 */
export function CardFormats({ sets }: { readonly sets: readonly CardFormatSet[] }) {
  return (
    <div className="social social-formats">
      <SocialStyles />
      <p className="social-section-hint">Every card on this page is a sample: the words and numbers are made up, to show the formats. A real post&rsquo;s cards are drawn from its own words.</p>
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
                  <a href={image.url} target="_blank" rel="noopener noreferrer">
                    <img src={image.url} alt={image.alt} width={shown} height={Math.round((shown * image.height) / image.width)} loading="lazy" />
                  </a>
                  <span>{image.label}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
