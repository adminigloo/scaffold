---
"@adminigloo/social": minor
"@adminigloo/create-app": patch
---

Social cards wear looks and move in video; the posts screen's pictures open in a viewer.

- Looks: `CardAssets.looks` by key, and a spec's signed `look`. A look's colours over the theme (and `theme.button` / `onButton` for the call), its pieces around the words per card size (`decor(frame)`: a picture, a ball with a face or a word, a bit of confetti), and a picture behind the small capitals (`eyebrow`). A company's card never wears the app's look; a look the app doesn't have draws the plain card. `LineBlock.measured` is a line's own width.
- The card route's parts for a video, outside the signature: `&layer=ground`, `words`, `piece-N` and `motion` (the motion sheet, JSON). `cardLayerUrl`, `splitCardLayer`, `cardMotion`, `CardMotion` and `CardMotionPiece`.
- Make a video on every platform with pictures, at their own size: `makeCardVideo` brings each piece on its own way (`enter`: pop, spray, fall, fade; `bob`; `stays`), the words on as each card crosses in (`words`: rise, slide, fade), the ground pushing in, and loops with no seam. Falls back to the slideshow for a card route without parts.
- `<ImageViewer>`, `useImageViewer()` and `viewOnPlainClick()`: a picture opens in a pop-up, one at a time or side by side, in the queue and in See every card format.
- `sampleCardSets(brand, { looks })` adds a set per look, and See every card format makes a video of each of its sizes.
- create-app pins social 0.5.0.
