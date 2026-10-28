import { CARD_FONT_DATA } from "./font-data.js";
import { CARD_FONT_FILES } from "./font-names.js";
import type { CardFont } from "./types.js";

/**
 * @adminigloo/social/fonts — THE CARDS' FONTS, EMBEDDED (social 0.1). The
 * four font files' bytes travel inside this module (about 320 KB, base64),
 * so the one route that draws cards needs no file on disk, no file tracing
 * and no font server: it works the same under Next, Vite or a plain Node
 * server. Only the card route should import this entry.
 *
 *   import { cardFonts, CARD_SANS, CARD_SERIF } from "@adminigloo/social/fonts";
 *   const assets = { fonts: cardFonts(), serif: CARD_SERIF, sans: CARD_SANS, … };
 */
export { CARD_FONT_FILES, CARD_SANS, CARD_SERIF } from "./font-names.js";

function bytesOf(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let decoded: CardFont[] | null = null;

/** The bundled fonts, decoded once per server. */
export function cardFonts(): CardFont[] {
  if (!decoded) {
    decoded = CARD_FONT_FILES.map(({ file, name, weight, style }) => {
      const data = CARD_FONT_DATA[file];
      if (!data) throw new Error(`@adminigloo/social: the bundled font ${file} is missing from the package.`);
      return { name, data: bytesOf(data), weight, style };
    });
  }
  return decoded;
}
