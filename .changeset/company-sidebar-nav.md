---
"@adminigloo/create-app": patch
---

A company's work area gets a left sidebar instead of one header row of every link (a companies project with every feature put 18+ links in one row, scrolled sideways and put the switcher on top of Dashboard). The links sit under plain-word headings (Work, Customers, Money, Website, Company), only for what was installed and what the person's role opens, with the company switcher at the top; below `lg` the sidebar is a drawer behind a Menu button (Escape closes it, focus returns, 44px rows). The top bar keeps the bell, Your account and the account button. Epics is no longer a nav entry (the Feedback board's toolbar links to it), the site's own Home / Products / Pricing stay on the public site, and a companies project that sells plans gets "Plan and billing" (/account/billing). The site's name is shown in words (`SITE_NAME`, the project name title-cased) in the header, footer and admin sidebar instead of the slug in tiny mono capitals; inside a company the company's own name and logo. `src/nav.ts`'s `SiteLink` gains `group` and `bar`. A single business keeps its one-row header.

The free-trial banner now shows: it looked a company up by the Clerk sign-in id instead of the app's own user id, found nobody and stayed blank (found walking Igloo Back Office).
