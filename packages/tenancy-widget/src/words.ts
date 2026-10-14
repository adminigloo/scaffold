import type { AcceptWire, TenancyErrorCode } from "./types.js";

/**
 * Every sentence a person reads in this widget, in one module (contract 8.9).
 *
 * WHY ONE MODULE. The founder's rule is that an owner reads plain words: no
 * ids, no "slug", no "tenant", no error codes, no stack. Kept here, the words
 * can be read top to bottom by someone who isn't a developer, and a test can
 * hold every one of them to that rule (src/__tests__/words.test.ts). The
 * components only choose WHICH sentence; they never compose new ones.
 *
 * NOUNS. A project calls its tenants whatever it chose at create-app time
 * ("company", "shop", "practice"). Every sentence that names one takes the
 * noun: lowercase inside a sentence, `nounTitle()` at the start of a heading
 * or a button.
 */

export interface Noun {
  readonly singular: string;
  readonly plural: string;
}

export const DEFAULT_NOUN: Noun = { singular: "company", plural: "companies" };

/** "company" → "Company". The one place a noun is capitalised. */
export function nounTitle(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** The noun a component was given, or the default, lowercased for use inside sentences. */
export function nounOf(noun?: Partial<Noun> | null): Noun {
  const singular = (noun?.singular ?? "").trim().toLowerCase() || DEFAULT_NOUN.singular;
  const plural = (noun?.plural ?? "").trim().toLowerCase() || (noun?.singular ? `${singular}s` : DEFAULT_NOUN.plural);
  return { singular, plural };
}

/** "a company" / "an office": the article English wants before the noun. */
export function aNoun(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

// ---------------------------------------------------------------------------
// Errors (8.9): the server's sentence first; these only when it sent none
// ---------------------------------------------------------------------------

export const NETWORK_MESSAGE = "We couldn't reach the server. Check your connection and try again.";
export const BAD_RESPONSE_MESSAGE = "Something went wrong on our side. Try again in a moment.";
/** scheduling-widget's sentence, word for word. */
export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to keep working.";
/** What a component says when it was given neither a transport nor a baseUrl. */
export const NOT_CONNECTED_MESSAGE = "This page isn't connected to its server yet.";

/**
 * The server's default sentences (contract 6.1), for a host transport (tRPC,
 * a server action) that answers with a code and no message. The HTTP
 * handlers always send their own; these never override one.
 */
export function codeFallback(code: TenancyErrorCode | "network" | "bad_response", noun: Noun = DEFAULT_NOUN): string {
  const n = noun.singular;
  switch (code) {
    case "network":
      return NETWORK_MESSAGE;
    case "bad_response":
    case "internal":
      return BAD_RESPONSE_MESSAGE;
    case "signed_out":
      return SIGNED_OUT_MESSAGE;
    case "invalid":
      return "Check the highlighted fields.";
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
      return `Give your ${n} a name of at least 2 characters.`;
    case "slug_invalid":
      return "Use lowercase letters, numbers and single dashes, like summit-window-co.";
    case "slug_reserved":
      return "That web address is kept for the site itself. Try another, like acme-plumbing.";
    case "slug_taken":
      return `That web address is already used by another ${n}.`;
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
      return `A personal workspace can't have a team. Create ${aNoun(n)} to invite people.`;
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
    default:
      return BAD_RESPONSE_MESSAGE;
  }
}

/** What to show for a failed call: the server's sentence, else ours. Never a code. */
export function errorText(error: { code: TenancyErrorCode | "network" | "bad_response"; message: string }, noun: Noun = DEFAULT_NOUN): string {
  return error.message.trim() || codeFallback(error.code, noun);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const W = {
  loading: "Loading…",
  checking: "Checking…",
  available: "Available",
  saving: "Saving…",
  saved: "Saved",
  unsaved: "Unsaved changes",
  save: "Save",
  cancel: "Cancel",
  close: "Close",
  dismiss: "Dismiss",
  copyLink: "Copy link",
  copied: "Copied",
  copiedSr: "Copied.",
  copyFailed: "Couldn't copy. The link is selected; copy it by hand.",
  tryAgain: "Try again",
  previous: "Previous",
  next: "Next",
  you: "(you)",
  owner: "Owner",
  active: "Active",
  suspended: "Suspended",
  accountClosed: "Account closed",
  // Review R2 T1BO-10: "Sensitive" in yellow read as an alarm on a routine
  // join. What the flag means is that someone's access changed.
  sensitive: "Access change",
  noRole: "No role",
} as const;

/** "Showing 1–25 of 230" (8.10). */
export function showingRange(from: number, to: number, total: number): string {
  return total === 0 ? "Showing 0 of 0" : `Showing ${from}–${to} of ${total}`;
}

// ---------------------------------------------------------------------------
// Onboarding (8.3)
// ---------------------------------------------------------------------------

export const ONBOARDING = {
  heading: (noun: Noun) => `What's your ${noun.singular} called?`,
  headingAdditional: (noun: Noun) => `Create another ${noun.singular}`,
  nameLabel: (noun: Noun) => `${nounTitle(noun.singular)} name`,
  addressLabel: "Web address",
  addressHint: "Your page's address on this site, where customers will find you. You can change it later.",
  formerCompany: (name: string, noun: Noun) =>
    `You're no longer part of ${name}. If that's a mistake, ask its owner to invite you again. Or set up your own ${noun.singular} below.`,
  staffNote: (noun: Noun) =>
    `You run this site, so you don't need ${aNoun(noun.singular)} of your own. Everything you manage is in the admin console.`,
  staffConsole: "Go to the admin console",
  alreadyMade: (name: string, noun: Noun) =>
    `Your ${noun.singular} was already set up as "${name}". You can change its name in ${noun.singular} settings.`,
  // Review R2 T1BO-01: the answer was lost, but the company was made.
  wasCreated: (name: string) => `${name} was created. The answer just didn't reach this page, so there's nothing to do again.`,
  continueTo: (name: string) => `Continue to ${name}`,
  change: "Change",
  use: (suggestion: string) => `Use ${suggestion}`,
  create: (noun: Noun) => `Create ${noun.singular}`,
  creating: (noun: Noun) => `Creating your ${noun.singular}…`,
  invitedYou: (companyName: string, roleName: string) => `${companyName} invited you to join as ${aNoun(roleName)}.`,
  invitedBy: (who: string) => `Sent by ${who}.`,
  join: (companyName: string) => `Join ${companyName}`,
  joining: "Joining…",
  orCreate: (noun: Noun) => `Or create your own ${noun.singular}`,
  personalMode: (noun: Noun) => `This site doesn't use ${noun.plural}.`,
  invitationsHeading: "You've been invited",
} as const;

// ---------------------------------------------------------------------------
// Invitations: the outcome of joining (8.8, shared with onboarding's cards)
// ---------------------------------------------------------------------------

export function acceptOutcomeText(outcome: Pick<AcceptWire, "status" | "company" | "message">, noun: Noun): string {
  const name = outcome.company?.name ?? `the ${noun.singular}`;
  switch (outcome.status) {
    case "accepted":
      return `You're in ${name}.`;
    case "already-a-member":
      return `You were already in ${name}.`;
    case "expired":
      return "This invitation has expired. Ask whoever invited you to send a new one.";
    case "revoked":
      return "This invitation was withdrawn.";
    case "wrong-email":
      return "This invitation is for a different email address. Sign out and sign in with the address it was sent to.";
    case "unknown":
      // Review R2 T1BO-02: never only "it may have been used" (usually it
      // wasn't); always the next step.
      return "This link isn't working. It may have been used already or replaced by a newer invitation. Ask whoever invited you to send it again.";
    case "company-unavailable":
      return `This ${noun.singular} isn't available right now.`;
    case "seats-full":
      return outcome.message?.trim() || "There's no room left on this team. Ask whoever invited you to make space.";
    default:
      return BAD_RESPONSE_MESSAGE;
  }
}

export const ACCEPT = {
  heading: "You've been invited",
  accept: "Accept invitation",
  accepting: "Accepting…",
  signedInAs: (email: string) => `You're signed in as ${email}.`,
  goTo: (name: string) => `Go to ${name}`,
  invitedAs: (company: string, role: string) => `${company} invited you to join as ${aNoun(role)}.`,
  invitedTo: (company: string) => `${company} invited you to join.`,
  signOut: "Sign out",
  // Review R2 T1BO-07: the wrong address, said BEFORE Accept, with both ways out.
  sentTo: (masked: string) => `This invitation was sent to ${masked}.`,
  youAre: (email: string) => `You're signed in as ${email}, so it can't be accepted here.`,
  signOutToUse: "Sign out and use that address",
  askInstead: (inviter: string | null, email: string) =>
    `${inviter ? `Ask ${inviter}` : "Or ask whoever invited you"} to invite ${email} instead.`,
} as const;

// ---------------------------------------------------------------------------
// The switcher (8.4)
// ---------------------------------------------------------------------------

export const SWITCHER = {
  buttonName: (name: string, noun: Noun) => `${name}, switch ${noun.singular}`,
  menuLabel: (noun: Noun) => `Your ${noun.plural}`,
  createAnother: (noun: Noun) => `Create another ${noun.singular}`,
  settings: (noun: Noun) => `${nounTitle(noun.singular)} settings`,
  team: "Team",
  setUp: (noun: Noun) => `Set up your ${noun.singular}`,
  suspendedSuffix: "Suspended",
  switching: (name: string) => `Switching to ${name}…`,
} as const;

// ---------------------------------------------------------------------------
// The setup checklist (8.5)
// ---------------------------------------------------------------------------

export const CHECKLIST = {
  title: "Finish setting up",
  progress: (done: number, total: number) => `${done} of ${total} done`,
  notNeeded: "Not needed",
  skipped: "Skipped",
  done: "Done",
  allSet: "You're all set.",
  hide: "Hide this list",
  show: "Show the setup list",
  undo: "Undo",
  more: "More",
  dismissed: (title: string) => `"${title}" is marked as not needed. Press Undo to bring it back.`,
  restored: (title: string) => `"${title}" is back on the list.`,
} as const;

// ---------------------------------------------------------------------------
// The team page (8.6)
// ---------------------------------------------------------------------------

export const TEAM = {
  inviteHeading: "Invite someone",
  email: "Email address",
  emailInvalid: "Enter an email address, like sam@example.com.",
  role: "Role",
  send: "Send invitation",
  sending: "Sending…",
  sent: (email: string) => `Invitation sent to ${email}.`,
  notEmailed: (email: string) => `We couldn't email ${email}, so copy this link and send it to them yourself.`,
  replaced: (email: string) =>
    `A new email went to ${email}. The earlier links to this invitation still work too.`,
  // Not emailed this time (no mailer, or it failed): only the earlier links' half is true —
  // and it says LINKS, not emails: with no mailer there never were any (review R4 SEC-T1-B).
  earlierLinksWork: "The earlier links to this invitation still work too.",
  // Saved, but the per-address email limits held the email (review R3 SEC-T1-B); the server's sentence says why.
  held: (email: string) => `Saved. We didn't email ${email} this time.`,
  // Review R3 T1BO-07: shown beside the invitation, to whoever may invite.
  wrongAccount: (who: string | null, when: string) =>
    `Someone tried to accept this while signed in as ${who ?? "a different account"} (${when}). ` +
    "Ask them to sign in with the address it was sent to, or withdraw it and invite the address they use.",
  linkLabel: "Invitation link",
  upgrade: "Upgrade",
  seats: (usedAndPending: number, limit: number) => `${usedAndPending} of ${limit} places used (including invitations).`,
  membersHeading: "Members",
  colName: "Name",
  colRole: "Role",
  colStatus: "Status",
  colJoined: "Joined",
  colActions: "Actions",
  roleFor: (name: string) => `Role for ${name}`,
  roleChanged: (name: string, role: string) => `Role changed. ${name} is now ${aNoun(role)}.`,
  remove: "Remove",
  removeFor: (name: string) => `Remove ${name}`,
  removeTitle: (name: string, company: string) => `Remove ${name} from ${company}?`,
  removeBody: "They lose access straight away. Anything they made stays.",
  removed: (name: string) => `${name} was removed.`,
  pendingHeading: "Pending invitations",
  expires: (date: string) => `Expires ${date}`,
  expired: "Expired",
  resend: "Resend",
  resendFor: (email: string) => `Resend the invitation to ${email}`,
  // One word for one act (review R2 T1BO-10): the button opened a "Withdraw" dialog.
  revoke: "Withdraw",
  revokeFor: (email: string) => `Withdraw the invitation to ${email}`,
  revokeTitle: (email: string) => `Withdraw the invitation to ${email}?`,
  revokeBody: "The link they have will stop working.",
  revokeConfirm: "Withdraw invitation",
  revoked: (email: string) => `The invitation to ${email} was withdrawn.`,
  dangerHeading: "Leave or hand over",
  leave: (company: string) => `Leave ${company}`,
  leaveTitle: (company: string) => `Leave ${company}?`,
  leaveBody: "You'll lose access to it straight away.",
  leaving: "Leaving…",
  transferHeading: "Transfer ownership",
  newOwner: "New owner",
  typeToConfirm: (company: string) => `Type ${company} to confirm`,
  transfer: "Transfer ownership",
  transferring: "Transferring…",
  transferExplain: (newOwner: string) =>
    `${newOwner} becomes the owner and runs the team and the settings. You'll become an Admin.`,
  transferNeedsSomeone: (company: string) =>
    `To hand ${company} to someone new, invite them first. Once they've joined, you can transfer ownership here.`,
  roleTitle: (name: string, role: string) => `Make ${name} ${aNoun(role)}?`,
  roleBody: (_name: string, description: string) => `${description ? `${description} ` : ""}The change takes effect straight away.`,
  roleConfirm: (role: string) => `Make ${aNoun(role)}`,
  transferred: (newOwner: string) => `${newOwner} is now the owner. You're an Admin.`,
  chooseNewOwner: "Choose someone",
  someone: "Someone",
  roleHint: (description: string) => description,
  noOneElse: "Nobody here yet",
} as const;

// ---------------------------------------------------------------------------
// Company settings (8.7)
// ---------------------------------------------------------------------------

export const SETTINGS = {
  profileHeading: "Name and web address",
  nameLabel: (noun: Noun) => `${nounTitle(noun.singular)} name`,
  addressLabel: "Web address",
  addressWarning: "Changing this changes your public web address. The old address keeps pointing here.",
  personalAddress: "A personal workspace keeps the web address it was given.",
  readOnly: "Only an owner or admin can change these.",
  brandingHeading: "Logo and colour",
  logo: "Logo",
  noLogo: "No logo yet",
  logoAlt: (company: string) => `${company} logo`,
  uploadLogo: "Upload logo",
  uploading: "Uploading…",
  logoHint: "A PNG, JPG or WebP image under 1 MB.",
  logoUploaded: "Logo uploaded.",
  removeLogo: "Remove logo",
  logoRemoved: "Logo removed.",
  colour: "Brand colour",
  colourHint: "Type a colour like #0f766e, or pick one.",
  // Review R2 T1BO-10: said while typing, not only after Save.
  colourNotYet: "That isn't a colour yet. Type one like #0f766e, or pick one.",
  colourInvalid: "Use a colour like #0f766e.",
  clearColour: "Clear colour",
  previewHeading: "Preview",
  sampleButton: "Book a visit",
  sampleLink: "A link in your colour",
  ratioSentence: (ratio: string, readable: boolean) =>
    `Text on this colour: ${ratio} to 1 (${readable ? "easy to read" : "hard to read"}).`,
  readSentence: (readable: boolean) =>
    readable ? "Text on this colour is easy to read." : "Text on this colour is hard to read.",
  contrastNumbers: "Contrast numbers",
  zoneSuggested: "Suggested from this device. Press Save to keep it.",
  noColour: "No colour chosen. Your pages use the site's own colours.",
  chooseZone: "Choose a time zone",
  otherZones: "Other time zones",
  usZones: "United States",
  sectionReadOnly: "You can see these but not change them.",
  // Review R2 T1BO-08: what isn't saved, in a bar that stays in view.
  unsavedBar: (sections: readonly string[]) => `Not saved yet: ${sections.join(", ")}. Each part has its own Save button.`,
  goToUnsaved: "Show me",
  leaveUnsaved: "You have changes that aren't saved. Leave this page anyway?",
} as const;

// ---------------------------------------------------------------------------
// The suspended screen (8.8)
// ---------------------------------------------------------------------------

export const SUSPENDED = {
  heading: (name: string) => `${name} is suspended`,
  bodyBefore: "You can't use it right now. ",
  contactSupport: "Contact support",
  bodyAfter: " to restore it.",
  switchTo: (noun: Noun) => `Switch to another ${noun.singular}:`,
} as const;

// ---------------------------------------------------------------------------
// A company's public face (Tenancy 2a, 5.2 and 5.3)
// ---------------------------------------------------------------------------

export const PUBLIC_FACE = {
  unavailableHeading: (name: string) => `${name} isn't taking requests online right now`,
  unavailableBody: "Please get in touch with them directly.",
  email: (address: string) => `Email ${address}`,
  call: (phone: string) => `Call ${phone}`,
  contactLabel: (name: string) => `How to reach ${name}`,
} as const;

// ---------------------------------------------------------------------------
// Operator console (8.10–8.12)
// ---------------------------------------------------------------------------

export const CONSOLE = {
  search: (noun: Noun) => `Search ${noun.plural} by name, web address or owner's email`,
  show: "Show",
  kindOrg: (noun: Noun) => nounTitle(noun.plural),
  kindPersonal: "Personal workspaces",
  kindAll: "All",
  status: "Status",
  statusAll: "All",
  statusActive: "Active",
  statusSuspended: "Suspended",
  colName: "Name",
  colAddress: "Web address",
  colPeople: "People",
  colOwner: "Owner",
  colCreated: "Created",
  colStatus: "Status",
  noMatch: (q: string) => `Nothing matches “${q}”.`,
  noMatchFilters: "Nothing matches these filters.",
  none: (noun: Noun) => `No ${noun.plural} yet. They appear here when someone signs up.`,
  loading: (noun: Noun) => `Loading ${noun.plural}…`,
  pages: "Pages",
} as const;

export const DETAIL = {
  back: (noun: Noun) => `Back to ${noun.plural}`,
  facts: "Details",
  created: "Created",
  createdBy: (date: string, who: string) => `${date} by ${who}`,
  owner: "Owner",
  ownerClosed: "(account closed). Use Change owner to hand it to someone on the team.",
  ownerClosedNoControl: "(account closed). A staff member who may change owners can hand it to someone on the team.",
  changeOwner: "Change owner",
  changeOwnerTitle: (company: string) => `Give ${company} a new owner?`,
  changeOwnerPick: "Choose who becomes the owner. Only people who are active on the team are listed.",
  changeOwnerBody: (name: string) => `${name} becomes the owner, with full control. The previous owner, if still on the team, becomes an Admin.`,
  changeOwnerConfirm: "Make them the owner",
  ownerChanged: (name: string, company: string) => `${name} now owns ${company}.`,
  newOwner: "New owner",
  oldAddresses: "Old web addresses",
  release: "Release old addresses",
  releaseTitle: (count: number) => `Release ${count} old web address${count === 1 ? "" : "es"}?`,
  releaseBody: (company: string) => `They stop pointing to ${company}, and anyone can use them.`,
  // Review R2 SEC-T1-C: a SUSPENDED company (a squatter) gives up its current address too.
  releaseAll: "Free its web addresses",
  webAddress: "Web address",
  releaseAllTitle: (slug: string) => `Free /t/${slug} and its old addresses?`,
  releaseAllBody: (company: string, slug: string) =>
    `${company} is suspended, so its current address /t/${slug} is freed too: it moves to a plain one, and anyone can use /t/${slug} and the old ones.`,
  released: "The old web addresses were released.",
  timeZone: "Time zone",
  contactEmail: "Contact email",
  contactPhone: "Contact phone",
  pending: "Pending invitations",
  // Review R2 T1BO-09: who is invited, so support can answer "I can't get in".
  invitedLine: (email: string, role: string, by: string | null) => `${email} as ${aNoun(role)}${by ? `, from ${by}` : ""}`,
  noPending: "No pending invitations.",
  notSet: "Not set",
  members: "Members",
  colEmail: "Email",
  activity: "Recent activity",
  activityOff: "Activity isn't connected on this site.",
  activityNone: "Nothing recorded yet.",
  suspend: (noun: Noun) => `Suspend ${noun.singular}`,
  suspendTitle: (name: string) => `Suspend ${name}?`,
  reason: "Why (only staff see this)",
  reasonHint: "Between 3 and 500 characters.",
  reasonShort: "Say why in at least 3 characters.",
  suspendWarning: (name: string) =>
    `Everyone in ${name} loses access until you reactivate it. They'll see a message telling them to contact support.`,
  suspendConfirm: "Suspend",
  suspendedLine: (date: string, who: string, reason: string) => `Suspended ${date} by ${who}: ${reason}`,
  suspendedDone: (name: string) => `${name} is suspended.`,
  reactivate: "Reactivate",
  reactivateTitle: (name: string) => `Reactivate ${name}?`,
  reactivateBody: (name: string) => `Everyone in ${name} gets access back straight away.`,
  reactivated: (name: string) => `${name} is active again.`,
  someone: "someone",
  loading: (noun: Noun) => `Loading the ${noun.singular}…`,
} as const;

export const PEOPLE = {
  search: "Search people by name or email",
  staffOnly: "Staff only",
  colName: "Name",
  colEmail: "Email",
  colJoined: "Joined",
  colCompanies: (noun: Noun) => nounTitle(noun.plural),
  // Review R2 T1BO-09: the count opens the companies they're in.
  companiesOf: (who: string, noun: Noun) => `: show the ${noun.plural} ${who} is in`,
  colStaffRole: "Staff role",
  noStaffRole: "No staff role",
  thisPerson: "this person",
  staffRoleFor: (who: string) => `Staff role for ${who}`,
  ownRow: "You can't change your own role.",
  aboveYou: "Only someone above them can change this.",
  giveTitle: "Give a staff role?",
  give: (email: string, role: string) =>
    `Give ${email} the ${role} staff role? They'll be able to use the staff screens that role allows.`,
  giveTop: (email: string, role: string) =>
    `Give ${email} the ${role} staff role? They'll be able to do everything you can, including giving and taking away staff roles, yours included.`,
  giveConfirm: "Give role",
  removeTitle: "Remove the staff role?",
  remove: (email: string) => `Remove ${email}'s staff role?`,
  removeConfirm: "Remove role",
  changed: (who: string) => `Staff role changed for ${who}.`,
  none: "Nobody matches.",
  loading: "Loading people…",
} as const;
