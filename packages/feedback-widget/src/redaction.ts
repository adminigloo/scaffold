/**
 * What never reaches a screenshot or the click trail.
 *
 * REDACTION HAPPENS ON THE CLONE, NEVER ON THE LIVE PAGE. The first version
 * swapped live `input.value`s for bullets and put them back afterwards, and a
 * review with a real browser broke it three ways: a React re-render during a
 * multi-layer capture writes the controlled value straight back (the secret
 * leaked into every later layer, 3 runs of 3); a field matching two rules —
 * `type=password name=password` — had its stash overwritten with the bullets,
 * so the "restore" destroyed the user's real value; and a file input throws on
 * assignment, leaving the page half-redacted. The capture library hands us each
 * cloned node before it is rasterised (`onCloneEachNode`), so the redaction is
 * applied there and the page the user is typing into is never touched.
 */

const BULLETS = "••••••••";

/** Substrings of a field's `name` that mark it secret (case-insensitive). */
const SECRET_NAME_PARTS = [
  "password",
  "passwd",
  "passcode",
  "ssn",
  "social",
  "credit",
  "card",
  "cvv",
  "cvc",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "private_key",
  "privatekey",
];

/** `autocomplete` tokens that name a secret whatever the field is called. */
const SECRET_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
];

/**
 * Fields whose VALUE is secret. Case-insensitive (`apiKey`, `accessToken`,
 * `clientSecret` are how React apps name things), on textareas too, and by
 * `autocomplete` for a secret field with no telling name (a show-password
 * toggle turns `type=password` into `type=text`).
 */
export const SENSITIVE_FIELDS = [
  'input[type="password" i]',
  ...SECRET_NAME_PARTS.flatMap((part) => [`input[name*="${part}" i]`, `textarea[name*="${part}" i]`]),
  ...SECRET_AUTOCOMPLETE.map((token) => `[autocomplete~="${token}" i]`),
].join(", ");

/** Content a host marks secret — any element, not just a field. */
export const SENSITIVE_CONTENT = '[data-sensitive="true"]';

/** Input types that carry no typed text to leak (and some throw on `value`). */
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "file",
  "hidden",
  "submit",
  "button",
  "image",
  "reset",
  "color",
  "range",
]);

/** Is this live element one whose content or value must never be recorded? */
export function isSensitive(element: Element): boolean {
  try {
    return element.closest(SENSITIVE_CONTENT) !== null || element.matches(SENSITIVE_FIELDS);
  } catch {
    return false;
  }
}

/** Black out a cloned element and everything in it — box kept, content gone. */
function blackOut(root: Element): void {
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const style = (node as HTMLElement | SVGElement).style;
    if (!style) continue;
    style.setProperty("color", "transparent", "important");
    style.setProperty("-webkit-text-fill-color", "transparent", "important");
    style.setProperty("text-shadow", "none", "important");
    style.setProperty("background-color", "#111", "important");
    style.setProperty("background-image", "none", "important");
    style.setProperty("border-color", "#111", "important");
    if (/^(IMG|SVG|CANVAS|VIDEO|PICTURE)$/i.test(node.tagName)) {
      style.setProperty("opacity", "0", "important");
    }
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
      node.setAttribute("value", "");
      if (node.tagName === "TEXTAREA") node.textContent = "";
    }
  }
}

/**
 * `onCloneEachNode` for every capture. Runs after the clone's children are in
 * place and after the library copied the live value onto it, so overriding
 * here is final.
 */
export function redactClone(node: Node): void {
  if (!(node instanceof Element)) return;
  if (node.getAttribute("data-sensitive") === "true") {
    blackOut(node);
    return;
  }
  let field: boolean;
  try {
    field = node.matches(SENSITIVE_FIELDS);
  } catch {
    return;
  }
  if (!field) return;
  if (node.tagName === "TEXTAREA") {
    if ((node.textContent ?? "") !== "") node.textContent = BULLETS;
    if (node.getAttribute("value")) node.setAttribute("value", BULLETS);
    return;
  }
  if (node.tagName === "INPUT") {
    const type = (node.getAttribute("type") ?? "text").toLowerCase();
    if (NON_TEXT_INPUTS.has(type)) return;
    if (node.getAttribute("value")) node.setAttribute("value", BULLETS);
  }
}
