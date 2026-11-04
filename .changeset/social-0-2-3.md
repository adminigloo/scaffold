---
"@adminigloo/social": patch
"@adminigloo/create-app": patch
---

Social posts 0.2.3: any AI provider. New `@adminigloo/social/openai` (`createOpenAIComplete`): the metered call for OpenAI, or any service that speaks its Chat Completions API (Azure OpenAI, OpenRouter, Groq, Together, a local server), with the same rules as Claude's: the worst case held before the call and settled at what the provider reported, Structured Outputs (strict), no retries, a refusal or a cut-off answer turned into the app's own words. The app names the model and its price; there's no SDK import (hand it `new OpenAI()` or any client with `chat.completions.create`). The meter's types and `worstCaseMicros` now live in a shared module, still exported from `./anthropic` as before. Projects made with `--social` get 0.2.3.
