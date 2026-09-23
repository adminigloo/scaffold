---
"@adminigloo/assistant": minor
---

Budget conversation history to the model's context window. A chat handler that
rehydrated the entire stored transcript every turn would, on a long thread,
eventually exceed the window and hard-fail every further turn — bricking the
conversation with no way to recover it. `budgetHistory` now keeps the most
recent stored turns that fit a token ceiling (whole turns, so a replay never
severs a tool_use from its tool_result) before the model call. Ported from the
source's message-truncation, which runs before every call for this reason.
