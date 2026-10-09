import { defineSite, definePaths } from "../index.js";

/**
 * Riddler Go's REAL path lists, copied from `lib/seo/marketing-paths.ts`:
 * `MARKETING_PATHS` (with dates added where the sitemap tests need them) and
 * `NOINDEX_PREFIXES` exactly as written there, "/x/" and "/x" pairs
 * included. The one deliberate change is the package's rule for sign-in and
 * sign-up: noindex (crawlable, so the noindex is seen), where Riddler Go
 * disallows them today.
 *
 * Its public event pages live at `/{orgSlug}/{eventSlug}` and are in no list,
 * which is exactly what robots.txt must not over-block.
 */
export const MARKETING_PATHS = [
  { path: "/", changeFrequency: "weekly", priority: 1.0, lastModified: "2026-10-01" },
  { path: "/how-it-works", changeFrequency: "weekly", priority: 0.8, lastModified: null },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.9, lastModified: new Date("2026-09-20T12:00:00Z") },
  { path: "/templates", changeFrequency: "weekly", priority: 0.9 },
  { path: "/join", changeFrequency: "monthly", priority: 0.7 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
] as const;

export const NOINDEX_PREFIXES = [
  "/admin/",
  "/admin",
  "/dashboard/",
  "/dashboard",
  "/events/",
  "/events",
  "/staff/",
  "/staff",
  "/setup/",
  "/setup",
  "/play/",
  "/play",
  "/e/",
  "/e",
  "/api/",
  "/api",
  "/sso-callback",
  "/qr/",
  "/qr",
  "/invite/",
  "/invite",
  "/dev/",
  "/dev",
  "/sign-in",
  "/sign-up",
  "/settings/",
  "/settings",
  "/event-builder/",
  "/event-builder",
  "/shared/",
  "/shared",
] as const;

const SIGN_IN = ["/sign-in", "/sign-up"];

export const paths = definePaths({
  public: MARKETING_PATHS,
  private: NOINDEX_PREFIXES.filter((path) => !SIGN_IN.includes(path)),
  noindex: SIGN_IN,
});

export const SITE_INPUT = {
  url: "https://riddlergo.com",
  name: "Riddler Go",
  indexable: true,
  description: "Host puzzle events for any occasion. Guests join with a QR code and race the leaderboard on their phones.",
  image: { url: "/opengraph-image", width: 1200, height: 630, alt: "Riddler Go: puzzle events" },
  twitter: { site: "riddlergo" },
  paths,
} as const;

export const site = defineSite(SITE_INPUT);

/** The same site on staging: every answer must say "do not index". */
export const staging = defineSite({ ...SITE_INPUT, url: "https://staging.riddlergo.com", indexable: false });
