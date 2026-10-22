/**
 * @adminigloo/digest/ui — the screens (digest 0.1). A client entry ("use
 * client" is stamped on the bundle by tsup). React is its only peer; the
 * preferences screen talks to the app only through the endpoint it is given.
 *
 *   <EmailPreferences initial={…} />     the person's preferences page
 *   <SignUpEmailChoice digests={…} />    the unticked opt-in beside sign-up
 */
export { EmailPreferences, type EmailPreferencesProps } from "./ui/EmailPreferences.js";
export { SignUpEmailChoice, type SignUpEmailChoiceProps } from "./ui/SignUpEmailChoice.js";
export { digestCss } from "./ui/styles.js";
export type { PreferencesResponse } from "./handlers.js";
