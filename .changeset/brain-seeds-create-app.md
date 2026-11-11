---
"@adminigloo/create-app": minor
---

New projects install assistant 0.11. The site's own assistant editor (/admin/assistant) marks a guardrail whose text an owner edited ("edited — not the default") and offers "Use the default text", which puts the package's text back as the package's (a new `assistant.resetSection` staff procedure over `resetSectionToCode`; the text comes from `DEFAULT_SECTIONS`, never the request), so a later release's improved default reaches it again. The editor words a publish whose base is past the head (`base_ahead`) correctly instead of saying the section no longer exists. The upgrade note covers the one new column (`pnpm db:generate`) and marking versions a project's own code signed.
