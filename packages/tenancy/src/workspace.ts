/**
 * Personal workspaces.
 *
 * Every user gets a tenant of kind `personal` on first sign-in, so a solo user
 * and a 200-seat organisation are the same row shape behind the same queries.
 * The id is derived rather than generated: the workspace can be addressed
 * before it exists, which is what makes "create it lazily on first write"
 * possible without a read-modify-write race between two concurrent requests.
 */

const WORKSPACE_ID_PREFIX = "ws_";
const WORKSPACE_SLUG_PREFIX = "ws-";

/**
 * How much of the (sanitised) user id survives into the slug.
 *
 * Slugs end up in URLs and in emails that wrap; a Clerk id plus prefix already
 * runs past 30 characters. Truncation is safe only because the fingerprint
 * below is computed from the FULL id.
 */
const SLUG_BODY_MAX = 40;

/** Deterministic id for a user's personal workspace. */
export class EmptyUserIdError extends Error {
  readonly name = "EmptyUserIdError";
  constructor(fn: string) {
    super(
      `${fn} was given an empty user id. It would mint the workspace "ws_", ` +
        `which isPersonalWorkspaceId() classifies as an ordinary org tenant — ` +
        `so the row would exist forever and no later check would recognise it.`,
    );
  }
}

export function personalWorkspaceId(userId: string): string {
  if (userId.length === 0) throw new EmptyUserIdError("personalWorkspaceId");
  return WORKSPACE_ID_PREFIX + userId;
}

/**
 * Is this a personal workspace id?
 *
 * Requires something after the prefix: `"ws_"` on its own is a malformed id,
 * and answering `true` for it would hand the caller a workspace belonging to
 * the empty user.
 */
export function isPersonalWorkspaceId(id: string): boolean {
  return id.startsWith(WORKSPACE_ID_PREFIX) && id.length > WORKSPACE_ID_PREFIX.length;
}

/**
 * Deterministic, URL-safe slug for a user's personal workspace.
 *
 * The trailing fingerprint is not decoration. Sanitising lowercases and folds
 * every character outside [a-z0-9-] to a dash, so `user_2aB` and `user-2ab`
 * both reduce to `user-2ab`; identity providers issue mixed-case ids, and
 * truncation collapses long ids further. Without the fingerprint the second
 * such user's sign-in would die on the `tenants_slug_idx` unique violation,
 * during onboarding, with nothing in the error naming the real cause.
 *
 * The fingerprint is FNV-1a, not a cryptographic hash: a slug is public and
 * guessable by construction, so there is nothing here to protect. It only has
 * to separate ids that sanitise to the same body.
 */
export function personalWorkspaceSlug(userId: string): string {
  if (userId.length === 0) throw new EmptyUserIdError("personalWorkspaceSlug");
  const body = sanitiseSlugBody(userId)
    .slice(0, SLUG_BODY_MAX)
    // Re-strip AFTER truncating. Slicing can land mid-run and reintroduce the
    // trailing dash the fold already removed, and the fingerprint suffix is
    // appended with its own dash — producing "--" in a public URL.
    .replace(/-+$/, "");
  const suffix = fingerprint(userId);
  return body.length > 0
    ? `${WORKSPACE_SLUG_PREFIX}${body}-${suffix}`
    : // An id made entirely of punctuation sanitises to nothing; the
      // fingerprint alone still yields a valid, unique slug rather than a
      // trailing-dash string that looks truncated.
      `${WORKSPACE_SLUG_PREFIX}${suffix}`;
}

function sanitiseSlugBody(userId: string): string {
  return (
    userId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      // Leading and trailing dashes read as truncation and break nothing but
      // the eye; strip them after folding, never before.
      .replace(/^-+|-+$/g, "")
  );
}

/** FNV-1a (32-bit), base36. Pure, dependency-free, identical in any runtime. */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Math.imul, because `hash * 0x01000193` overflows the float53 mantissa and
    // silently stops being FNV — the values would still look random and would
    // differ between engines.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
