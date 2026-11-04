---
"@adminigloo/social": patch
"@adminigloo/create-app": patch
---

Social posts 0.2.2, from running 0.2.1 with the real model (Claude Haiku 4.5) and in dark mode. A typed post no longer says its first fact twice where a platform opens with the hook (LinkedIn, Facebook, Instagram, TikTok): it opens with the person's own first sentence and goes on with the rest (`PostSource.openingLine`), and Reddit's title is that sentence whole. Dark mode: native scrollbars and controls follow it (`color-scheme`), a plain link is the accent rather than the browser's blue, and the posts page paints its own ground so its titles read on any host. The AI-smell check refuses "has a way of". Projects made with `--social` get 0.2.2.
