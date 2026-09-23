/**
 * Plain-text template → email HTML — pure.
 *
 * Templates are plain text on purpose (a business owner edits them in a
 * textarea, and a {{name}} a customer typed must never become markup). This is
 * the one sanctioned way to turn a rendered body into HTML: it escapes FIRST,
 * then adds structure, so a value like `<script>` or `"><img onerror=…>` that
 * came in through a variable arrives as visible text, not as HTML. The source
 * built its HTML by interpolating the rendered body straight into markup —
 * the order here is the fix.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Runs on ALREADY-ESCAPED text, so a URL ends at whitespace or at the entity an
// escaped quote/bracket became — never inside one. Only http(s): a
// `javascript:` "link" in a template stays inert text.
const URL_IN_ESCAPED_TEXT = /https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s])+/g;

function linkify(escaped: string): string {
  return escaped.replace(URL_IN_ESCAPED_TEXT, (match) => {
    // Sentence punctuation after a URL ("see https://x.com.") is not part of it.
    const url = match.replace(/[.,!?:)]+$/, "");
    const trailing = match.slice(url.length);
    return `<a href="${url}">${url}</a>${trailing}`;
  });
}

/**
 * Blank-line-separated paragraphs become `<p>`, single newlines `<br>`, and
 * http(s) URLs links — after escaping. Pass the result as the provider's
 * `html` and the original text as `text`.
 */
export function plainTextToEmailHtml(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${linkify(escapeHtml(paragraph)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
