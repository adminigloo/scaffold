---
"@adminigloo/assistant": patch
---

Document the prompt-cache contract on `ProviderRequest`: an adapter should mark the end of `system` and the end of the newest message, because the loop keeps both prefixes stable (global-only system, append-only transcript, byte-equivalent rehydration). On Anthropic that is two `cache_control: { type: "ephemeral" }` breakpoints; unmarked, every step pays full price for the same tokens.
