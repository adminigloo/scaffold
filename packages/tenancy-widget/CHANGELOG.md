# @adminigloo/tenancy-widget

## 0.3.0

### Minor Changes

- 3c427cc: `<SetupChecklist compact>`: what's left in full and what's done folded into one line, for a dashboard. A company-settings toggle whose help describes both states ("Off: … On: …") shows only the half that is true now.

## 0.2.2

### Patch Changes

- Updated dependencies [e3d0371]
  - @adminigloo/tenancy@0.7.0

## 0.2.1

### Patch Changes

- 786a643: Released with `@adminigloo/tenancy` 0.6 (Tenancy 2b-1): the optional peer is
  now `^0.6.0`. No component or wire change.
- Updated dependencies [786a643]
  - @adminigloo/tenancy@0.6.0

## 0.2.0

### Minor Changes

- 2df95e8: Company features (Tenancy 2a).
  
  - **Any role the server offers.** The team page, the invite form and the role
    selects show a project's extra roles (Crew) with the name and description the
    server sends; a role the server names without a description reads as words
    ("field_lead" → "Field lead"), never a blank.
  - **`<CompanyBrandBar company={…} />`**: a company's public face at the top of
    its booking, estimate and invoice pages: its logo (or initials in its colour),
    its name linking to its public home, and its email and phone as links, with a
    rule in its colour. Server-renderable.
  - **`<CompanyUnavailable company={…} />`**: "{Name} isn't taking requests online
    right now. Please get in touch with them directly." with the company's
    contact links, for a suspended company's public pages. Nothing about why.
  - The `PublicCompanyWire` type, and the peer is now `@adminigloo/tenancy`
    `^0.5.0` (still optional).

### Patch Changes

- Updated dependencies [2df95e8]
  - @adminigloo/tenancy@0.5.0

## 0.1.0

### Minor Changes

- cc16902: First release: the screens for `@adminigloo/tenancy` 0.4 companies. React is its
  only required peer; `@adminigloo/tenancy` ^0.4.0 is an optional peer, so a
  mismatched server shows up at install time. It needs no Tailwind and no CSS
  import, follows the host page's light or dark theme, and every colour is a CSS
  token that passes WCAG AA in both. It never imports the server package at
  runtime: the wire types are declared here too, and a test fails the build if they
  drift from the server's by a byte.
  
  **For a business owner and their team** (`@adminigloo/tenancy-widget`):
  
  - `<Onboarding>`: "What's your company called?", with the web address suggested
    from the name as it's typed (and explained: it's where the company's page will
    be), checked after a pause, editable with "Change", and a taken or reserved
    address refused in a sentence with a free one a click away. One company per
    form however often the button is pressed — and a corrected name gets a new
    request, so a retry never brings back the typo. Invitations waiting for the
    person's verified email are offered first and join only on "Join …". Someone
    removed from their only company is told which one; the platform's staff get a
    link to the admin console instead of a nudge to create a company. The address
    shown before Create is the one the company gets (a "-2" when the plain one is
    taken), and when a Create's answer is lost the page checks whether the company
    was made and offers to open it, instead of inviting a second one.
  - `<CompanySwitcher>`: the header button (logo or initials and the name) and a
    keyboard menu of the person's companies, a suspended one labelled; switching is
    a full reload so every screen shows the new company. It shrinks with the header
    (no sideways scroll at 360 or 320 px) and opens toward the side with room.
    Nothing at all for a single-business site with one workspace.
  - `<SetupChecklist>`: "1 of 3 done", each item with its link, "Not needed" with
    an Undo, "Hide this list" with a way to bring it back, and a hidden list returns
    by itself when a new item is added.
  - `<TeamManager>`: invite by email with a role (the link handed over when the
    email couldn't go; a re-send says the invitation's earlier links still work —
    links, not emails, since with no mailer there never were any; one
    the email limits held says why and when, with the link), "Someone tried to
    accept this while signed in as j•••@gmail.com" beside an invitation, the
    members with the role changes and removals the server
    allows for THIS person — a promotion or demotion asks first and says what
    changes — pending invitations with Resend and Withdraw, Leave (not for the
    owner), and Transfer ownership after typing the company's name; an owner with
    nobody to hand over to is told to invite them first. Removing someone,
    changing a role, withdrawing an invitation and handing over ownership each
    leave a visible line at the top of Members, not only a screen-reader one.
  - `<CompanySettings>`: name and web address (the full public address shown),
    logo upload (a phone photo is shrunk in the browser before it's sent; when
    uploads aren't switched on the control says so before anyone picks a file),
    brand colour with a contrast preview that warns and never refuses (and says
    so while a colour is half typed), the time zone defaulted from the browser and
    every other zone named as a place, and every registered settings section. A
    bar that stays in view lists any part that isn't saved, and leaving — by
    closing the tab or an in-app link — asks first.
  - `<CompanySuspended>`: "… is suspended. Contact support to restore it.", with a
    support address when the site has one, never the reason, and the person's other
    companies to switch to.
  - `<AcceptInvitation>`: says which company and role the link is for before
    anything happens; nothing happens until "Accept invitation" is pressed; a link
    for another of your addresses is accepted; a link for an address you aren't
    signed in with says so BEFORE Accept, shows where it went (masked) and offers
    both ways out: sign out and use that address, or ask the inviter to invite
    this one.
  
  **For the platform's staff** (`@adminigloo/tenancy-widget/admin`):
  
  - `<CompaniesConsole>`: every company, searchable by name, web address or owner's
    email, filtered by kind (personal workspaces hidden by default) and status,
    paged, with the view kept in the address bar. `detailHref` takes a pattern
    ("/admin/companies/{id}") so a server page can pass it.
  - `<CompanyDetail>`: the company's facts, members, who is invited, and recent
    activity with the time and what changed ("Jake: Member → Admin"; access
    changes marked plainly, not as "Sensitive"); suspend (with a reason only staff
    see) and reactivate; give a company whose owner closed their account a new
    owner (the button waits for a choice); release its old web addresses — for a
    suspended company, its current one too.
  - `<StaffPeople>`: everyone with an account and their staff role, given or taken
    only where the server allows — an administrator can make another
    administrator, the last one can't be removed — with a confirmation first.
  
  `createTenancyClient` and `createTenancyAdminClient` never throw, and every
  component takes a `transport` instead of `baseUrl`, so the screens can run on tRPC
  or server actions. Keyboard everything, dialogs that trap and return focus, 44px
  targets, tables that become cards on a phone, and every component renders on the
  server.

### Patch Changes

- Updated dependencies [cc16902]
  - @adminigloo/tenancy@0.4.0
