import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CARD_FONT_FILES } from "./font-names.js";
import type { CardFont } from "./types.js";

export { CARD_FONT_FILES, CARD_SANS, CARD_SERIF } from "./font-names.js";

const loaded = new Map<string, Promise<CardFont[]>>();

/**
 * The fonts read from `dir` (the files in CARD_FONT_FILES, by name), once
 * per server: for an app with its own cuts of the families. The package's
 * own are embedded (`cardFonts()`, @adminigloo/social/fonts), so most apps
 * never need this.
 */
export function loadCardFonts(dir: string): Promise<CardFont[]> {
  let fonts = loaded.get(dir);
  if (!fonts) {
    fonts = Promise.all(
      CARD_FONT_FILES.map(async ({ file, name, weight, style }) => {
        const bytes = await readFile(join(dir, file));
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return { name, data, weight, style };
      }),
    );
    fonts.catch(() => loaded.delete(dir));
    loaded.set(dir, fonts);
  }
  return fonts;
}
