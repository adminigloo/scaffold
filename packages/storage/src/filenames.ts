import { FILE_TYPES, type FileTypeKey } from "./file-types.js";

/**
 * File names a browser typed, made safe to store and echo (0.1's rules, by
 * character code), and 0.2's extension rule (review G18).
 */

/** Characters that mean something to a path, a shell or a header. 92 is the backslash itself. */
const SPECIALS = new Set(['"', "*", "/", ":", "<", ">", "?", "|", String.fromCharCode(92)]);

/**
 * 0.1's sanitizer, unchanged: separators, control characters and whitespace
 * become underscores, the extension's dot survives, and an all-junk name
 * degrades to "file" rather than to an empty string.
 */
export function sanitizeFilename(raw: string): string {
  // Character codes rather than a regex character class: the class would be
  // mostly escape sequences, and an escape dropped here fails silently as
  // "some filenames aren't cleaned".
  const chars = [...raw.trim().slice(0, 200)].map((ch) => {
    const code = ch.charCodeAt(0);
    if (code < 33) return "_"; // control characters and the space
    return SPECIALS.has(ch) ? "_" : ch;
  });
  let name = chars.join("");
  while (name.startsWith(".")) name = "_" + name.slice(1);
  return name.length > 0 ? name : "file";
}

/**
 * 0.2's name for the Files screen: 0.1's rules, except that a run of spaces
 * stays ONE space. "Q3 report.pdf" is what the owner saved and what they look
 * for; "Q3_report.pdf" is a name only a computer chose. A space is harmless
 * everywhere the name goes (the download header carries it percent-encoded).
 */
export function cleanFilename(raw: string): string {
  const chars: string[] = [];
  for (const ch of [...raw.trim().slice(0, 200)]) {
    const code = ch.charCodeAt(0);
    if (code === 32 || code === 9) chars.push(" ");
    else if (code < 32 || code === 127) continue;
    else chars.push(SPECIALS.has(ch) ? "_" : ch);
  }
  let name = chars.join("").replace(/ {2,}/g, " ").trim();
  while (name.startsWith(".")) name = "_" + name.slice(1);
  return name.length > 0 ? name : "file";
}

function sameExtension(current: string, wanted: string): boolean {
  if (current === wanted) return true;
  const jpeg = new Set(["jpg", "jpeg"]);
  const heic = new Set(["heic", "heif"]);
  return (jpeg.has(current) && jpeg.has(wanted)) || (heic.has(current) && heic.has(wanted));
}

/**
 * The stored and served name, with the SNIFFED type's extension (review
 * G18): `report.html` holding a PDF is kept as `report.pdf`, `photo` as
 * `photo.jpg`. A file saved from the Files screen then opens as what it is,
 * never as what its name claimed. An existing short extension (1–4 letters or
 * digits) is replaced; anything longer is part of the name and kept
 * ("Q3.report" → "Q3.report.pdf").
 */
export function withTypeExtension(name: string, type: FileTypeKey): string {
  const ext = FILE_TYPES[type].ext;
  let base = name;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const current = base.slice(dot + 1).toLowerCase();
    if (sameExtension(current, ext)) return base.length <= 200 ? base : `${base.slice(0, 200 - current.length - 1)}.${current}`;
    if (/^[a-z0-9]{1,4}$/.test(current)) base = base.slice(0, dot);
  }
  const room = 200 - ext.length - 1;
  return `${base.slice(0, room)}.${ext}`;
}

/** A download header's value: `inline` or `attachment`, an ASCII fallback, and the real name percent-encoded (RFC 6266 / 5987). */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = [...filename].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126 || ch === '"' || ch === "\\" ? "_" : ch)).join("");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
