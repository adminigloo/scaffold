/**
 * Core Web Vitals — Google's published good / needs-improvement boundaries,
 * assessed at the 75th percentile of page loads (the number Search Console and
 * PageSpeed report). Framework-free so the server, the dashboard and the
 * homepage window all rate a value the same way.
 *
 *   LCP ≤ 2500 ms good, > 4000 ms poor
 *   INP ≤ 200 ms good,  > 500 ms poor
 *   CLS ≤ 0.1 good,     > 0.25 poor
 */

export const WEB_VITAL_METRICS = ["LCP", "INP", "CLS"] as const;
export type WebVitalMetric = (typeof WEB_VITAL_METRICS)[number];
export type WebVitalRating = "good" | "needs-improvement" | "poor";

export const WEB_VITAL_THRESHOLDS: Record<WebVitalMetric, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
};

export const WEB_VITAL_LABELS: Record<WebVitalMetric, string> = {
  LCP: "Largest Contentful Paint",
  INP: "Interaction to Next Paint",
  CLS: "Cumulative Layout Shift",
};

export function isWebVitalMetric(name: string): name is WebVitalMetric {
  return (WEB_VITAL_METRICS as readonly string[]).includes(name);
}

/** Boundary values count as the better bucket, matching the web-vitals library. */
export function rateWebVital(metric: WebVitalMetric, value: number): WebVitalRating {
  const threshold = WEB_VITAL_THRESHOLDS[metric];
  if (value <= threshold.good) return "good";
  if (value <= threshold.poor) return "needs-improvement";
  return "poor";
}

export function formatWebVital(metric: WebVitalMetric, value: number): string {
  if (metric === "CLS") return value.toFixed(2);
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/** Plausible ceilings: a value past these is a broken client or a forged beacon, not a slow page. */
export const WEB_VITAL_MAX: Record<WebVitalMetric, number> = { LCP: 60_000, INP: 30_000, CLS: 10 };

export interface WebVitalSummary {
  metric: WebVitalMetric;
  /** null: no samples in the range. */
  p75: number | null;
  samples: number;
  rating: WebVitalRating | null;
}

/** Always all three metrics, in LCP / INP / CLS order, nulls where there is no field data yet. */
export function summarizeWebVitals(rows: Array<{ metric: string; p75: number | string | null; samples: number | string }>): WebVitalSummary[] {
  const byMetric = new Map(rows.filter((row) => isWebVitalMetric(row.metric)).map((row) => [row.metric, row]));
  return WEB_VITAL_METRICS.map((metric) => {
    const row = byMetric.get(metric);
    const p75 = row && row.p75 !== null && Number.isFinite(Number(row.p75)) ? Number(row.p75) : null;
    return { metric, p75, samples: row ? Number(row.samples) : 0, rating: p75 === null ? null : rateWebVital(metric, p75) };
  });
}
