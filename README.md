# Stream TTS Player

A small web app for streamers. Type an announcement, pick a voice, and play or download the MP3.
It also gives you a GET link (`/api/tts?text=...`) that returns the spoken audio, for Synchra or any HTTP client.
Your TTS.ai API key stays on the server and is never sent to the browser.

Official API docs: https://tts.ai/api/

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Express server: validation, TTS.ai calls, polling, rate limiting |
| `public/index.html`, `style.css`, `app.js` | The dashboard |
| `public/overlay.html` | The page that plays announcements (OBS Browser Source) |
| `test/` | Test suite that runs against a *mock* TTS.ai |
| `render.yaml` | Render settings (optional) |

## Deploy to Render (step by step)

1. **Put the code on GitHub.** Create a new empty repository on github.com, then in this folder run:
   ```
   git init
   git add .
   git commit -m "Stream TTS Player"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/stream-tts-player.git
   git push -u origin main
   ```
   (`.gitignore` already keeps `node_modules` and `.env` out. Never commit your API key.)
2. On https://render.com choose **New + > Web Service** and connect that GitHub repository.
3. Use these settings (or pick **Blueprint** and let `render.yaml` fill them in):
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
   - Instance type: **Free**
4. Open **Environment** and add the variables below, then deploy.
5. Visit `https://YOUR-APP.onrender.com/health`. You should see `{"status":"ok",...}`.

### Environment variables

| Name | Required | What it does |
|---|---|---|
| `TTS_API_KEY` | No | Your TTS.ai key (from tts.ai > Account). Without it the app runs anonymously on free models. |
| `ENDPOINT_TOKEN` | Required for the overlay, recommended otherwise | Any long random string. `GET /api/tts`, `/api/announce` and the overlay then require `token=...`, so strangers can't spend your characters or make your stream speak. |
| `MAX_TEXT_LENGTH` | No | Default `500` (the anonymous limit). Free accounts may allow up to 5,000; max accepted here is 5,000. |
| `EXTRA_MODELS` | No | Comma-separated extra model IDs, e.g. a premium model your plan allows. |
| `DEFAULT_MODEL` / `DEFAULT_VOICE` | No | Defaults for the GET endpoint. Defaults: `kokoro` / `af_bella`. |
| `RATE_LIMIT_PER_MIN` | No | Per-IP limit on this app's generation endpoints. Default `10`. |
| `GENERATION_TIMEOUT_MS` | No | How long to wait for a job. Default `45000`. |

`PORT` is set by Render automatically; the server listens on `0.0.0.0`.

## Using the GET endpoint

```
GET https://YOUR-APP.onrender.com/api/tts?text=Welcome%20to%20MalikGPT&token=YOUR_TOKEN
```

Returns `audio/mpeg`. Optional parameters: `voice`, `model`, `speed` (0.5-2.0).
Add `&format=json` to get job info and the TTS.ai audio URL instead of audio bytes:

```
curl "https://YOUR-APP.onrender.com/api/tts?text=Hello&format=json&token=YOUR_TOKEN"
curl "https://YOUR-APP.onrender.com/api/tts?text=Hello&token=YOUR_TOKEN" --output hello.mp3
```

Errors are JSON: `{"error":{"code":"text_too_long","message":"..."}}` with a matching HTTP status
(400 bad input, 401 wrong token, 429 rate limit, 502 TTS.ai problem, 504 timeout).

### What the server sends to TTS.ai internally

```
POST https://api.tts.ai/v1/tts/
Authorization: Bearer <TTS_API_KEY>        (only if configured)
Content-Type: application/json

{"text":"Welcome to MalikGPT","model":"kokoro","voice":"af_bella","format":"mp3","speed":1}
```
then `GET https://api.tts.ai/v1/speech/results/?uuid=<uuid>` every 1.5 s until `completed`, then it downloads `result_url`
(only if it is HTTPS on `api.tts.ai` or `tts.ai`).

## Play it on a web page (overlay) - the Synchra setup

Synchra only needs to **open a URL**. A web page you add to OBS does the playing.

1. Set `ENDPOINT_TOKEN` on Render (required for this feature; the announce endpoints refuse to work without it).
2. In OBS add a **Browser Source** with this URL (any size, e.g. 300x100; tick "Control audio via OBS" if you want it on the mixer):
   ```
   https://YOUR-APP.onrender.com/overlay.html?token=YOUR_TOKEN
   ```
   Add `&debug=1` to see what it is doing. It is transparent when idle.
3. In your Synchra command / alert, make an HTTP request to:
   ```
   https://YOUR-APP.onrender.com/api/announce?text=Thanks%20for%20the%20follow&token=YOUR_TOKEN
   ```
   It answers immediately (`202 {"queued":true}`); the overlay generates and plays the speech, one announcement at a time.
   Optional parameters: `voice`, `model`, `speed`. Up to 20 announcements queue; ones older than 2 minutes are dropped.

I could not confirm from public documentation that Synchra can send an HTTP request from a command or alert, so check
Synchra's docs or Discord for an "HTTP request / webhook / fetch" option. Test the announce link in your browser first:
paste it in the address bar and the overlay (or a normal browser tab with `overlay.html` open) should speak.

If you open `overlay.html` in a normal browser tab, click "Click to enable sound" once (browsers block autoplay). OBS Browser Source usually doesn't need it.

Bonus: the overlay keeps a connection open to your server, which may stop Render's free instance from sleeping while OBS is running (not verified).

## Testing

`npm test` starts the server with a **fake TTS.ai** and checks: health, MP3 generation and polling, JSON mode,
download, empty/long text, invalid voice/model/speed, 401 from TTS.ai, 429 from TTS.ai, failed job, timeout,
blocked result URL, the announce queue and overlay hand-off, anonymous mode, this app's rate limiter, and that the key never shows up in responses or logs.
These tests have **not** been run against the live TTS.ai service. After deploying, do one real test yourself:
open the dashboard, press "Use sample announcement", then "Generate speech".

## Known limitations

- Free-tier limits from the TTS.ai docs (verify current numbers at https://tts.ai/api/ and in your account):
  anonymous 5,000 characters/day per IP and 500 characters per request; free plan 10 requests/minute, 2 concurrent, 500 characters per request in the rate-limit table.
  Free models listed: `piper`, `vits`, `melotts`, `kokoro`. Kokoro is billed at a higher character rate than Piper/VITS/MeloTTS. Nothing here is unlimited.
- Render's free web services go to sleep when idle (as far as I know; check Render's current terms), so the first request after a quiet period can take a minute. That's a poor fit for live alerts; a paid instance or a keep-alive ping avoids it.
- Each request generates fresh audio (no caching), so repeated alerts use characters each time.
- Anonymous limits are per IP; on Render the calls come from Render's IP, so all your usage shares one allowance.
- Voice IDs are checked against TTS.ai's voice list (cached 10 minutes). If that list can't be loaded, the voice is passed through and TTS.ai decides.
