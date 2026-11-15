# Spin & Speak

A random topic generator for impromptu speaking practice (interviews, group discussions, Toastmasters table topics) with AI scoring and areas of improvement.

**Live:** https://imvikv.github.io/spin-and-speak/

## Features
- 125 random topics across Everyday, Work, Creative and Opinion; draw 1, 3 or 5
- One button starts the countdown timer and voice recording together; your speech is transcribed by Whisper (Groq)
- Live word count, words-per-minute and filler-word counter
- AI score out of 100 across six weighted skills: grammar, coherence, confidence, vocabulary, fluency, filler control
- Areas to improve, language corrections, a polished rewrite and a next drill
- Custom AI-generated topics for any audience or situation
- Progress history saved in the browser

## How it fits together
```
GitHub Pages (index.html)  ──POST /score, /topics──▶  Cloudflare Worker (worker/)  ──▶  Groq (Whisper + gpt-oss-120b)
             POST /transcribe                          holds GROQ_API_KEY / GEMINI_API_KEY      └▶ Gemini (backup)
```
The website never sees the API key. The Worker only accepts requests from `ALLOWED_ORIGINS`, builds the prompts itself (so it can't be used as a general Gemini proxy), and limits each visitor to 10 calls a minute.

## Set up the AI backend (one time, ~10 minutes)
1. **Keys:** a Groq key from https://console.groq.com (free) and, optionally, a Gemini key from https://aistudio.google.com/apikey as a backup.
2. **Deploy the Worker:**
   ```bash
   cd worker
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GROQ_API_KEY     # paste the key when asked
   npx wrangler secret put GEMINI_API_KEY   # optional backup
   ```
   Note the URL it prints, e.g. `https://spin-and-speak-api.<you>.workers.dev`.
3. **Check it:** open `<worker-url>/health`; it should return `{"ok":true,...}`.
4. **Connect the site:** in `index.html`, set `const API_URL = "<worker-url>";` and push.

### Optional
- **Daily cap:** `npx wrangler kv namespace create USAGE`, paste the id into `wrangler.toml`, redeploy. Default cap is 300 AI calls/day (`DAILY_LIMIT`).
- **Model:** change `GEMINI_MODEL` in `wrangler.toml`.
- **Custom domain:** add it to `ALLOWED_ORIGINS` too.
