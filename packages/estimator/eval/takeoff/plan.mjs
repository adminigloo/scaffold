/**
 * What an eval run will send, decided BEFORE anything is sent (review R13):
 * which photos are on disk, how many of them are real photos rather than the
 * bundled diagrams, and whether the run may go at all.
 *
 * WHY IT REFUSES WITHOUT `sharp`. Production never sends a phone's photo as
 * it is: the widget shrinks it to 768 px on the long edge (JPEG 0.8) first,
 * about 600 image tokens. A 12 MP photo sent whole is a different picture at a
 * different resolution and 2–3 times the tokens, so an eval that fell back to
 * it reported an accuracy and a cost per photo production never sees. `sharp`
 * is a dev dependency of this package; `--full-size` sends the originals
 * anyway, on purpose.
 *
 * Pure: the caller says what is on disk and whether `sharp` loaded.
 */

/** A fixture whose file is one of the bundled synthetic diagrams. */
export function isSynthetic(fixture) {
  return /(^|\/)synthetic-/.test(fixture.file);
}

/**
 * @param {{ fixtures: Array<{ file: string }>, onDisk: (file: string) => boolean, sharpAvailable: boolean, allowFullSize?: boolean }} input
 */
export function planRun({ fixtures, onDisk, sharpAvailable, allowFullSize = false }) {
  const present = fixtures.filter((fixture) => onDisk(fixture.file));
  const missing = fixtures.filter((fixture) => !onDisk(fixture.file));
  const realListed = fixtures.filter((fixture) => !isSynthetic(fixture));
  const real = present.filter((fixture) => !isSynthetic(fixture));
  const realMissing = missing.filter((fixture) => !isSynthetic(fixture));
  const lines = [];
  if (real.length === 0) {
    lines.push(
      `0 real photos found: this run would score only the ${present.length} synthetic diagram${present.length === 1 ? "" : "s"}, not a customer's photo.` +
        (realMissing.length > 0 ? ` Add your porch photos at ${realMissing.map((fixture) => fixture.file).join(", ")} (eval/takeoff/).` : ""),
    );
  } else {
    lines.push(`${real.length} of ${realListed.length} real photo${realListed.length === 1 ? "" : "s"} found, and ${present.length - real.length} synthetic diagram${present.length - real.length === 1 ? "" : "s"}.`);
  }
  let refusal = null;
  if (!sharpAvailable && !allowFullSize) {
    refusal =
      "sharp isn't installed, so the photos can't be shrunk the way the widget shrinks them (768 px, JPEG 0.8), and the accuracy and the cost per photo would both be wrong. Run pnpm install in packages/estimator (sharp is a dev dependency), or pass --full-size to send the originals anyway.";
  }
  return { present, missing, real, lines, refusal };
}
