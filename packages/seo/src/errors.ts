/**
 * One error type for the whole package. `invalid_config` is a site or path
 * list that can never produce a correct answer (a relative site URL, a
 * private `/_next/`); `invalid_input` is one call's data (a Product with no
 * offer, a rating of 7 out of 5). Every issue found in a call is listed, not
 * just the first, so one test run shows everything to fix.
 */
export type SeoErrorCode = "invalid_config" | "invalid_input";

export class SeoError extends Error {
  readonly code: SeoErrorCode;
  /** Where it was raised, e.g. `product` or `definePaths`. */
  readonly where: string;
  readonly issues: readonly string[];

  constructor(code: SeoErrorCode, where: string, issues: readonly string[]) {
    super(`@adminigloo/seo ${where}: ${issues.join("; ")}`);
    this.name = "SeoError";
    this.code = code;
    this.where = where;
    this.issues = issues;
  }
}

/** Collects issues for one call and throws them together. */
export class Issues {
  readonly list: string[] = [];

  constructor(
    private readonly where: string,
    private readonly code: SeoErrorCode = "invalid_input",
  ) {}

  add(message: string): void {
    this.list.push(message);
  }

  check(ok: boolean, message: string): void {
    if (!ok) this.list.push(message);
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new SeoError(this.code, this.where, this.list);
  }
}
