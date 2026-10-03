import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import type { ActivityReport, CrawlerReport, Metric, PipelineHealth } from "./reports.js";
import { SOURCE_LABELS, type SourceBucket } from "./sources.js";
import { CRAWLER_KIND_LABELS, type CrawlerKind } from "./crawlers.js";
import { formatWebVital, WEB_VITAL_LABELS, WEB_VITAL_THRESHOLDS, type WebVitalSummary } from "./vitals.js";

/**
 * The report components — the `./dashboard` entry. Presentational and
 * controlled: they draw what the host's reports return and fetch nothing, so
 * they work under tRPC, server components passing props, or plain fetch.
 * Styling is injected and `aia-`-prefixed, the board's rule: a package class
 * name means nothing to the consumer's Tailwind build, and the components must
 * read as native in a light or dark admin whose theme they cannot know.
 */

const STYLE_ID = "aia-styles";

const CSS_TEXT = `
.aia {
  --aia-surface: #ffffff;
  --aia-surface-2: #f5f7f9;
  --aia-ink: #0e161c;
  --aia-ink-muted: #55636f;
  --aia-ink-faint: #8494a1;
  --aia-line: #e1e7ec;
  --aia-line-strong: #c3ced7;
  --aia-accent: #0f766e;
  --aia-accent-soft: #d9efec;
  --aia-ai: #6d4bd8;
  --aia-ai-soft: #ebe5fb;
  --aia-good: #1b7a43;
  --aia-good-soft: #dcf1e4;
  --aia-warn: #8a5a00;
  --aia-warn-soft: #fbefd5;
  --aia-bad: #b3261e;
  --aia-bad-soft: #f9e0dd;
  --aia-shadow: 0 1px 2px rgba(14,22,28,.06);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--aia-ink);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not(.light) .aia {
    --aia-surface: #161d23; --aia-surface-2: #0f1418; --aia-ink: #e8edf1; --aia-ink-muted: #93a2ae; --aia-ink-faint: #61707c;
    --aia-line: #29343d; --aia-line-strong: #3c4a55; --aia-accent: #45c4ad; --aia-accent-soft: #113029; --aia-ai: #a993f5; --aia-ai-soft: #251d45;
    --aia-good: #5fd08f; --aia-good-soft: #12301f; --aia-warn: #e2b553; --aia-warn-soft: #332608; --aia-bad: #f08a80; --aia-bad-soft: #3a1512;
    --aia-shadow: 0 1px 2px rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"] .aia, .dark .aia {
  --aia-surface: #161d23; --aia-surface-2: #0f1418; --aia-ink: #e8edf1; --aia-ink-muted: #93a2ae; --aia-ink-faint: #61707c;
  --aia-line: #29343d; --aia-line-strong: #3c4a55; --aia-accent: #45c4ad; --aia-accent-soft: #113029; --aia-ai: #a993f5; --aia-ai-soft: #251d45;
  --aia-good: #5fd08f; --aia-good-soft: #12301f; --aia-warn: #e2b553; --aia-warn-soft: #332608; --aia-bad: #f08a80; --aia-bad-soft: #3a1512;
  --aia-shadow: 0 1px 2px rgba(0,0,0,.4);
}
.aia *, .aia *::before, .aia *::after { box-sizing: border-box; }
.aia-panel { background: var(--aia-surface); border: 1px solid var(--aia-line); border-radius: 14px; box-shadow: var(--aia-shadow); min-width: 0; }
.aia-panel-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 0; }
.aia-panel-title { font-size: 13px; font-weight: 650; letter-spacing: -.005em; }
.aia-panel-sub { font-size: 12px; color: var(--aia-ink-muted); margin-top: 2px; line-height: 1.45; }
.aia-panel-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.aia-panel-body { padding: 12px 16px 16px; }
.aia-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.aia-kpi { padding: 14px 16px; }
.aia-kpi-label { font-size: 12px; color: var(--aia-ink-muted); font-weight: 550; }
.aia-kpi-value { font-size: 28px; font-weight: 680; letter-spacing: -.02em; margin-top: 4px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.aia-kpi-foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11.5px; color: var(--aia-ink-faint); min-height: 18px; flex-wrap: wrap; }
.aia-delta { font-weight: 650; font-variant-numeric: tabular-nums; padding: 1px 6px; border-radius: 999px; font-size: 11px; }
.aia-delta-up { color: var(--aia-good); background: var(--aia-good-soft); }
.aia-delta-down { color: var(--aia-bad); background: var(--aia-bad-soft); }
.aia-delta-flat { color: var(--aia-ink-muted); background: var(--aia-surface-2); }
.aia-tag { font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--aia-line); color: var(--aia-ink-muted); white-space: nowrap; }
.aia-tag-ai { color: var(--aia-ai); background: var(--aia-ai-soft); border-color: transparent; }
.aia-tag-good { color: var(--aia-good); background: var(--aia-good-soft); border-color: transparent; }
.aia-tag-warn { color: var(--aia-warn); background: var(--aia-warn-soft); border-color: transparent; }
.aia-tag-bad { color: var(--aia-bad); background: var(--aia-bad-soft); border-color: transparent; }
.aia-chart { position: relative; width: 100%; }
.aia-chart svg { display: block; overflow: visible; }
.aia-chart-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--aia-ink-muted); margin-bottom: 8px; }
.aia-chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.aia-swatch { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
.aia-tip { position: absolute; top: 0; pointer-events: none; background: var(--aia-surface); border: 1px solid var(--aia-line-strong); border-radius: 8px;
  padding: 7px 9px; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.14); white-space: nowrap; z-index: 2; }
.aia-tip-date { font-weight: 650; margin-bottom: 3px; }
.aia-tip-row { display: flex; align-items: center; gap: 6px; color: var(--aia-ink-muted); }
.aia-tip-row b { color: var(--aia-ink); margin-left: auto; padding-left: 12px; font-variant-numeric: tabular-nums; }
.aia-bars { display: flex; flex-direction: column; gap: 6px; }
.aia-bar { position: relative; display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 7px; font-size: 13px; min-height: 30px; }
.aia-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 7px; background: var(--aia-accent-soft); }
.aia-bar-fill.aia-tone-ai { background: var(--aia-ai-soft); }
.aia-bar-label { position: relative; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
.aia-bar-value { position: relative; margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
.aia-bar-hint { position: relative; font-size: 11.5px; color: var(--aia-ink-faint); font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
.aia-empty { font-size: 13px; color: var(--aia-ink-muted); padding: 18px 4px; text-align: center; line-height: 1.5; }
.aia-table-wrap { overflow-x: auto; margin: 0 -16px; padding: 0 16px; }
.aia-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.aia-table th { text-align: left; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--aia-ink-faint);
  padding: 6px 8px; border-bottom: 1px solid var(--aia-line); white-space: nowrap; }
.aia-table th button { all: unset; cursor: pointer; }
.aia-table th button:focus-visible { outline: 2px solid var(--aia-accent); outline-offset: 2px; border-radius: 3px; }
.aia-table td { padding: 8px; border-bottom: 1px solid var(--aia-line); font-variant-numeric: tabular-nums; vertical-align: top; }
.aia-table tr:last-child td { border-bottom: 0; }
.aia-num { text-align: right !important; }
.aia-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.aia-btn { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--aia-line-strong);
  background: var(--aia-surface); color: var(--aia-ink); cursor: pointer; }
.aia-btn:hover { background: var(--aia-surface-2); }
.aia-btn:focus-visible { outline: 2px solid var(--aia-accent); outline-offset: 2px; }
.aia-tabs { display: inline-flex; border: 1px solid var(--aia-line); border-radius: 9px; padding: 2px; background: var(--aia-surface-2); }
.aia-tabs button { font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 7px; border: 0; background: transparent; color: var(--aia-ink-muted); cursor: pointer; }
.aia-tabs button[aria-pressed="true"] { background: var(--aia-surface); color: var(--aia-ink); box-shadow: var(--aia-shadow); }
.aia-vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.aia-vital { border: 1px solid var(--aia-line); border-radius: 10px; padding: 10px 12px; }
.aia-vital-name { font-size: 12px; font-weight: 650; display: flex; align-items: center; gap: 6px; }
.aia-vital-full { font-size: 11px; color: var(--aia-ink-faint); }
.aia-vital-value { font-size: 22px; font-weight: 680; margin: 6px 0 8px; font-variant-numeric: tabular-nums; }
.aia-vital-scale { position: relative; height: 6px; border-radius: 3px; display: flex; overflow: hidden; }
.aia-vital-scale i { display: block; height: 100%; }
.aia-vital-marker { position: absolute; top: -3px; width: 2px; height: 12px; background: var(--aia-ink); border-radius: 1px; }
.aia-vital-foot { font-size: 11px; color: var(--aia-ink-faint); margin-top: 6px; }
.aia-health { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 12px; color: var(--aia-ink-muted); }
.aia-health span { display: inline-flex; align-items: center; gap: 6px; }
.aia-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--aia-line-strong); }
.aia-dot-good { background: var(--aia-good); }
.aia-dot-warn { background: var(--aia-warn); }
.aia-heat { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)); gap: 2px; font-size: 10px; color: var(--aia-ink-faint); }
.aia-heat-cell { aspect-ratio: 1; border-radius: 3px; background: var(--aia-surface-2); min-height: 10px; }
.aia-kinds { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--aia-surface-2); margin: 4px 0 10px; }
.aia-kinds i { display: block; height: 100%; }
.aia-kind-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--aia-ink-muted); margin-bottom: 12px; }
.aia-kind-legend span { display: inline-flex; align-items: center; gap: 6px; }
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

function useStyles(): void {
  useEffect(injectStyles, []);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type ValueFormat = "number" | "percent" | "duration" | "decimal";

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatValue(value: number | null | undefined, format: ValueFormat = "number"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (format === "percent") return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
  if (format === "duration") return formatDuration(value);
  if (format === "decimal") return value.toFixed(value >= 10 ? 0 : 1);
  return formatNumber(value);
}

/** "3 min ago", "2 h ago", "4 d ago" — or "never". */
export function formatAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

function shortDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One CSV cell, quoted, and neutralized against formula injection: a referrer,
 * campaign or click label is visitor-supplied, and `=HYPERLINK(...)` opening in
 * the owner's spreadsheet is the attack. A leading = + - @ tab or CR gets a `'`.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/** The `.aia` scope every component needs once above it: the tokens and the dark theme. */
