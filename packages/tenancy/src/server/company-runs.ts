import type { TenancyService } from "./types.js";

/**
 * Every company, one at a time-ish, for a cron (Tenancy 2a, 4.5 and D10):
 * scheduling's reminders, the estimator's follow-ups, invoicing's overdue
 * sweep, the comms drain. One route walks them all.
 */

export interface CompanyRunOptions {
  /** Companies run at once. Default 4. */
  readonly concurrency?: number;
  /** Stop STARTING companies after this many ms; the rest are reported `deferred`. Default: no budget. */
  readonly timeBudgetMs?: number;
  /** Told about each company's failure (the run goes on). */
  readonly onError?: (error: unknown, tenantId: string) => void;
  readonly now?: () => Date;
}

export interface CompanyRunReport<T> {
  /** How many companies there were to run. */
  readonly companies: number;
  readonly ran: readonly { readonly tenantId: string; readonly result: T }[];
  /** The message only: never a stack, never a row. */
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
  /**
   * Not started because the time budget ran out. The next run starts at a
   * different company (see ROTATION), so the same ones aren't left out run
   * after run — but they aren't promised to go first, so a cron should log a
   * non-empty list where the platform owner will see it.
   */
  readonly deferred: readonly string[];
}

const DEFAULT_CONCURRENCY = 4;
const MINUTE_MS = 60_000;
const ERROR_CHARS = 300;
/**
 * Where a run that starts at `at` begins, among `n` companies: a hash of the
 * run's minute, mod n.
 *
 * WHY NOT `floor(now / 1h) mod n` (review SEC-2A-06 / TB-7). That was fair for
 * an HOURLY cron and broken for the daily one every project starts with: a
 * cron at 13:00 moves the hour index by 24 a day, so whenever the company
 * count divides 24 (2, 3, 4, 6, 8, 12, 24) every run began at the same
 * company and a time budget left out the same companies every day — and for
 * other counts it cycled through only a few starting points. ANY start that
 * moves by a fixed step per run has a company count it gets stuck on, and an
 * evenly spread sequence (multiples of the golden ratio) drifts by only a few
 * percent a day at a daily cadence, which is the same starvation spread over a
 * week.
 *
 * A hash of the run's minute is a fresh, evenly distributed start for every
 * run, whatever the schedule (daily, hourly, every 15 minutes) and however
 * many companies there are: no company is at the back two runs in a row more
 * often than chance. Deterministic, so a test (and a log) can say which.
 */
export function rotationStart(at: number, n: number): number {
  if (n <= 1) return 0;
  // murmur3's 32-bit finaliser: every input bit moves every output bit.
  let h = Math.floor(at / MINUTE_MS) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % n;
}

/**
 * Runs `work` for every active company.
 *
 * ISOLATION. Each company's `work` runs in its own try/catch: one company's
 * broken settings (or a provider timing out on its email) is that company's
 * entry in `failed` and an `onError` call, and the next company starts. One
 * bad row must never stop every other business's reminders.
 *
 * ROTATION. The ids are rotated to start at `rotationStart(now, n)` — a start
 * that moves every run, for any schedule and any number of companies — so
 * when a time budget cuts a run short, the companies that missed out aren't
 * the same ones every day (the last ids by sort order would otherwise never
 * get a turn on a busy day).
 *
 * `activeCompanyIds` failing (the database is down) rejects the whole run: a
 * cron that can't list companies has nothing to isolate, and saying "0 ran,
 * 0 failed" would read as a quiet success.
 */
export async function runForEachCompany<T>(
  tenancy: Pick<TenancyService, "activeCompanyIds">,
  work: (tenantId: string) => Promise<T>,
  options: CompanyRunOptions = {},
): Promise<CompanyRunReport<T>> {
  const ids = [...(await tenancy.activeCompanyIds())];
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const n = ids.length;
  const start = rotationStart(startedAt, n);
  const order = [...ids.slice(start), ...ids.slice(0, start)];

  const concurrency =
    typeof options.concurrency === "number" && Number.isFinite(options.concurrency) && options.concurrency >= 1
      ? Math.floor(options.concurrency)
      : DEFAULT_CONCURRENCY;
  const budget =
    typeof options.timeBudgetMs === "number" && Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs >= 0
      ? options.timeBudgetMs
      : null;

  const ran: { index: number; tenantId: string; result: T }[] = [];
  const failed: { index: number; tenantId: string; error: string }[] = [];
  let next = 0;
  const outOfTime = () => budget !== null && now().getTime() - startedAt >= budget;

  const worker = async (): Promise<void> => {
    while (next < order.length) {
      if (outOfTime()) return;
      const index = next++;
      const tenantId = order[index]!;
      try {
        ran.push({ index, tenantId, result: await work(tenantId) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ index, tenantId, error: message.slice(0, ERROR_CHARS) });
        try {
          options.onError?.(error, tenantId);
        } catch {
          /* a broken reporter must not stop the run it reports on */
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(order.length, 1)) }, () => worker()));

  // Reported in run order (not finish order), so a log reads the same twice.
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
  return {
    companies: n,
    ran: ran.sort(byIndex).map(({ tenantId, result }) => ({ tenantId, result })),
    failed: failed.sort(byIndex).map(({ tenantId, error }) => ({ tenantId, error })),
    deferred: order.slice(next),
  };
}
