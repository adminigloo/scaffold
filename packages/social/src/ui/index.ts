/**
 * @adminigloo/social/ui — the posts screens (social 0.1). A client entry
 * ("use client" is stamped on the bundle by tsup). React is its only peer;
 * the screens talk to the app only through the base URL each is given, or
 * through the actions the app passes.
 *
 *   <PostsAdmin baseUrl="/api/app/{company id}/posts" canManage />   the whole screen
 *   <PostQueue posts actions filter approveAllLabel />              the queue alone
 *   <ComposeForm onCompose />                                       a post from your own facts
 *   <CardFormats sets />                                            every card format
 */
export { PostsAdmin, type PostsAdminProps } from "./PostsAdmin.js";
export { PostQueue, type PostQueueProps } from "./PostQueue.js";
export { PostCard, attempt, messageOf, type ActionResult, type QueueActions } from "./PostCard.js";
export { ComposeForm, type ComposeInput } from "./ComposeForm.js";
export { CardFormats } from "./CardFormats.js";
export { createSocialClient, type SocialClient } from "./client.js";
export { SocialStyles, socialCss } from "./styles.js";
export type { QueuePostView } from "../view.js";
export type * from "../wire.js";
