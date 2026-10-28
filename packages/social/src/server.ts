/**
 * @adminigloo/social/server — the queue's rules (social 0.1): the store
 * (every call inside one company), the HTTP handler the posts screen talks
 * to, and forgetting a company. Server-only: it reaches the database.
 */
export { isWebAddress, LIST_MAX, MissingTenantError, postStore, type DraftInput, type ListFilter, type PostStore, type PostStoreOptions, type QueuedPost, type QueueSections, type SocialDb } from "./store.js";
export { createSocialAdminHandlers, dayIn, isCrossSiteRequest, type ComposeRequest, type CreateSocialAdminHandlersOptions, type SocialAuthorizeResult } from "./handlers.js";
export type * from "./wire.js";

// Delete a company (create-app's "delete a company"): every post of one company.
export { forgetTenant } from "./forget.js";
