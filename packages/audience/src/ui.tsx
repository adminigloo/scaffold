import {
  useEffect,
  useId,
  useRef,
  useState,
  version as reactVersion,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  isRetroactiveKind,
  KIND_INFO,
  RULE_KINDS,
  type RuleKind,
  type RunAction,
} from "./core/labels.js";
import { DARK_PALETTE, LIGHT_PALETTE, paletteDeclarations } from "./ui-tokens.js";
import { excludedParts, excludedSentence } from "./core/words.js";
import type { DateLike, ExcludedView, PreviewView, RuleDraft, RuleView, RunView } from "./views.js";

/**
 * @adminigloo/audience/ui — the admin components. Display only: they fetch
 * nothing, store nothing, and take plain data plus callbacks, so a Riddler Go
 * page fills them with server actions, the AdminIgloo site with tRPC, anything
 * with fetch. Every callback may reject; the component shows the error's
 * message and stays usable.
 *
 * Styling is injected, `aiu-`-prefixed and built on `--aiu-*` custom
 * properties declared under `:where()` (zero specificity), so a host's
 * `.aiu-root { --aiu-accent: … }` wins in any order. 44px targets, AA
 * contrast in both themes (measured by a unit test), forced-colours support.
 */

export type { DateLike, ExcludedView, PreviewView, PreviewWindowView, RowCountView, RuleDraft, RuleView, RunView } from "./views.js";

export { excludedParts, excludedSentence };

export type AudienceTheme = "auto" | "light" | "dark";

const STYLE_ID = "aiu-styles";

/** React 19 can render a deduplicated, hoisted <style> during SSR; React 18 injects after mount. */
const HOISTED_STYLES = Number.parseInt(reactVersion, 10) >= 19;

const TOKEN_SCOPE = ":where(.aiu-root)";

