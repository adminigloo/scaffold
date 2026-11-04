/**
 * @adminigloo/social — social posts for each company (social 0.2).
 *
 * The app BUILDS posts into a queue, a person APPROVES them, and a person
 * (or an agent in their browser) POSTS them by hand. Code writes every fact;
 * the AI (the app's own metered call, the cheapest model) writes only the
 * words around them, every number checked against the facts. Nothing in
 * this package posts anything or calls any platform.
 *
 * The root is pure (no database, no React, safe in a browser): each
 * platform's format, the number guard, the writer, the generic honesty
 * list, the generic sources, the view, the route table and the permission
 * keys. The table is "@adminigloo/social/schema", the queue and the handler
 * "@adminigloo/social/server", the screens "@adminigloo/social/ui", the
 * cards "@adminigloo/social/cards" (their fonts "@adminigloo/social/fonts"),
 * and the metered Claude call "@adminigloo/social/anthropic".
 */
export * from "./types.js";
export {
  ASIDE_MAX,
  ASPECT_SIZE,
  composeUrl,
  cutToFit,
  fits,
  HOOK_MAX,
  measure,
  PLATFORMS,
  redditParts,
  SHORT_ASIDE_MAX,
  textLength,
  X_LINK_LENGTH,
  type ImageAspect,
  type Measure,
  type PlatformRule,
} from "./platforms.js";
export { allowedNumbers, inventedNumbers, numbersIn } from "./guard.js";
export {
  ASIDE_CANDIDATES,
  asideTokens,
  candidatesRequest,
  composeText,
  firstCommentFor,
  fixedAside,
  HOOK_ONLY_TOKENS,
  linkLine,
  pickAsides,
  writePost,
  type AsideCandidate,
  type AsidePick,
  type Around,
  type Complete,
  type CompleteRequest,
  type HonestyCheck,
  type WriterOptions,
  type WrittenPost,
} from "./writer.js";
// social 0.2, from Almanac: tagged links, the AI-smell check, posts that go stale, the queue in sections, one view a post.
export { linkTagsOf, postLinkTags, SOCIAL_MEDIUM, taggedLink, type LinkTags } from "./links.js";
export {
  APPROVED_NAMES,
  CAPPED,
  CAPS_WORD,
  CONTRACTION,
  inventedNames,
  LIVE_ONLY,
  REJECT,
  REJECT_WHY,
  smell,
  smells,
  STAGE_DIRECTION,
  VOCATIVES,
  type RejectName,
  type SmellOptions,
  type SpeakerStyle,
} from "./smell.js";
export { asOf, effectiveStatus, isOpen, OPEN_STATUSES, type Aging } from "./expiry.js";
export { queueSectionsOf, type QueueSections, type SectionOptions } from "./sections.js";
export { combineHonesty, genericHonesty, GENERIC_HONESTY_RULES, honestyFrom, type HonestyRule } from "./honesty.js";
export { firstSentence, hookOf, LAUNCH_FACTS_MAX, launchSource, MAX_HASHTAGS, parseHashtags, releaseSource, type ReleaseFacts, type SourceTarget } from "./sources.js";
export { dayText, groupPosts, postAnchor, postView, type ImageSet, type PostGroupView, type QueuePostView } from "./view.js";
export { SOCIAL_ADMIN_ROUTES, SOCIAL_ADMIN_ROUTE_PERMISSIONS, type SocialAdminRouteKind, type SocialRoute } from "./routes.js";
export { SOCIAL_PERMISSION_KEYS, socialPermissions, type SocialPermission, type SocialPermissionDefinition } from "./permissions.js";
export type * from "./wire.js";
