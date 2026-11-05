---
"@adminigloo/social": minor
"@adminigloo/create-app": patch
---

Social cards take the brand's whole logo.

- `brand.logo` (`{ src, width, height }`, any width: a wordmark or a lockup, as the brand's site and emails show it) is the cards' header: top left of every slide in place of the mark and the name, and on the brand's own quote card in place of the avatar and the name, with the handle under it. It keeps its shape at 88px tall and narrows to its room. The mark stays in the footers; a company's card and a quote card a named author posted never show it.
- New exports: `cardLogo(spec, assets)`, `logoSize` and `LOGO`.
- create-app pins social 0.4.0.
