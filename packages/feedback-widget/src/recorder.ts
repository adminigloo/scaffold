import type { CapturedError, SessionEvent } from "./types.js";

/** Fixed-size circular buffer; the newest N entries win. */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray(): T[] {
    if (this.size === 0) return [];
    const start = this.size < this.capacity ? 0 : this.head;
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const item = this.buffer[(start + i) % this.capacity];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  clear(): void {
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Trim, collapse whitespace, cap length. */
function tidy(text: string | null | undefined, max = 60): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The visible label for a form control, from any of the usual places. */
function labelFor(element: Element): string {
  const aria = tidy(element.getAttribute("aria-label"));
  if (aria) return aria;
  const title = tidy(element.getAttribute("title"));
  if (title) return title;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const refText = tidy(document.getElementById(labelledBy)?.textContent);
    if (refText) return refText;
  }
  if (element.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    const explicitText = tidy(explicit?.textContent);
    if (explicitText) return explicitText;
  }
  const wrapping = element.closest("label");
  if (wrapping) {
    const wrapText = tidy(wrapping.textContent);
    if (wrapText) return wrapText;
  }
  const placeholder = tidy(element.getAttribute("placeholder"));
  if (placeholder) return placeholder;
  return tidy(element.getAttribute("name"));
}

/**
 * Describe a clicked element as a phrase a human recognises and a model can
 * act on — `checkbox "Show Limits"`, `link → /reports` — never a pile of CSS
 * utility classes. Ported from Ask Lou, where the class-name version made
 * every click trail unreadable (their TKT-00503).
 */
export function describeElement(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const testId = element.getAttribute("data-testid");
  if (testId) {
    const label = labelFor(element);
    return label ? `${testId} "${label}"` : testId;
  }
  const label = labelFor(element);
  const ownText = tidy(element.textContent, 40);

  if (tagName === "input") {
    const type = element.getAttribute("type") ?? "text";
    const kind = type === "checkbox" || type === "radio" ? type : `${type} field`;
    const checked =
      type === "checkbox" || type === "radio"
        ? (element as HTMLInputElement).checked
          ? " (now checked)"
          : " (now unchecked)"
        : "";
    return label ? `${kind} "${label}"${checked}` : `${kind}${checked}`;
  }
  if (tagName === "select") {
    const chosen = tidy((element as HTMLSelectElement).selectedOptions?.[0]?.textContent, 40);
    const base = label ? `select "${label}"` : "select";
    return chosen ? `${base} → "${chosen}"` : base;
  }
  if (tagName === "textarea") return label ? `textarea "${label}"` : "textarea";
  if (tagName === "a") {
    const href = element.getAttribute("href") ?? "";
    const text = ownText || label;
    if (text && href) return `link "${text}" → ${href}`;
    if (href) return `link → ${href}`;
    return text ? `link "${text}"` : "link";
  }
  if (tagName === "button" || element.getAttribute("role") === "button") {
    const text = ownText || label;
    return text ? `button "${text}"` : "button";
  }
  if (ownText) return `${tagName} "${ownText}"`;
  const actionable = element.closest("button, a, [role='button'], label");
  if (actionable && actionable !== element) {
    return `${tagName} inside ${describeElement(actionable)}`;
  }
  return label ? `${tagName} "${label}"` : tagName;
}

export function parseBrowserInfo(userAgent: string): string {
  if (userAgent.includes("Firefox")) return "Firefox";
  if (userAgent.includes("Edg")) return "Edge";
  if (userAgent.includes("Chrome")) return "Chrome";
  if (userAgent.includes("Safari")) return "Safari";
  return "Unknown";
}

export function parseOSInfo(userAgent: string): string {
  if (userAgent.includes("Windows")) return "Windows";
  if (userAgent.includes("Mac")) return "macOS";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("iPhone") || userAgent.includes("iOS")) return "iOS";
  if (userAgent.includes("Linux")) return "Linux";
  return "Unknown";
}

export type { CapturedError, SessionEvent };