const CSS_TEXT = `
${TOKEN_SCOPE} { ${paletteDeclarations(LIGHT_PALETTE)} color-scheme: light; }
@media (prefers-color-scheme: dark) {
  ${TOKEN_SCOPE}:where(:not([data-aiu-theme="light"])) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }
}
${TOKEN_SCOPE}:where([data-aiu-theme="dark"]) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }

:where(.aiu-root) { color: var(--aiu-ink); background: var(--aiu-surface); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; box-sizing: border-box; }
:where(.aiu-root) *, :where(.aiu-root) *::before, :where(.aiu-root) *::after { box-sizing: border-box; }
.aiu-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.aiu-root { position: relative; }

/* Buttons and fields: 44px targets, edges at 3:1, one focus ring. */
.aiu-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; min-width: 44px;
  padding: 8px 16px; border-radius: 8px; border: 1px solid var(--aiu-edge); background: var(--aiu-surface);
  color: var(--aiu-ink); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
.aiu-btn:hover { background: var(--aiu-surface-2); }
.aiu-btn-primary { background: var(--aiu-accent); border-color: var(--aiu-accent); color: var(--aiu-on-accent); }
.aiu-btn-primary:hover { background: var(--aiu-accent-strong); border-color: var(--aiu-accent-strong); }
.aiu-btn-danger { color: var(--aiu-danger); }
.aiu-btn-danger-solid { background: var(--aiu-danger); border-color: var(--aiu-danger); color: var(--aiu-surface); }
.aiu-btn:disabled { background: var(--aiu-surface-2); border-color: var(--aiu-edge); color: var(--aiu-ink-muted); cursor: not-allowed; }
.aiu-btn[aria-busy="true"] { cursor: progress; }
.aiu-btn:focus-visible, .aiu-field :is(input, select, textarea):focus-visible, .aiu-switch:focus-visible,
.aiu-defaults > summary:focus-visible, .aiu-focus:focus-visible, .aiu-scroll:focus-visible {
  outline: 2px solid var(--aiu-accent); outline-offset: 2px; }
.aiu-focus:focus { outline: none; }
.aiu-field { display: grid; gap: 4px; min-width: 0; }
.aiu-field > label { font-weight: 600; font-size: 13px; }
.aiu-field :is(input, select, textarea) { min-height: 44px; width: 100%; padding: 8px 10px; border: 1px solid var(--aiu-edge);
  border-radius: 8px; background: var(--aiu-surface); color: var(--aiu-ink); font: inherit; }
.aiu-field :is(input, textarea)::placeholder { color: var(--aiu-ink-muted); opacity: 1; }
.aiu-field[data-invalid="true"] :is(input, select) { border-color: var(--aiu-danger); }
.aiu-hint { font-size: 12.5px; color: var(--aiu-ink-muted); }

/* Include-internal toggle: a link that flips a URL parameter, drawn as a switch. */
.aiu-toggle { display: grid; gap: 8px; border-radius: 8px; }
.aiu-switch { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 8px 4px 4px; border-radius: 8px;
  color: var(--aiu-ink); text-decoration: none; font-weight: 600; width: fit-content; cursor: pointer; }
.aiu-switch:hover .aiu-switch-label { text-decoration: underline; }
.aiu-switch-track { position: relative; flex: none; width: 40px; height: 24px; border-radius: 999px; background: var(--aiu-edge);
  border: 2px solid var(--aiu-edge); }
.aiu-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--aiu-surface);
  transition: left .12s ease; }
.aiu-switch[aria-checked="true"] .aiu-switch-track { background: var(--aiu-accent); border-color: var(--aiu-accent); }
.aiu-switch[aria-checked="true"] .aiu-switch-knob { left: 18px; background: var(--aiu-on-accent); }
.aiu-switch-state { font-weight: 400; color: var(--aiu-ink-muted); }
.aiu-banner { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--aiu-warn-soft); color: var(--aiu-warn-ink);
  border: 1px solid var(--aiu-warn-ink); }

/* Excluded line */
.aiu-note { margin: 0; font-size: 13px; color: var(--aiu-ink-muted); }
.aiu-note b { color: var(--aiu-ink); font-weight: 600; }

/* Rules panel */
.aiu-panel { display: grid; gap: 18px; padding: 20px; border: 1px solid var(--aiu-line); border-radius: 12px; background: var(--aiu-surface);
  min-width: 0; }
@media (max-width: 480px) { .aiu-panel { padding: 16px 12px; } }
.aiu-h { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
.aiu-h3 { margin: 0; font-size: 14px; font-weight: 700; }
.aiu-sub { margin: 4px 0 0; color: var(--aiu-ink-muted); }
.aiu-section { display: grid; gap: 10px; min-width: 0; }
.aiu-tag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  color: var(--aiu-accent); background: var(--aiu-accent-soft); border-radius: 999px; padding: 2px 8px; }
.aiu-code-rule { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aiu-defaults { border: 1px solid var(--aiu-line); border-radius: 8px; }
.aiu-defaults > summary { min-height: 44px; display: list-item; padding: 10px 12px; line-height: 24px; cursor: pointer; font-weight: 600;
  border-radius: 8px; }
.aiu-defaults > ul { margin: 0; padding: 0 12px 12px 32px; color: var(--aiu-ink-muted); display: grid; gap: 4px; }
.aiu-viewonly { margin: 0; color: var(--aiu-ink-muted); }
.aiu-rules { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aiu-rule { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; padding: 10px 12px;
  border: 1px solid var(--aiu-line); border-radius: 10px; background: var(--aiu-surface-2); }
.aiu-rule-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.aiu-kind { font-size: 12px; font-weight: 700; color: var(--aiu-accent); }
.aiu-value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.aiu-label { font-weight: 600; }
.aiu-meta { grid-column: 1 / -1; font-size: 12.5px; color: var(--aiu-ink-muted); }
.aiu-confirm { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px;
  border-radius: 8px; background: var(--aiu-danger-soft); color: var(--aiu-ink); }
.aiu-confirm p { margin: 0; flex: 1 1 220px; }
.aiu-empty { margin: 0; color: var(--aiu-ink-muted); }
.aiu-form { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--aiu-line); border-radius: 10px; }
.aiu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.aiu-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.aiu-preview { display: grid; gap: 10px; padding: 12px; border-radius: 10px; background: var(--aiu-accent-soft); color: var(--aiu-ink); }
.aiu-preview p { margin: 0; }
.aiu-limits { margin: 0; padding-left: 20px; color: var(--aiu-ink-muted); font-size: 13px; display: grid; gap: 2px; }
.aiu-warn { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--aiu-warn-soft); color: var(--aiu-warn-ink); }
.aiu-scroll { overflow-x: auto; max-width: 100%; border-radius: 8px; }
.aiu-table { border-collapse: collapse; width: 100%; font-size: 13px; background: var(--aiu-surface); color: var(--aiu-ink); }
.aiu-table th, .aiu-table td { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--aiu-line); white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.aiu-table th:first-child, .aiu-table td:first-child { text-align: left; }
.aiu-table thead th { color: var(--aiu-ink-muted); font-weight: 600; }
.aiu-error { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--aiu-danger-soft); color: var(--aiu-danger);
  border: 1px solid var(--aiu-danger); }
.aiu-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.aiu-run { display: grid; gap: 2px; padding: 8px 0; border-bottom: 1px solid var(--aiu-line); }
.aiu-run:last-child { border-bottom: 0; }
.aiu-run-action { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--aiu-accent); }
.aiu-run-meta { font-size: 12.5px; color: var(--aiu-ink-muted); }

/* Mark this browser */
.aiu-mark { display: grid; gap: 6px; justify-items: start; }
.aiu-done { margin: 0; font-weight: 600; }
.aiu-status { margin: 0; min-height: 0; }

/* Unfiltered sources */
.aiu-unfiltered { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--aiu-line); border-radius: 10px; background: var(--aiu-surface); }
.aiu-unfiltered p { margin: 0; color: var(--aiu-ink-muted); }
.aiu-unfiltered ul { margin: 0; padding-left: 20px; display: grid; gap: 4px; }

/* Windows High Contrast / forced colours: drawn parts use system colours. */
@media (forced-colors: active) {
  .aiu-switch-track, .aiu-switch-knob { forced-color-adjust: none; }
  .aiu-switch-track { background: Canvas; border-color: CanvasText; }
  .aiu-switch-knob { background: CanvasText; }
  .aiu-switch[aria-checked="true"] .aiu-switch-track { background: Highlight; border-color: Highlight; }
  .aiu-switch[aria-checked="true"] .aiu-switch-knob { background: HighlightText; }
  .aiu-btn, .aiu-field :is(input, select, textarea) { border: 1px solid ButtonText; }
  .aiu-btn:disabled { border-color: GrayText; color: GrayText; }
  .aiu-banner, .aiu-error, .aiu-preview, .aiu-confirm, .aiu-warn { border: 1px solid CanvasText; }
  .aiu-btn:focus-visible, .aiu-switch:focus-visible, .aiu-focus:focus-visible { outline-color: Highlight; }
}
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

/** The stylesheet — server-rendered and deduplicated on React 19, injected on mount on 18. */
function AudienceStyles(): ReactElement | null {
  useEffect(() => {
    if (!HOISTED_STYLES) injectStyles();
  }, []);
  if (!HOISTED_STYLES) return null;
  return (
    <style href={STYLE_ID} precedence="medium">
      {CSS_TEXT}
    </style>
  );
}

/** The CSS as a string, for a host that prefers to ship it in its own stylesheet. */
export const audienceCss: string = CSS_TEXT;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong. Try again.";
}

/**
 * What a callback resolves with to report a failure the admin should read.
 * In a production Next build a THROWN server-action error reaches the client
 * as a generic "An error occurred in the Server Components render…", so the
 * reason ("…is not an email address", "An active rule already says that")
 * is lost. Catch `isAudienceError(e)` in the action and return `{ error: e.message }`.
 */
export interface ActionError {
  error: string;
}

/** The `{ error }` a callback resolved with, or null. */
function resolvedError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const error = (result as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  return null;
}

/**
 * A toggle href is followed with `window.location.assign`, so only a
 * same-site path, a query, a fragment or an http(s) URL is accepted: a
 * `javascript:` URL in a prop must never run.
 */
export function safeHref(href: string): string | null {
  if (typeof href !== "string") return null;
  // A URL parser drops tabs and newlines inside a scheme ("java\nscript:"),
  // so any control character is refused outright.
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  const value = href.trim();
  if (!value) return null;
  if (/^(?:\/(?!\/)|\?|#)/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^https?:\/\//i.test(value) ? value : null;
  // "//evil.example" is a protocol-relative URL to another site; a bare word is a relative path.
  return value.startsWith("//") ? null : value;
}

function toDate(value: DateLike | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Default date words: YYYY-MM-DD in UTC — the same on the server and in every browser, so hydration never disagrees. */
function defaultFormatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const EMAIL_RE = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;

/** Display-side masking (no tag): the server should already have masked; this is the fallback. */
export function maskForDisplay(text: string): string {
  return text.replace(EMAIL_RE, (email) => {
    const at = email.lastIndexOf("@");
    return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
  });
}

const number = (value: number) => value.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// IncludeInternalToggle
// ---------------------------------------------------------------------------

export interface IncludeInternalToggleProps {
  /** Is internal traffic currently included (read from the URL, never remembered)? */
  value: boolean;
  /** The URL that flips it — `includeInternalHref(currentUrl, !value)`. */
  href: string;
  /** Client-side navigation instead of a full load (router.push). Called with `href`. */
  onNavigate?: (href: string) => void;
  label?: string;
  theme?: AudienceTheme;
}

/**
 * The per-report "Include internal" switch. A real link (works without
 * JavaScript, shareable, the back button undoes it) presented as a switch;
 * Space works as well as Enter. While on, a banner says so — the view is
 * per request and never persisted (Road Rally a7a79cc3).
 */
export function IncludeInternalToggle(props: IncludeInternalToggleProps): ReactElement {
  const { value, onNavigate, label = "Include internal traffic", theme } = props;
  const href = safeHref(props.href) ?? "#";
  const go = () => {
    if (href === "#") return;
    if (onNavigate) onNavigate(href);
    else if (typeof window !== "undefined") window.location.assign(href);
  };
  return (
    <div className="aiu-root aiu-toggle" data-aiu-theme={theme}>
      <AudienceStyles />
      <a
        className="aiu-switch"
        role="switch"
        aria-checked={value}
        href={href}
        onClick={(event) => {
          if (href === "#") {
            event.preventDefault();
            return;
          }
          if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onNavigate(href);
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            go();
          }
        }}
      >
        <span className="aiu-switch-track" aria-hidden="true">
          <span className="aiu-switch-knob" />
        </span>
        <span className="aiu-switch-label">{label}</span>
        <span className="aiu-switch-state" aria-hidden="true">
          {value ? "On" : "Off"}
        </span>
      </a>
      {value ? (
        <p className="aiu-banner">
          <b>Internal traffic is included.</b> These numbers count staff, test accounts and automation.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExcludedNote
// ---------------------------------------------------------------------------

export interface ExcludedNoteProps {
  excluded: ExcludedView;
  /** Word for what was counted. Default `excluded.unit` or "sessions". */
  unit?: string;
  /** Override the words per reason ("role" → "staff"). Reasons sharing a word are summed. */
  labels?: Partial<Record<string, string>>;
  /** Internal traffic is IN these numbers (the toggle is on): say so instead. */
  includeInternal?: boolean;
  theme?: AudienceTheme;
}

export function ExcludedNote(props: ExcludedNoteProps): ReactElement {
  const { excluded, unit, labels, includeInternal, theme } = props;
  const text = excludedSentence(excluded, {
    ...(unit !== undefined ? { unit } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(includeInternal !== undefined ? { includeInternal } : {}),
  });
  const colon = text.indexOf(":");
  return (
    <p className="aiu-root aiu-note" data-aiu-theme={theme}>
      <AudienceStyles />
      {colon > 0 && !includeInternal ? (
        <>
          <b>{text.slice(0, colon + 1)}</b>
          {text.slice(colon + 1)}
        </>
      ) : (
        text
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// AudienceRulesPanel
// ---------------------------------------------------------------------------

/** The order kinds are offered in: people first, then things, then visit-only. */
const KIND_ORDER: readonly RuleKind[] = [
  "email",
  "email_domain",
  "email_pattern",
  "user",
  "org",
  "event",
  "order",
  "visitor",
  "network",
  "host",
  "user_agent",
];

const RUN_WORDS: Readonly<Record<RunAction, string>> = {
  apply: "Applied",
  remove: "Removed",
  backfill: "Backfill",
  manual: "By hand",
};

export interface AudienceRulesPanelProps {
  rules: readonly RuleView[];
  runs?: readonly RunView[];
  /** Super and staff: true. The analytics role: false — the list shows, the form and Remove do not. */
  canEdit: boolean;
  /**
   * Show addresses masked (j***@gmail.com). Default: masked when `canEdit` is
   * false (the analytics role). Mask on the server too (`viewModel`): this
   * only changes what is drawn.
   */
  maskEmails?: boolean;
  /** Dry run for the add form. Must not write. May resolve with `{ error }` instead (see `ActionError`). */
  onPreview?: (draft: RuleDraft) => Promise<PreviewView | ActionError>;
  /**
   * Save (and apply) the previewed rule. May resolve with `{ annotation }` or
   * `{ applied: { annotation } }` to show, or `{ error }` to report a failure.
   */
  onAdd?: (draft: RuleDraft) => Promise<unknown>;
  /** May resolve with `{ annotation }` to show, or `{ error }` to report a failure. */
  onRemove?: (ruleId: string) => Promise<unknown>;
  /** The app's rule in code (`isInternal`), shown read-only. */
  codeRule?: string | null;
  /** Kinds the form offers. Default: all. */
  kinds?: readonly RuleKind[];
  /** The defaults this install keeps (shown under "Always excluded"). Pass [] to hide. */
  defaultsSummary?: readonly string[];
  title?: string;
  /** h2 by default; the section headings are one level below. */
  headingLevel?: 2 | 3 | 4;
  formatDate?: (date: Date) => string;
  theme?: AudienceTheme;
}

export const DEFAULTS_SUMMARY: readonly string[] = [
  "Test sign-ups: addresses containing +clerk_test@ or +test@.",
  "Reserved domains: example.com, example.org, example.net, and *.test, *.invalid, *.localhost.",
  "Automation: headless and scripted browsers (HeadlessChrome, Playwright, Puppeteer, Selenium), Lighthouse and PageSpeed, uptime monitors (UptimeRobot, Checkly, Pingdom…), and the smoke-test header.",
  "Non-production: localhost, loopback addresses, *.vercel.app previews, and any deployment the app marks as not production.",
  "Crawlers are counted apart, as bots — never as internal.",
];

function Heading(props: { level: number; className: string; id?: string; tabIndex?: number; children: ReactNode; headingRef?: Ref<HTMLHeadingElement> }): ReactElement {
  const Tag = `h${Math.min(6, Math.max(2, props.level))}` as "h2";
  return (
    <Tag className={props.className} id={props.id} tabIndex={props.tabIndex} ref={props.headingRef}>
      {props.children}
    </Tag>
  );
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; result: PreviewView }
  | { status: "error"; message: string };

function draftKey(draft: RuleDraft): string {
  return JSON.stringify([draft.kind, draft.value.trim(), draft.reasonLabel ?? "", draft.note ?? "", draft.appliesFrom ?? ""]);
}

function displayValue(rule: RuleView, mask: boolean): string {
  if (!mask) return rule.value;
  return maskForDisplay(rule.value);
}

function subjectWords(subjects: PreviewView["subjects"]): string {
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${number(count)} ${count === 1 ? one : many}`);
  };
  add(subjects.users, "person", "people");
  add(subjects.visitors, "device", "devices");
  add(subjects.orgs, "organization", "organizations");
  add(subjects.events, "event", "events");
  add(subjects.orders, "order", "orders");
  return parts.join(", ");
}

function annotationOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const direct = (result as { annotation?: unknown }).annotation;
  if (typeof direct === "string") return direct;
  const applied = (result as { applied?: { annotation?: unknown } | null }).applied;
  return applied && typeof applied.annotation === "string" ? applied.annotation : null;
}

/**
 * The internal-audience admin: the rules in force, a form that previews a
 * rule's reach (30 days, 90 days, all time) BEFORE it can be saved, and the
 * history of every apply and remove. Controlled — the parent re-renders it
 * with fresh `rules` and `runs` after a callback lands.
 */
export function AudienceRulesPanel(props: AudienceRulesPanelProps): ReactElement {
  const {
    rules,
    runs = [],
    canEdit,
    maskEmails = !canEdit,
    onPreview,
    onAdd,
    onRemove,
    codeRule,
    kinds = KIND_ORDER,
    defaultsSummary = DEFAULTS_SUMMARY,
    title = "Internal audience",
    headingLevel = 2,
    formatDate = defaultFormatDate,
    theme,
  } = props;
  const uid = useId();
  const ids = {
    title: `${uid}-title`,
    rules: `${uid}-rules`,
    add: `${uid}-add`,
    kind: `${uid}-kind`,
    value: `${uid}-value`,
    valueHint: `${uid}-value-hint`,
    label: `${uid}-label`,
    note: `${uid}-note`,
    from: `${uid}-from`,
    fromHint: `${uid}-from-hint`,
    addHint: `${uid}-add-hint`,
    preview: `${uid}-preview`,
    history: `${uid}-history`,
  };
  const offered = kinds.filter((kind) => (RULE_KINDS as readonly string[]).includes(kind));
  const editable = canEdit && !!onAdd && !!onPreview;

  const [kind, setKind] = useState<RuleKind>(offered[0] ?? "email");
  const [value, setValue] = useState("");
  const [reasonLabel, setReasonLabel] = useState("");
  const [note, setNote] = useState("");
  const [appliesFrom, setAppliesFrom] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [lastAnnotation, setLastAnnotation] = useState<string | null>(null);

  const valueRef = useRef<HTMLInputElement>(null);
  const rulesHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const mounted = useRef(true);
  const previewSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const retroactive = isRetroactiveKind(kind);
  const draft: RuleDraft = {
    kind,
    value: value.trim(),
    reasonLabel: reasonLabel.trim() || null,
    note: note.trim() || null,
    appliesFrom: retroactive && appliesFrom ? appliesFrom : null,
  };
  const key = draftKey(draft);
  const previewFresh = preview.status === "ready" && preview.key === key;
  const canAdd = previewFresh && !adding && !(preview.status === "ready" && preview.result.duplicateOf);

  async function runPreview(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!onPreview || adding || preview.status === "loading") return;
    setFormError(null);
    if (!draft.value) {
      setFormError("Enter a value to match.");
      valueRef.current?.focus();
      return;
    }
    const seq = ++previewSeq.current;
    setPreview({ status: "loading", key });
    try {
      const resolved = await onPreview(draft);
      if (!mounted.current || seq !== previewSeq.current) return;
      const failure = resolvedError(resolved);
      if (failure) {
        setPreview({ status: "error", message: failure });
        return;
      }
      const result = resolved as PreviewView;
      setPreview({ status: "ready", key, result });
      const reach = result.windows.find((w) => w.key === "all") ?? result.windows[result.windows.length - 1];
      setAnnouncement(
        result.retroactive
          ? `Preview ready: ${reach ? `${number(reach.excluded.sessions)} sessions would be excluded` : subjectWords(result.subjects) || "nothing in history matches"}.`
          : "Preview ready: this rule applies to new visits only.",
      );
    } catch (error) {
      if (!mounted.current || seq !== previewSeq.current) return;
      setPreview({ status: "error", message: errorMessage(error) });
    }
  }

  async function addRule(): Promise<void> {
    if (!onAdd || !canAdd) return;
    setAdding(true);
    setFormError(null);
    try {
      const result = await onAdd(draft);
      if (!mounted.current) return;
      const failure = resolvedError(result);
      if (failure) {
        setFormError(failure);
        return;
      }
      const annotation = annotationOf(result);
      setValue("");
      setReasonLabel("");
      setNote("");
      setAppliesFrom("");
      setPreview({ status: "idle" });
      setLastAnnotation(annotation);
      setAnnouncement(annotation ? `Rule added. ${maskEmails ? maskForDisplay(annotation) : annotation}` : "Rule added.");
      valueRef.current?.focus();
    } catch (error) {
      if (mounted.current) setFormError(errorMessage(error));
    } finally {
      if (mounted.current) setAdding(false);
    }
  }

  async function confirmRemove(ruleId: string): Promise<void> {
    if (!onRemove) return;
    setRemoving(ruleId);
    setRowError(null);
    try {
      const result = await onRemove(ruleId);
      if (!mounted.current) return;
      const failure = resolvedError(result);
      if (failure) {
        setRowError({ id: ruleId, message: failure });
        return;
      }
      setConfirming(null);
      const annotation = annotationOf(result);
      setAnnouncement(annotation ? `Rule removed. ${maskEmails ? maskForDisplay(annotation) : annotation}` : "Rule removed.");
      rulesHeadingRef.current?.focus();
    } catch (error) {
      if (mounted.current) setRowError({ id: ruleId, message: errorMessage(error) });
    } finally {
      if (mounted.current) setRemoving(null);
    }
  }

  function cancelConfirm(ruleId: string): void {
    setConfirming(null);
    setRowError(null);
    requestAnimationFrame(() => removeButtons.current.get(ruleId)?.focus());
  }

  const info = KIND_INFO[kind];
  const sub = Math.min(6, headingLevel + 1);
  const fmt = (value: DateLike | null | undefined) => {
    const date = toDate(value);
    return date ? formatDate(date) : "";
  };
  const who = (value: string | null | undefined) => (value ? (maskEmails ? maskForDisplay(value) : value) : null);

  return (
    <section className="aiu-root aiu-panel" aria-labelledby={ids.title} data-aiu-theme={theme}>
      <AudienceStyles />
      <div>
        <Heading level={headingLevel} className="aiu-h" id={ids.title}>
          {title}
        </Heading>
        <p className="aiu-sub">
          People, devices and traffic left out of these numbers. A new rule cleans history at once; removing it restores the
          numbers exactly.
        </p>
      </div>

      {codeRule ? (
        <p className="aiu-code-rule">
          <span className="aiu-tag">In code</span>
          <span>{codeRule}</span>
        </p>
      ) : null}

      {defaultsSummary.length ? (
        <details className="aiu-defaults">
          <summary>Always excluded</summary>
          <ul>
            {defaultsSummary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {!canEdit ? <p className="aiu-viewonly">View only. Staff can add and remove rules.</p> : null}

      <div className="aiu-section">
        <Heading level={sub} className="aiu-h3 aiu-focus" id={ids.rules} tabIndex={-1} headingRef={rulesHeadingRef}>
          Rules ({rules.length})
        </Heading>
        {rules.length === 0 ? (
          <p className="aiu-empty">No rules yet. The defaults and the rule in code still apply.</p>
        ) : (
          <ul className="aiu-rules" aria-labelledby={ids.rules}>
            {rules.map((rule) => {
              const kindInfo = KIND_INFO[rule.kind] ?? { label: rule.kind };
              const reach = isRetroactiveKind(rule.kind) ? "cleans history" : "new visits only";
              const added = fmt(rule.createdAt);
              const from = fmt(rule.appliesFrom ?? null);
              const by = who(rule.createdBy);
              const isConfirming = confirming === rule.id;
              return (
                <li key={rule.id} className="aiu-rule">
                  <div className="aiu-rule-main">
                    <span className="aiu-kind">{kindInfo.label}</span>
                    <span className="aiu-value">{displayValue(rule, maskEmails)}</span>
                    {rule.reasonLabel ? <span className="aiu-label">{who(rule.reasonLabel)}</span> : null}
                  </div>
                  {canEdit && onRemove && !isConfirming ? (
                    <button
                      type="button"
                      className="aiu-btn aiu-btn-danger"
                      ref={(node) => {
                        if (node) removeButtons.current.set(rule.id, node);
                        else removeButtons.current.delete(rule.id);
                      }}
                      onClick={() => {
                        setRowError(null);
                        setConfirming(rule.id);
                      }}
                      aria-label={`Remove rule: ${kindInfo.label} ${displayValue(rule, maskEmails)}`}
                    >
                      Remove
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className="aiu-meta">
                    {[added && `Added ${added}`, by && `by ${by}`, from && `from ${from}`, reach].filter(Boolean).join(" · ")}
                    {rule.note ? ` · ${who(rule.note)}` : ""}
                  </span>
                  {isConfirming ? (
                    <div
                      className="aiu-confirm"
                      role="group"
                      aria-label="Confirm removal"
                      onKeyDown={(event: ReactKeyboardEvent) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          cancelConfirm(rule.id);
                        }
                      }}
                    >
                      <p>Remove this rule? What it excluded is counted again.</p>
                      <button
                        type="button"
                        ref={confirmRef}
                        className="aiu-btn aiu-btn-danger-solid"
                        aria-busy={removing === rule.id}
                        disabled={removing === rule.id}
                        onClick={() => void confirmRemove(rule.id)}
                      >
                        {removing === rule.id ? "Removing…" : "Remove rule"}
                      </button>
                      <button type="button" className="aiu-btn" onClick={() => cancelConfirm(rule.id)}>
                        Keep
                      </button>
                      {rowError?.id === rule.id ? (
                        <p className="aiu-error" role="alert">
                          {rowError.message}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editable ? (
        <form className="aiu-form" aria-labelledby={ids.add} onSubmit={(event) => void runPreview(event)} noValidate>
          <Heading level={sub} className="aiu-h3" id={ids.add}>
            Add a rule
          </Heading>
          <div className="aiu-grid">
            <div className="aiu-field">
              <label htmlFor={ids.kind}>What to match</label>
              <select id={ids.kind} value={kind} onChange={(event) => setKind(event.target.value as RuleKind)}>
                {offered.map((option) => (
                  <option key={option} value={option}>
                    {KIND_INFO[option].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="aiu-field" data-invalid={formError && !draft.value ? "true" : undefined}>
              <label htmlFor={ids.value}>{info.label}</label>
              <input
                id={ids.value}
                ref={valueRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={info.placeholder}
                aria-describedby={ids.valueHint}
                aria-invalid={formError && !draft.value ? true : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="aiu-hint" id={ids.valueHint}>
                {info.hint}
              </span>
            </div>
            <div className="aiu-field">
              <label htmlFor={ids.label}>Label (optional)</label>
              <input
                id={ids.label}
                value={reasonLabel}
                onChange={(event) => setReasonLabel(event.target.value)}
                placeholder="Rachel's consultant"
                autoComplete="off"
              />
            </div>
            {retroactive ? (
              <div className="aiu-field">
                <label htmlFor={ids.from}>Only from (optional)</label>
                <input
                  id={ids.from}
                  type="date"
                  value={appliesFrom}
                  onChange={(event) => setAppliesFrom(event.target.value)}
                  aria-describedby={ids.fromHint}
                />
                <span className="aiu-hint" id={ids.fromHint}>
                  Leave empty to clean all of history.
                </span>
              </div>
            ) : null}
            <div className="aiu-field">
              <label htmlFor={ids.note}>Note (optional)</label>
              <input id={ids.note} value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" />
            </div>
          </div>

          <div className="aiu-actions">
            <button
              type="submit"
              className={previewFresh ? "aiu-btn" : "aiu-btn aiu-btn-primary"}
              aria-busy={preview.status === "loading"}
              disabled={preview.status === "loading" || adding}
              aria-controls={ids.preview}
            >
              {preview.status === "loading" ? "Previewing…" : "Preview"}
            </button>
            <button
              type="button"
              className="aiu-btn aiu-btn-primary"
              disabled={!canAdd}
              aria-busy={adding}
              aria-describedby={ids.addHint}
              onClick={() => void addRule()}
            >
              {adding ? "Adding…" : "Add rule"}
            </button>
            <span className="aiu-hint" id={ids.addHint}>
              {previewFresh
                ? preview.status === "ready" && preview.result.duplicateOf
                  ? "An active rule already says this."
                  : "Adds the rule and applies it to history."
                : preview.status === "ready"
                  ? "The rule changed — preview it again."
                  : "Preview first: see what the rule would exclude before saving it."}
            </span>
          </div>

          {formError ? (
            <p className="aiu-error" role="alert">
              {formError}
            </p>
          ) : null}

          <div id={ids.preview}>
            {preview.status === "error" ? (
              <p className="aiu-error" role="alert">
                Preview failed: {preview.message}
              </p>
            ) : null}
            {preview.status === "ready" ? (
              <PreviewBox result={preview.result} stale={!previewFresh} formatDate={fmt} />
            ) : null}
          </div>
        </form>
      ) : null}

      {lastAnnotation ? (
        <p className="aiu-hint" aria-hidden="true">
          {maskEmails ? maskForDisplay(lastAnnotation) : lastAnnotation}
        </p>
      ) : null}

      <div className="aiu-section">
        <Heading level={sub} className="aiu-h3" id={ids.history}>
          History
        </Heading>
        {runs.length === 0 ? (
          <p className="aiu-empty">Nothing applied yet.</p>
        ) : (
          <ol className="aiu-runs" aria-labelledby={ids.history}>
            {runs.map((run) => (
              <li key={run.id} className="aiu-run">
                <span className="aiu-run-action">{RUN_WORDS[run.action] ?? run.action}</span>
                <span>{run.summary ? who(run.summary) : `${number(run.subjectsChanged)} changed`}</span>
                <span className="aiu-run-meta">
                  {[fmt(run.runAt), who(run.runBy) && `by ${who(run.runBy)}`, run.sessionsAffected != null && `${number(run.sessionsAffected)} sessions`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <p className="aiu-sr" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

function PreviewBox(props: { result: PreviewView; stale: boolean; formatDate: (value: DateLike | null | undefined) => string }): ReactElement {
  const { result, stale, formatDate } = props;
  const subjects = subjectWords(result.subjects);
  const already = result.alreadyExcluded ? subjectWords(result.alreadyExcluded) : "";
  const all = result.windows.find((w) => w.key === "all");
  return (
    <div className="aiu-preview" data-stale={stale ? "true" : undefined}>
      {result.duplicateOf ? <p className="aiu-warn">An active rule already says this — there is nothing to add.</p> : null}
      {result.retroactive ? (
        <p>
          <b>{subjects ? `Matches ${subjects}.` : "Matches nothing in history yet."}</b>
          {already ? ` Already excluded: ${already}.` : ""}
          {all?.earliest ? ` Reaches back to ${formatDate(all.earliest)}.` : ""}
        </p>
      ) : (
        <p>
          <b>New visits only.</b> This kind of rule is checked as visits arrive; history cannot be matched.
        </p>
      )}
      {result.windows.length ? (
        <div className="aiu-scroll" role="region" aria-label="Preview counts" tabIndex={0}>
          <table className="aiu-table">
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Sessions now</th>
                <th scope="col">Would exclude</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {result.windows.map((window) => (
                <tr key={window.key}>
                  <th scope="row">{window.label}</th>
                  <td>{number(window.before.sessions)}</td>
                  <td>{number(window.excluded.sessions)}</td>
                  <td>{number(window.after.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.limits.length ? (
        <ul className="aiu-limits">
          {result.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarkThisBrowserButton
// ---------------------------------------------------------------------------

export interface MarkThisBrowserButtonProps {
  /** Mark the visitor whose cookie this request carries (a server action reading it). */
  onMark: () => Promise<unknown>;
  /** Already marked: show the state, not the button. */
  marked?: boolean;
  label?: string;
  theme?: AudienceTheme;
  /** Shown after a successful mark. Default: "This browser is now excluded from analytics." Say how far back it reaches only if your visitor ids are stable. */
  doneMessage?: string;
}

/** "Exclude this browser from analytics" — for the client team's phones and signed-out laptops. */
export function MarkThisBrowserButton(props: MarkThisBrowserButtonProps): ReactElement {
  const { onMark, marked = false, label = "Exclude this browser from analytics", theme, doneMessage } = props;
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(marked ? "done" : "idle");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (marked) setState("done");
  }, [marked]);

  async function mark(): Promise<void> {
    if (state === "busy") return;
    setState("busy");
    setMessage("");
    try {
      const result = await onMark();
      if (!mounted.current) return;
      const failure = resolvedError(result);
      if (failure) {
        setState("error");
        setMessage(failure);
        return;
      }
      setState("done");
      // How far back this reaches depends on the app's visitor ids (a
      // rotating cookieless key reaches only today and yesterday), so the
      // default text promises nothing about the past.
      setMessage(doneMessage ?? "This browser is now excluded from analytics.");
    } catch (error) {
      if (!mounted.current) return;
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  return (
    <div className="aiu-root aiu-mark" data-aiu-theme={theme}>
      <AudienceStyles />
      {state === "done" ? (
        <p className="aiu-done">This browser is excluded from analytics.</p>
      ) : (
        <button type="button" className="aiu-btn" aria-busy={state === "busy"} disabled={state === "busy"} onClick={() => void mark()}>
          {state === "busy" ? "Marking…" : label}
        </button>
      )}
      <p className="aiu-status aiu-hint" role="status">
        {state === "done" ? message : ""}
      </p>
      {state === "error" ? (
        <p className="aiu-error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnfilteredSourcesNote
// ---------------------------------------------------------------------------

export interface UnfilteredSource {
  name: string;
  why: string;
}

export const DEFAULT_UNFILTERED_SOURCES: readonly UnfilteredSource[] = [
  { name: "Google Search Console", why: "staff searches and clicks are counted at Google" },
  { name: "AI answer engines (AEO)", why: "citations are other companies' answers; our own probe questions are internal by definition" },
  { name: "Stripe and Clerk dashboards", why: "their own counts include test customers and staff accounts" },
  { name: "Digests already sent", why: "an email that went out keeps the numbers it had" },
  { name: "Ad pixels (Meta, Google Ads, Floodlight)", why: "conversions are counted by the ad network — prevent them at the source" },
];

export interface UnfilteredSourcesNoteProps {
  sources?: readonly UnfilteredSource[];
  title?: string;
  headingLevel?: 2 | 3 | 4;
  theme?: AudienceTheme;
}

/** Labels the numbers that come from outside the app — they cannot be cleaned. */
export function UnfilteredSourcesNote(props: UnfilteredSourcesNoteProps): ReactElement {
  const { sources = DEFAULT_UNFILTERED_SOURCES, title = "Not filtered", headingLevel = 3, theme } = props;
  const id = `${useId()}-unfiltered`;
  return (
    <aside className="aiu-root aiu-unfiltered" aria-labelledby={id} data-aiu-theme={theme}>
      <AudienceStyles />
      <Heading level={headingLevel} className="aiu-h3" id={id}>
        {title}
      </Heading>
      <p>These numbers come from outside this app, so staff and test traffic cannot be removed from them:</p>
      <ul>
        {sources.map((source) => (
          <li key={source.name}>
            <b>{source.name}</b> — {source.why}.
          </li>
        ))}
      </ul>
    </aside>
  );
}

// Pure URL helpers for the "Include internal traffic" toggle, re-exported here
// so a client component can use them without importing the root or core
// entries (which load Node's crypto).
export { INCLUDE_INTERNAL_PARAM, includeInternalHref, readIncludeInternal } from "./core/defaults.js";
