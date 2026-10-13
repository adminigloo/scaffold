import { companyNameProblemMessage, slugProblemMessage, type CompanyNameProblem, type SlugProblem } from "../slug.js";
import type { TenancyErrorCode } from "../wire.js";

export type { TenancyErrorCode };

export interface TenancyErrorDetails {
  readonly issues?: readonly { readonly path: (string | number)[]; readonly message: string }[];
  readonly suggestion?: string;
  readonly upgradeHref?: string;
}

/** The HTTP status each code answers with (contract 6.1). */
export const TENANCY_ERROR_STATUS: Readonly<Record<TenancyErrorCode, number>> = {
  invalid: 400,
  signed_out: 401,
  forbidden: 403,
  not_a_member: 403,
  company_suspended: 403,
  not_staff: 403,
  cross_site: 403,
  not_found: 404,
  unavailable: 404,
  name_invalid: 422,
  slug_invalid: 422,
  slug_reserved: 422,
  slug_taken: 409,
  rank: 403,
  owner_protected: 409,
  owner_must_transfer: 409,
  self: 409,
  last_owner: 409,
  last_admin: 409,
  already_member: 409,
  personal_workspace: 409,
  seats_full: 409,
  confirmation_mismatch: 422,
  logo_storage_off: 409,
  logo_invalid: 422,
  rate_limited: 429,
  internal: 500,
};

/**
 * Every refusal the company lifecycle makes, as a code (for the program) and a
 * complete sentence (for a business owner). None names a permission key, an
 * internal id, or an email the caller didn't supply.
 */
export class TenancyError extends Error {
  readonly name = "TenancyError";
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
    readonly details?: TenancyErrorDetails,
  ) {
    super(message);
  }

  get status(): number {
    return TENANCY_ERROR_STATUS[this.code];
  }
}

export interface Noun {
  readonly singular: string;
  readonly plural: string;
}

/** The default sentence for each code, with the project's noun ("company", "shop"). */
export function defaultMessage(code: TenancyErrorCode, noun: Noun): string {
  const n = noun.singular;
  switch (code) {
    case "invalid":
      return "Check the highlighted fields.";
    case "signed_out":
      return "You've been signed out. Sign in again to keep working.";
    case "forbidden":
      return `You don't have access to do that here. Ask the owner of this ${n} to change your role.`;
    case "not_a_member":
      return `You're not part of this ${n}.`;
    case "company_suspended":
      return `This ${n} is suspended. Contact support to restore it.`;
    case "not_staff":
      return "That needs a staff role.";
    case "cross_site":
      return "That request came from another site and was refused.";
    case "not_found":
      return "That isn't here any more.";
    case "unavailable":
      return "That isn't available on this site.";
    case "name_invalid":
      return companyNameProblemMessage("invalid", n);
    case "slug_invalid":
      return slugProblemMessage("invalid", n);
    case "slug_reserved":
      return slugProblemMessage("reserved", n);
    case "slug_taken":
      return slugProblemMessage("taken", n);
    case "rank":
      return "You can only change people whose role is below yours, and only to a role below yours.";
    case "owner_protected":
      return "That's the owner. Ownership has to be handed to someone else first.";
    case "owner_must_transfer":
      return "Owner isn't a role you can give. Use Transfer ownership instead.";
    case "self":
      return "You can't change your own role. Ask someone above you.";
    case "last_owner":
      return `You own this ${n}. Hand ownership to someone else before you leave.`;
    case "last_admin":
      return "That's the only administrator. Make someone else an administrator first.";
    case "already_member":
      return "That person is already on your team.";
    case "personal_workspace":
      return `A personal workspace can't have a team. Create a ${n} to invite people.`;
    case "seats_full":
      return "Your plan is full. Remove someone or upgrade to add more.";
    case "confirmation_mismatch":
      return `Type the ${n}'s name exactly as it's shown to confirm.`;
    case "logo_storage_off":
      return "Logo uploads aren't switched on for this site yet.";
    case "logo_invalid":
      return "Use a PNG, JPG or WebP image under 1 MB.";
    case "rate_limited":
      return "That's a lot of requests. Wait a minute and try again.";
    case "internal":
      return "Something went wrong on our side. Try again in a moment.";
  }
}

/** A refusal factory bound to the project's noun. */
export function failWith(noun: Noun) {
  return (code: TenancyErrorCode, details?: TenancyErrorDetails, message?: string): TenancyError =>
    new TenancyError(code, message ?? defaultMessage(code, noun), details);
}

export function nameError(problem: CompanyNameProblem, noun: Noun): TenancyError {
  return new TenancyError("name_invalid", companyNameProblemMessage(problem, noun.singular), {
    issues: [{ path: ["name"], message: companyNameProblemMessage(problem, noun.singular) }],
  });
}

export function slugError(problem: SlugProblem | "taken", noun: Noun, suggestion: string): TenancyError {
  const code = problem === "taken" ? "slug_taken" : problem === "reserved" ? "slug_reserved" : "slug_invalid";
  const message = slugProblemMessage(problem, noun.singular);
  return new TenancyError(code, message, { issues: [{ path: ["slug"], message }], suggestion });
}

/** Postgres unique_violation (23505), however the driver or Drizzle wrapped it. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1) {
    if (typeof e === "object" && (e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
