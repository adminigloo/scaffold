---
"@adminigloo/env": minor
---

`isLocalRun()`: is this the founder's own machine? `resolveAppEnv() === "local"`, or a production build nothing has identified as a deployment running on a localhost / 127.0.0.1 app URL (`pnpm build && pnpm start` on a laptop). A guess, and only for wording — which way back in a no-access page suggests: a self-hosted server that loads the project's .env.local (a localhost app URL) answers true as well, so nothing may grant on it (create-app 0.39 never makes the first sign-in an administrator from it). `resolveAppEnv` still reads that build as `staging`, so live keys and simulated checkout are unchanged.
