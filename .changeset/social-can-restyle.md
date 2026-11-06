---
"@adminigloo/social": patch
"@adminigloo/create-app": patch
---

The Look controls are switched off, saying where, on a post whose pictures this server can't redraw.

- The handler's `canRestyle(images, { tenantId })`: false for pictures another server made. The queue marks each such row (`QueuePostView.canRestyle`), and the post's Background and confetti controls show switched off with "Its pictures were drawn by <site>, so its look can be changed there, not here." instead of offering a change and refusing it.
- The refusal, when a redraw still can't happen, says why: the pictures were made somewhere else.
- create-app pins social 0.7.1.
