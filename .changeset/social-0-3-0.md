---
"@adminigloo/social": minor
"@adminigloo/create-app": patch
---

Social posts 0.3.0: TikTok pictures or a video, one-command setup, any AI.

- Send to TikTok (phone share sheet, the caption on the clipboard) and Download images on every card with pictures.
- Make a video: a TikTok draft's slides as an MP4 made in the browser (H.264, 1080 x 1920, 30 fps, push-in, crossfades, a seamless loop), to send or download; the same clip is a Reel or a Short. `@adminigloo/social/video` for your own screens.
- `npx adminigloo-social init`: finds the app's directory, Drizzle db, schema and AI library, writes the glue, routes and page, adds the table and a card key, never overwrites, and stays closed until the staff check is wired.
- `@adminigloo/social/ai-sdk` (the Vercel AI SDK, any provider) and `openAIFetchClient` (OpenAI with no SDK) beside Claude, all metered the same way.
- From Almanac: hashtags per platform, Bluesky link cards, hook-first opening lines, strict approval, posts that go stale and expire, tagged links and the AI-smell check.
- create-app `--social`: tagged links, the AI-smell check and stale posts on by default; pins social 0.3.0.
