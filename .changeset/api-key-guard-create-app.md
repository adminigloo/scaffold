---
"@adminigloo/create-app": minor
---

"The key pays only for the live site" (create-app 0.44, for `--ai` and `--assistant` projects): installs ai 0.5's `mayCallModels`, so the generated `src/server/ai.ts` builds its Anthropic client only inside the running app — a script, an eval or a coding agent's test harness gets the same null a missing key gives.

- New: `src/__tests__/no-unmetered-ai.test.ts`, which fails if any file in the project (dot-folders included, `node_modules`/`.next`/`.git` skipped) builds its own client or reads `ANTHROPIC_API_KEY`, outside `src/server/ai.ts` and `src/env.ts`.
- New: `CLAUDE.md` tells every Claude agent working in the project to test and grade with Claude Code itself, never the project's own key; to keep the key out of a laptop's `.env.local`; to never set the override; and to ask the owner, with a cost, before any model call.
- `.env.example` now notes that `ANTHROPIC_API_KEY` belongs only in the deployment environment.