export function AnalyticsScope({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  useStyles();
  return <div className={`aia${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Panel({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }): ReactElement {
  useStyles();
  return (
    <section className={`aia-panel${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <div className="aia-panel-head">
          <div>
            {title ? <div className="aia-panel-title">{title}</div> : null}
            {subtitle ? <div className="aia-panel-sub">{subtitle}</div> : null}
          </div>
          {actions ? <div className="aia-panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="aia-panel-body">{children}</div>
    </section>
  );
}

export function RangeTabs<T extends string | number>({ value, options, onChange, label = "Date range" }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void; label?: string }): ReactElement {
  useStyles();
  return (
    <div className="aia-tabs" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={String(option.value)} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export function DeltaBadge({ metric, periodLabel }: { metric: Metric; periodLabel?: string }): ReactElement {
  if (metric.priorPartial) return <span className="aia-tag">first period</span>;
  if (metric.deltaPct === null) return <span className="aia-tag">{metric.current > 0 ? "new" : "no change"}</span>;
  const rounded = Math.round(metric.deltaPct);
  const tone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return (
    <span className={`aia-delta aia-delta-${tone}`} title={`${formatNumber(metric.prior)} in the previous ${periodLabel ?? "period"}`}>
      {rounded > 0 ? "+" : ""}
      {rounded}%
    </span>
  );
}

export function KpiCard({ label, metric, value, format = "number", hint, periodLabel }: { label: string; metric?: Metric; value?: number | null; format?: ValueFormat; hint?: ReactNode; periodLabel?: string }): ReactElement {
  useStyles();
  const shown = metric ? metric.current : value;
  return (
    <div className="aia-panel aia-kpi">
      <div className="aia-kpi-label">{label}</div>
      <div className="aia-kpi-value">{formatValue(shown, format)}</div>
      <div className="aia-kpi-foot">
        {metric ? <DeltaBadge metric={metric} periodLabel={periodLabel} /> : null}
        {metric?.smallSample && metric.current > 0 ? <span className="aia-tag aia-tag-warn" title="Fewer than 30 — a few visits swing this a lot">small sample</span> : null}
        {hint ? <span>{hint}</span> : null}
      </div>
    </div>
  );
}

export function KpiGrid({ children }: { children: ReactNode }): ReactElement {
  useStyles();
  return <div className="aia-kpis">{children}</div>;
}

// ---------------------------------------------------------------------------
// Trend chart — dependency-free SVG; nulls (before tracking) break the line.
// ---------------------------------------------------------------------------

export type Tone = "accent" | "ai" | "muted";
const TONE_VAR: Record<Tone, string> = { accent: "var(--aia-accent)", ai: "var(--aia-ai)", muted: "var(--aia-ink-faint)" };

export interface TrendSeries {
  key: string;
  label: string;
  tone?: Tone;
  /** Fill under the line. Default true for the first series only. */
  area?: boolean;
}

export interface TrendAnnotation {
  day: string;
  label: string;
}

function niceCeil(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

export function TrendChart<P extends { date: string }>({
  points,
  series,
  annotations = [],
  height = 220,
  format = "number",
  empty = "No visits recorded in this range yet.",
}: {
  points: readonly P[];
  series: readonly TrendSeries[];
  annotations?: readonly TrendAnnotation[];
  height?: number;
  format?: ValueFormat;
  empty?: ReactNode;
}): ReactElement {
  useStyles();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const valueOf = (point: P, key: string): number | null => {
    const raw = (point as unknown as Record<string, unknown>)[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  const max = useMemo(() => niceCeil(Math.max(0, ...points.flatMap((point) => series.map((s) => valueOf(point, s.key) ?? 0)))), [points, series]);
  const hasData = points.some((point) => series.some((s) => (valueOf(point, s.key) ?? 0) > 0));
  const firstTracked = points.findIndex((point) => series.some((s) => valueOf(point, s.key) !== null));

  const pad = { top: 8, right: 8, bottom: 22, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (index: number) => pad.left + (points.length <= 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;

  const paths = series.map((s, seriesIndex) => {
    let line = "";
    let area = "";
    let runStart: number | null = null;
    let lastIndex = -1;
    points.forEach((point, index) => {
      const value = valueOf(point, s.key);
      if (value === null) {
        if (runStart !== null) area += `L${x(lastIndex)},${y(0)}L${x(runStart)},${y(0)}Z`;
        runStart = null;
        return;
      }
      const command = runStart === null ? "M" : "L";
      line += `${command}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      area += `${command}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      if (runStart === null) runStart = index;
      lastIndex = index;
    });
    if (runStart !== null) area += `L${x(lastIndex)},${y(0)}L${x(runStart)},${y(0)}Z`;
    return { s, line, area, showArea: s.area ?? seriesIndex === 0 };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const labelIndexes = points.length <= 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const annotationIndexes = annotations.map((a) => ({ ...a, index: points.findIndex((p) => p.date === a.day) })).filter((a) => a.index >= 0);

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relative = ((event.clientX - rect.left) / rect.width) * width - pad.left;
    const index = Math.round((relative / innerW) * (points.length - 1));
    setHover(index >= 0 && index < points.length ? index : null);
  };

  const hovered = hover === null ? null : points[hover];
  return (
    <div className="aia-chart" ref={wrapRef}>
      {series.length > 1 ? (
        <div className="aia-chart-legend">
          {series.map((s) => (
            <span key={s.key}>
              <i className="aia-swatch" style={{ background: TONE_VAR[s.tone ?? "accent"] }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.label).join(" and ")} by day`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--aia-line)" strokeDasharray={tick === 0 ? undefined : "2 4"} />
            <text x={pad.left - 6} y={y(tick) + 3} textAnchor="end" fontSize="10" fill="var(--aia-ink-faint)">
              {formatNumber(tick)}
            </text>
          </g>
        ))}
        {firstTracked > 0 ? (
          <g>
            <rect x={pad.left} y={pad.top} width={Math.max(0, x(firstTracked) - pad.left)} height={innerH} fill="var(--aia-surface-2)" />
            {x(firstTracked) - pad.left > 70 ? (
              <text x={(pad.left + x(firstTracked)) / 2} y={pad.top + innerH / 2} textAnchor="middle" fontSize="10.5" fill="var(--aia-ink-faint)">
                not tracking yet
              </text>
            ) : null}
          </g>
        ) : null}
        {paths.map(({ s, area, showArea }) =>
          showArea && area ? <path key={`${s.key}-area`} d={area} fill={TONE_VAR[s.tone ?? "accent"]} opacity={0.12} /> : null,
        )}
        {paths.map(({ s, line }) => (line ? <path key={s.key} d={line} fill="none" stroke={TONE_VAR[s.tone ?? "accent"]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null))}
        {paths.map(({ s }) =>
          points.length <= 45
            ? points.map((point, index) => {
                const value = valueOf(point, s.key);
                return value !== null && value > 0 ? <circle key={`${s.key}-${index}`} cx={x(index)} cy={y(value)} r={2.4} fill={TONE_VAR[s.tone ?? "accent"]} /> : null;
              })
            : null,
        )}
        {annotationIndexes.map((a) => (
          <g key={`${a.day}-${a.label}`}>
            <line x1={x(a.index)} x2={x(a.index)} y1={pad.top} y2={pad.top + innerH} stroke="var(--aia-warn)" strokeDasharray="3 3" />
            <circle cx={x(a.index)} cy={pad.top + 3} r={3.5} fill="var(--aia-warn)">
              <title>{`${shortDate(a.day)}: ${a.label}`}</title>
            </circle>
          </g>
        ))}
        {labelIndexes.map((index) =>
          points[index] ? (
            <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fontSize="10.5" fill="var(--aia-ink-faint)">
              {shortDate(points[index]!.date)}
            </text>
          ) : null,
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--aia-line-strong)" /> : null}
      </svg>
      {!hasData ? <div className="aia-empty" style={{ position: "absolute", inset: `${pad.top}px 0 ${pad.bottom}px ${pad.left}px`, display: "grid", placeItems: "center", padding: 0 }}>{empty}</div> : null}
      {hovered && hover !== null ? (
        <div className="aia-tip" style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 170) }}>
          <div className="aia-tip-date">{shortDate(hovered.date)}</div>
          {series.map((s) => (
            <div key={s.key} className="aia-tip-row">
              <i className="aia-swatch" style={{ background: TONE_VAR[s.tone ?? "accent"] }} />
              {s.label}
              <b>{valueOf(hovered, s.key) === null ? "not tracked" : formatValue(valueOf(hovered, s.key), format)}</b>
            </div>
          ))}
          {annotationIndexes
            .filter((a) => a.index === hover)
            .map((a) => (
              <div key={a.label} className="aia-tip-row" style={{ color: "var(--aia-warn)" }}>
                ◆ {a.label}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranked bars
// ---------------------------------------------------------------------------

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  hint?: ReactNode;
  tone?: Tone;
  badge?: ReactNode;
}

export function BarList({ rows, format = "number", empty = "Nothing recorded in this range yet.", limit }: { rows: readonly BarRow[]; format?: ValueFormat; empty?: ReactNode; limit?: number }): ReactElement {
  useStyles();
  const shown = (limit ? rows.slice(0, limit) : rows).filter((row) => row.value > 0);
  if (shown.length === 0) return <div className="aia-empty">{empty}</div>;
  const top = Math.max(...shown.map((row) => row.value));
  return (
    <div className="aia-bars">
      {shown.map((row) => (
        <div key={row.key} className="aia-bar">
          <span className={`aia-bar-fill${row.tone === "ai" ? " aia-tone-ai" : ""}`} style={{ width: `${Math.max(2, (row.value / top) * 100)}%` }} />
          <span className="aia-bar-label">
            {row.label}
            {row.badge}
          </span>
          <span className="aia-bar-value">{formatValue(row.value, format)}</span>
          {row.hint !== undefined ? <span className="aia-bar-hint">{row.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Sources as bars, AI assistants in their own colour — the row people ask about. */
export function SourceBars({ rows, empty }: { rows: ReadonlyArray<{ source: SourceBucket; visits: number; deltaPct?: number | null; engagedRate?: number | null }>; empty?: ReactNode }): ReactElement {
  return (
    <BarList
      empty={empty}
      rows={rows.map((row) => ({
        key: row.source,
        label: SOURCE_LABELS[row.source] ?? row.source,
        value: row.visits,
        tone: row.source === "aiAssistant" ? "ai" : "accent",
        hint: row.engagedRate === null || row.engagedRate === undefined ? undefined : `${Math.round(row.engagedRate)}% eng.`,
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  label: string;
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  format?: ValueFormat;
  numeric?: boolean;
  mono?: boolean;
}

export function DataTable<T>({ columns, rows, csvName, empty = "Nothing recorded in this range yet.", initialSort, limit }: { columns: ReadonlyArray<Column<T>>; rows: readonly T[]; csvName?: string; empty?: ReactNode; initialSort?: { key: string; desc?: boolean }; limit?: number }): ReactElement {
  useStyles();
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ? { key: initialSort.key, desc: initialSort.desc ?? true } : null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return rows;
    return [...rows].sort((a, b) => {
      const av = column.value(a);
      const bv = column.value(b);
      if (av === bv) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.desc ? -order : order;
    });
  }, [rows, columns, sort]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  if (rows.length === 0) return <div className="aia-empty">{empty}</div>;
  return (
    <div>
      {csvName ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button type="button" className="aia-btn" onClick={() => download(`${csvName}.csv`, toCsv(columns.map((c) => c.label), sorted.map((row) => columns.map((c) => c.value(row)))))}>
            Export CSV
          </button>
        </div>
      ) : null}
      <div className="aia-table-wrap">
        <table className="aia-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.numeric ? "aia-num" : undefined} aria-sort={sort?.key === column.key ? (sort.desc ? "descending" : "ascending") : undefined}>
                  <button type="button" onClick={() => setSort((current) => ({ key: column.key, desc: current?.key === column.key ? !current.desc : column.numeric !== false }))}>
                    {column.label}
                    {sort?.key === column.key ? (sort.desc ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key} className={[column.numeric ? "aia-num" : "", column.mono ? "aia-mono" : ""].filter(Boolean).join(" ") || undefined}>
                    {column.render ? column.render(row) : column.format ? formatValue(column.value(row) as number | null, column.format) : (column.value(row) ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && sorted.length > limit ? <div className="aia-empty" style={{ padding: "8px 0 0", textAlign: "left" }}>Showing {limit} of {sorted.length}{csvName ? " — the CSV has all of them" : ""}.</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crawlers
// ---------------------------------------------------------------------------

const KIND_COLOR: Record<CrawlerKind, string> = {
  "ai-assistant": "var(--aia-ai)",
  "ai-search": "color-mix(in srgb, var(--aia-ai) 65%, var(--aia-surface))",
  "ai-training": "color-mix(in srgb, var(--aia-ai) 35%, var(--aia-surface))",
  search: "var(--aia-accent)",
  social: "color-mix(in srgb, var(--aia-accent) 50%, var(--aia-surface))",
  "seo-tool": "var(--aia-warn)",
  other: "var(--aia-line-strong)",
};

export function CrawlerPanel({ report, now, limit = 12 }: { report: CrawlerReport; now?: Date; limit?: number }): ReactElement {
  useStyles();
  const total = Object.values(report.byKind).reduce((sum, value) => sum + value, 0);
  if (total === 0) return <div className="aia-empty">No crawler has fetched a page in this range yet. Search engines and AI assistants show up here as they read the site.</div>;
  const kinds = (Object.keys(report.byKind) as CrawlerKind[]).filter((kind) => report.byKind[kind] > 0);
  return (
    <div>
      <div className="aia-kinds" role="img" aria-label="Crawler fetches by kind">
        {kinds.map((kind) => (
          <i key={kind} style={{ width: `${(report.byKind[kind] / total) * 100}%`, background: KIND_COLOR[kind] }} title={`${CRAWLER_KIND_LABELS[kind]}: ${report.byKind[kind]}`} />
        ))}
      </div>
      <div className="aia-kind-legend">
        {kinds.map((kind) => (
          <span key={kind}>
            <i className="aia-dot" style={{ background: KIND_COLOR[kind] }} />
            {CRAWLER_KIND_LABELS[kind]} <b style={{ color: "var(--aia-ink)" }}>{formatNumber(report.byKind[kind])}</b>
          </span>
        ))}
      </div>
      <DataTable
        rows={report.bots}
        limit={limit}
        initialSort={{ key: "hits" }}
        columns={[
          {
            key: "bot",
            label: "Crawler",
            value: (row) => row.botName,
            render: (row) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <b style={{ fontWeight: 600 }}>{row.botName}</b>
                {row.operator ? <span style={{ color: "var(--aia-ink-faint)" }}>{row.operator}</span> : null}
                <span className={`aia-tag${row.kind.startsWith("ai-") ? " aia-tag-ai" : ""}`}>{CRAWLER_KIND_LABELS[row.kind]}</span>
              </span>
            ),
          },
          { key: "hits", label: "Fetches", value: (row) => row.hits, format: "number", numeric: true },
          {
            key: "verified",
            label: "Verified",
            numeric: true,
            value: (row) => (row.hits ? row.verifiedHits / row.hits : 0),
            render: (row) =>
              row.verifiedHits === row.hits ? (
                <span className="aia-tag aia-tag-good" title="Every fetch came from the operator's published IP ranges">verified</span>
              ) : row.verifiedHits > 0 ? (
                <span className="aia-tag aia-tag-warn">{Math.round((row.verifiedHits / row.hits) * 100)}%</span>
              ) : (
                <span className="aia-tag" title="Claims this name; not from a published range (or the operator publishes none)">claimed</span>
              ),
          },
          { key: "pages", label: "Pages", value: (row) => row.pages, format: "number", numeric: true },
          { key: "last", label: "Last seen", value: (row) => row.lastSeen, render: (row) => formatAgo(row.lastSeen, now) },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Core Web Vitals
// ---------------------------------------------------------------------------

export function VitalsCard({ summary, minSamples = 1 }: { summary: readonly WebVitalSummary[]; minSamples?: number }): ReactElement {
  useStyles();
  return (
    <div className="aia-vitals">
      {summary.map((entry) => {
        const threshold = WEB_VITAL_THRESHOLDS[entry.metric];
        const scaleMax = threshold.poor * 1.5;
        const shown = entry.p75 !== null && entry.samples >= minSamples;
        const tone = entry.rating === "good" ? "good" : entry.rating === "poor" ? "bad" : "warn";
        return (
          <div key={entry.metric} className="aia-vital">
            <div className="aia-vital-name">
              {entry.metric}
              {shown && entry.rating ? <span className={`aia-tag aia-tag-${tone}`}>{entry.rating === "needs-improvement" ? "needs work" : entry.rating}</span> : null}
            </div>
            <div className="aia-vital-full">{WEB_VITAL_LABELS[entry.metric]}</div>
            <div className="aia-vital-value">{shown && entry.p75 !== null ? formatWebVital(entry.metric, entry.p75) : "—"}</div>
            <div className="aia-vital-scale" aria-hidden="true">
              <i style={{ width: `${(threshold.good / scaleMax) * 100}%`, background: "var(--aia-good)" }} />
              <i style={{ width: `${((threshold.poor - threshold.good) / scaleMax) * 100}%`, background: "var(--aia-warn)" }} />
              <i style={{ flex: 1, background: "var(--aia-bad)" }} />
              {shown && entry.p75 !== null ? <span className="aia-vital-marker" style={{ left: `calc(${Math.min(100, (entry.p75 / scaleMax) * 100)}% - 1px)` }} /> : null}
            </div>
            <div className="aia-vital-foot">
              {entry.samples === 0 ? "No field data yet" : shown ? `p75 of ${formatNumber(entry.samples)} page loads` : `${entry.samples} of ${minSamples} loads needed`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity heatmap
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityHeatmap({ activity }: { activity: ActivityReport }): ReactElement {
  useStyles();
  const top = Math.max(0, ...activity.grid.flat());
  if (top === 0) return <div className="aia-empty">No visits in this range yet.</div>;
  return (
    <div className="aia-heat" role="img" aria-label="Visits by weekday and hour">
      <span />
      {Array.from({ length: 24 }, (_, hour) => (
        <span key={hour} style={{ textAlign: "center" }}>
          {hour % 6 === 0 ? hour : ""}
        </span>
      ))}
      {activity.grid.map((day, weekday) => (
        <Fragment key={weekday}>
          <span style={{ alignSelf: "center" }}>{WEEKDAYS[weekday]}</span>
          {day.map((visits, hour) => (
            <span
              key={hour}
              className="aia-heat-cell"
              title={`${WEEKDAYS[weekday]} ${String(hour).padStart(2, "0")}:00 — ${visits} visit${visits === 1 ? "" : "s"}`}
              style={visits ? { background: `color-mix(in srgb, var(--aia-accent) ${Math.round(18 + (visits / top) * 82)}%, var(--aia-surface-2))` } : undefined}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline health — a report can be empty because nobody came, or because
// the beacon broke. This strip says which.
// ---------------------------------------------------------------------------

export function HealthStrip({ health, now = new Date(), staleHours = 48 }: { health: PipelineHealth; now?: Date; staleHours?: number }): ReactElement {
  useStyles();
  const item = (label: string, iso: string | null) => {
    const age = iso ? (now.getTime() - new Date(iso).getTime()) / 3_600_000 : null;
    const tone = age === null ? "" : age <= staleHours ? " aia-dot-good" : " aia-dot-warn";
    return (
      <span key={label} title={iso ?? "nothing recorded yet"}>
        <i className={`aia-dot${tone}`} />
        {label} <b style={{ color: "var(--aia-ink)", fontWeight: 600 }}>{formatAgo(iso, now)}</b>
      </span>
    );
  };
  return (
    <div className="aia-health">
      {item("Page view", health.lastPageView)}
      {item("Click", health.lastEvent)}
      {item("Web vital", health.lastWebVital)}
      {item("Conversion", health.lastConversion)}
      {item("Crawler", health.lastCrawlerHit)}
      {item("AI crawler", health.lastAiCrawlerHit)}
      <span>
        Tracking since <b style={{ color: "var(--aia-ink)", fontWeight: 600 }}>{health.trackingSince ? new Date(health.trackingSince).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</b>
      </span>
    </div>
  );
}
