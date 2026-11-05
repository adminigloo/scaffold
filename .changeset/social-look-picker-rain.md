---
"@adminigloo/social": minor
"@adminigloo/create-app": patch
---

Switch a post's look from the queue, and let a look's pieces rain.

- The Look picker: the handler's `looks(tenantId)` (their keys and names) and `restyle(images, look, { tenantId })` (the app re-signs each card), `POST v1/admin/posts/{post}/look` (every platform of the post not posted or skipped; words and their edit stamp untouched), `QueueWire.looks`, `QueueActions.restyle`, `<PostQueue looks>`, and `lookOf(images)`. A handler given looks without restyle throws.
- Rain: `enter: "rain"` with `fall`, `sway` and `spin` on a piece; the motion sheet carries them; `rainAt` and `RainClip` in `./video`; `MotionLayer.time`, the frame's own time in the clip. Rain falls on the clip's clock, outside the ground's push-in, and repeats a whole number of times in the clip.
- Each platform with pictures says how to post something that moves: the video, in place of the picture.
- create-app pins social 0.6.0.
