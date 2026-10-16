/**
 * The comms template the host sends alert email copies with (Tenancy 2b-1,
 * 4.9; D5). Insert it per company if absent (never over an owner's edit): it
 * then shows in the company's Messages as "Team alert", where the owner can
 * change its words or switch it off.
 *
 * The host supplies:
 *   - `title`: the alert's title (one line, links broken);
 *   - `body`: the alert's body, empty for none;
 *   - `linkLine`: "Open it: {absolute link}", or empty;
 *   - `settingsLine`: "Change which alerts you get by email: {absolute link to
 *     Alert settings}"; for an email-only address the owner added (it has no
 *     sign-in), "You get this because {businessName} added this address.";
 *   - `businessName`: the company's name.
 *
 * Each line that is only a variable folds away when empty (comms' HTML rule),
 * so an alert with no body and nothing to open is two short lines, not a
 * page of blank paragraphs.
 *
 * `renderAlertEmail` (./render.ts) renders these exact words for a host
 * without comms.
 */
export const TEAM_ALERT_EMAIL_TEMPLATE: { readonly key: "team_alert"; readonly subject: string; readonly body: string } = Object.freeze({
  key: "team_alert",
  subject: "{{title}}",
  body: "{{body}}\n\n{{linkLine}}\n\n{{settingsLine}}",
});

/** "Open it: {link}" (4.9). */
export function alertLinkLine(link: string | null | undefined): string {
  return link ? `Open it: ${link}` : "";
}

/** The settings line (4.9; review BO-17): the email-only address's own sentence, or the link to Alert settings. */
export function alertSettingsLine(input: {
  readonly addressOnly: boolean;
  readonly businessName: string;
  readonly settingsLink: string | null | undefined;
}): string {
  if (input.addressOnly) return `You get this because ${input.businessName} added this address.`;
  return input.settingsLink ? `Change which alerts you get by email: ${input.settingsLink}` : "";
}
