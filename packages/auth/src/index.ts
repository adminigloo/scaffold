export type { Principal } from "./principal.js";
export { isImpersonating } from "./principal.js";

export { authServer, authClient, AUTH_MODE_BOUND_KEYS } from "./env.js";

export {
  verifyIdentityWebhook,
  shouldApplyEvent,
  WebhookVerificationError,
} from "./webhook.js";
export type { IdentityEvent, IdentityEventType } from "./webhook.js";
