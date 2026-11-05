---
"@adminigloo/social": minor
"@adminigloo/create-app": patch
---

A look is two choices: a background and a switch over it (confetti); See every card format shows one look at a time.

- `LookChoices` (`label`, `options`, `toggle?: { suffix, turnOn, turnOff }`) replaces 0.6's flat list from the handler's `looks()` and in `QueueWire.looks` (pass `{ label, options }` for 0.6's picker). A look's key is an option's, plus the toggle's suffix when it's on. `lookKeys`, `lookKey`, `lookParts`, `firstLook` (root).
- `<LookControls>` (./ui): the dropdown and the switch's button, on each post and at the top of See every card format.
- See every card format shows every format in the chosen look: `cardFormats(tenantId, { look })`, `GET v1/admin/card-formats?look=` (an unknown look is refused), `client.cardFormats(look)`, `sampleCardSets(brand, { look })`. It opens on the first option with the switch on.
- create-app pins social 0.7.0.
