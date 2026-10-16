/**
 * How often the public may write to feedback forms (0.10.0), as one decision
 * for the intake's `rateLimit` seam, counted by whatever counter the host
 * already has (create-app: its Upstash-or-memory limiter).
 *
 * A company's own feedback page needs no key, so anyone can post to any
 * company's board. Four counts hold that open door to a size a business can
 * live with:
 *
 *   per board, per caller     one visitor on one form (10 reports an hour)
 *   per caller, every board   one visitor across all the companies here, so
 *                             a script can't send ten an hour to each of a
 *                             thousand companies (30 an hour)
 *   per board, a day, keyless what a company's feedback PAGE takes in a day
 *                             from everyone together (200 reports), so a
 *                             flood can't bury a company's board
 *   no address                a request with no address the proxy saw is
 *                             counted under one shared "unknown" caller,
 *                             never let through uncounted
 *
 * Reading (the form's settings, a ticket's conversation) isn't counted.
 */

export interface FeedbackLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const FEEDBACK_INTAKE_LIMITS = Object.freeze({
  perBoard: Object.freeze({
    submit: { limit: 10, windowMs: HOUR },
    upload: { limit: 30, windowMs: HOUR },
    reply: { limit: 60, windowMs: HOUR },
  }),
  perCaller: Object.freeze({
    submit: { limit: 30, windowMs: HOUR },
    upload: { limit: 90, windowMs: HOUR },
    reply: { limit: 180, windowMs: HOUR },
  }),
  keylessPerBoardDaily: Object.freeze({
    submit: { limit: 200, windowMs: DAY },
    upload: { limit: 600, windowMs: DAY },
    reply: { limit: 1000, windowMs: DAY },
  }),
});

export type FeedbackIntakeLimits = typeof FEEDBACK_INTAKE_LIMITS;

/** The caller a request with no forwarded address is counted as. */
export const UNKNOWN_CALLER = "unknown";

/** The plain sentences a refused visitor reads. */
export const TOO_MANY_MESSAGE = "Too many reports at once. Please wait a while and try again.";
export const BUSY_TODAY_MESSAGE = "This feedback form has had a lot of reports today. Please try again tomorrow, or contact the business directly.";

/**
 * The intake's `rateLimit`, over a counter that answers "is this one more
 * allowed?" for a key and a policy. Every count is checked; the first full
 * one decides.
 */
export function createFeedbackRateLimit(
  allow: (key: string, policy: FeedbackLimitPolicy) => boolean | Promise<boolean>,
  limits: FeedbackIntakeLimits = FEEDBACK_INTAKE_LIMITS,
): (info: {
  readonly action: "submit" | "upload" | "reply";
  readonly tenantId: string;
  readonly keyId: string | null;
  readonly ip: string | null;
}) => Promise<{ readonly ok: boolean; readonly retryAfterSeconds?: number; readonly message?: string }> {
  return async (info) => {
    const caller = info.ip && info.ip.trim() !== "" ? info.ip.trim().slice(0, 100) : UNKNOWN_CALLER;
    const checks: Array<{ key: string; policy: FeedbackLimitPolicy; message: string }> = [
      { key: `feedback:board:${info.tenantId}:${info.action}:${caller}`, policy: limits.perBoard[info.action], message: TOO_MANY_MESSAGE },
      { key: `feedback:caller:${info.action}:${caller}`, policy: limits.perCaller[info.action], message: TOO_MANY_MESSAGE },
      // Only the keyless page: a company's own website (keyed) and the site's
      // own button aren't held to the page's daily total.
      ...(info.keyId === null
        ? [{ key: `feedback:page-day:${info.tenantId}:${info.action}`, policy: limits.keylessPerBoardDaily[info.action], message: BUSY_TODAY_MESSAGE }]
        : []),
    ];
    for (const check of checks) {
      if (!(await allow(check.key, check.policy))) {
        return { ok: false, retryAfterSeconds: Math.ceil(check.policy.windowMs / 1000), message: check.message };
      }
    }
    return { ok: true };
  };
}

/** A counter in memory, for tests and a single process: the same answers the shared limiter gives. */
export function createMemoryCounter(now: () => number = Date.now): (key: string, policy: FeedbackLimitPolicy) => boolean {
  const hits = new Map<string, number[]>();
  return (key, policy) => {
    const at = now();
    const recent = (hits.get(key) ?? []).filter((t) => at - t < policy.windowMs);
    if (recent.length >= policy.limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(at);
    hits.set(key, recent);
    return true;
  };
}
