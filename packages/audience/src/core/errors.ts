/**
 * The errors an admin action can end in, each with the HTTP status a route
 * or server action would answer with. `message` is a sentence for the admin
 * form — the panel shows it as-is.
 */
export type AudienceErrorCode =
  | "invalid_rule"
  | "duplicate_rule"
  | "not_found"
  | "not_configured"
  | "invalid_token"
  | "unlicensed";

const STATUS: Readonly<Record<AudienceErrorCode, number>> = {
  invalid_rule: 400,
  duplicate_rule: 409,
  not_found: 404,
  not_configured: 501,
  invalid_token: 400,
  unlicensed: 402,
};

export class AudienceError extends Error {
  readonly name = "AudienceError";
  readonly code: AudienceErrorCode;
  readonly status: number;
  constructor(code: AudienceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isAudienceError(error: unknown): error is AudienceError {
  return error instanceof AudienceError;
}
