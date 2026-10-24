'use strict';
/**
 * Stream TTS Player - Express server
 * Talks to the official TTS.ai API (https://tts.ai/api/) from the backend only.
 * Workflow: POST /v1/tts/ -> poll GET /v1/speech/results/?uuid=... -> download result_url (MP3).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

// ---------- Configuration (all from environment variables) ----------
const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const PORT = int(process.env.PORT, 3000, 1, 65535);
const API_KEY = (process.env.TTS_API_KEY || '').trim();          // optional
const ENDPOINT_TOKEN = (process.env.ENDPOINT_TOKEN || '').trim(); // optional, protects GET /api/tts
const API_BASE = 'https://api.tts.ai/v1/';                       // fixed on purpose
const ALLOWED_AUDIO_HOSTS = new Set(['api.tts.ai', 'tts.ai']);    // result_url must be HTTPS on one of these
const FREE_MODELS = ['piper', 'vits', 'melotts', 'kokoro'];       // free models listed in the TTS.ai docs
const EXTRA_MODELS = (process.env.EXTRA_MODELS || '').split(',')
  .map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9._-]{1,40}$/.test(s));
const MODELS = [...new Set([...FREE_MODELS, ...EXTRA_MODELS])];
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'kokoro').toLowerCase();
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'af_bella';
const MAX_TEXT = int(process.env.MAX_TEXT_LENGTH, 500, 1, 5000);   // anonymous cap is 500
const RATE_LIMIT_PER_MIN = int(process.env.RATE_LIMIT_PER_MIN, 10, 1, 600);
const POLL_MS = int(process.env.POLL_INTERVAL_MS, 1500, 50, 5000);
const GENERATION_TIMEOUT_MS = int(process.env.GENERATION_TIMEOUT_MS, 45000, 500, 120000);
const REQUEST_TIMEOUT_MS = int(process.env.REQUEST_TIMEOUT_MS, 15000, 500, 60000);
const MAX_CONCURRENT = int(process.env.MAX_CONCURRENT, 2, 1, 20);  // free plan allows 2 concurrent
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

// ---------- Helpers ----------
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(json) {
  const h = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`; // only ever sent to api.tts.ai
  return h;
}

async function upstreamError(res) {
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j.error?.message || j.error || j.detail || j.message || '';
    } catch { detail = t; }
  } catch { /* ignore */ }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.replace(/\s+/g, ' ').slice(0, 200);
  const s = res.status;
  if (s === 401 || s === 403) {
    return new ApiError(502, 'tts_auth_failed',
      'TTS.ai rejected the API key (or this request needs one). Check TTS_API_KEY in your Render environment.');
  }
  if (s === 402) return new ApiError(402, 'tts_out_of_credits', 'TTS.ai reports no characters/credits left on this account.');
  if (s === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after'), 10) || 30;
    return new ApiError(429, 'tts_rate_limited',
      'TTS.ai rate limit or daily character allowance reached. Try again later.', { retryAfter });
  }
  if (s >= 400 && s < 500) return new ApiError(400, 'tts_rejected', `TTS.ai rejected the request${detail ? `: ${detail}` : '.'}`);
  return new ApiError(502, 'tts_upstream_error', `TTS.ai returned an error (HTTP ${s}).`);
}

/** fetch with a timeout that also covers reading the body. reader(res) parses a successful response. */
async function request(url, opts, reader) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const isManualRedirect = opts.redirect === 'manual' && res.status >= 300 && res.status < 400;
    if (!res.ok && !isManualRedirect) throw await upstreamError(res);
    return await reader(res);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError(504, 'upstream_timeout', 'TTS.ai did not answer in time.');
    throw new ApiError(502, 'upstream_unreachable', 'Could not reach TTS.ai.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Input validation ----------
let voiceCache = { at: 0, voices: null };
async function getVoices() {
  if (voiceCache.voices && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;
  const j = await request(`${API_BASE}voices/`, { headers: authHeaders(false) }, (r) => r.json());
  const list = Array.isArray(j) ? j : j && j.voices;
  if (!Array.isArray(list)) throw new ApiError(502, 'bad_voices_response', 'Unexpected voices response from TTS.ai.');
  const voices = list.filter((v) => v && typeof v.id === 'string').map((v) => ({
    id: v.id, name: v.name || v.id, model: v.model || '', language: v.language || '', gender: v.gender || '',
  }));
  voiceCache = { at: Date.now(), voices };
  return voices;
}

async function resolveVoice(model, requested) {
  let voices = null;
  try { voices = await getVoices(); } catch (e) { console.warn('Voice list unavailable:', e.code); }
  const forModel = voices ? voices.filter((v) => !v.model || v.model === model) : null;
  let voice = requested;
  if (!voice) {
    if (model === DEFAULT_MODEL) voice = DEFAULT_VOICE;
    else if (forModel && forModel.length) voice = forModel[0].id;
    else throw new ApiError(400, 'voice_required', `Please choose a voice for model "${model}".`);
  }
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(voice)) throw new ApiError(400, 'invalid_voice', 'Voice ID has invalid characters.');
  if (forModel && forModel.length && !forModel.some((v) => v.id === voice)) {
    throw new ApiError(400, 'invalid_voice', `Voice "${voice}" is not available for model "${model}".`);
  }
  return voice;
}

async function parseParams(input) {
  let { text, model, voice, speed } = input;
  if (typeof text !== 'string') throw new ApiError(400, 'empty_text', 'Provide the announcement as a single "text" value.');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new ApiError(400, 'empty_text', 'Text is empty.');
  if (text.length > MAX_TEXT) {
    throw new ApiError(400, 'text_too_long', `Text is ${text.length} characters; the limit is ${MAX_TEXT}.`, { max: MAX_TEXT });
  }
  model = (model == null || model === '' ? DEFAULT_MODEL : String(model)).toLowerCase();
  if (!MODELS.includes(model)) throw new ApiError(400, 'invalid_model', `Unsupported model "${model.slice(0, 40)}". Allowed: ${MODELS.join(', ')}.`);
  const speedNum = speed == null || speed === '' ? 1 : Number(speed);
  if (!Number.isFinite(speedNum) || speedNum < 0.5 || speedNum > 2) {
    throw new ApiError(400, 'invalid_speed', 'Speed must be a number between 0.5 and 2.0.');
  }
  voice = await resolveVoice(model, voice == null || voice === '' ? '' : String(voice));
  return { text, model, voice, speed: speedNum };
}

// ---------- TTS.ai workflow ----------
function assertAllowedAudioUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ApiError(502, 'blocked_audio_url', 'TTS.ai returned an invalid audio URL.'); }
  const bad = u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !ALLOWED_AUDIO_HOSTS.has(u.hostname);
  if (bad) throw new ApiError(502, 'blocked_audio_url', 'Audio URL is not on an approved TTS.ai host, so it was not fetched.');
  return u;
}

async function generateJob(p) {
  const body = JSON.stringify({ text: p.text, model: p.model, voice: p.voice, format: 'mp3', speed: p.speed });
  const first = await request(`${API_BASE}tts/`, { method: 'POST', headers: authHeaders(true), body }, async (r) => {
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('audio/')) return { audio: Buffer.from(await r.arrayBuffer()), contentType: ct };
    return { json: await r.json() };
  });
  if (first.audio) return { uuid: null, resultUrl: null, audio: first.audio, contentType: first.contentType };

  const uuid = first.json && first.json.uuid;
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(uuid)) {
    throw new ApiError(502, 'bad_submit_response', 'TTS.ai did not return a job id.');
  }
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let transient = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let r;
    try {
      r = await request(`${API_BASE}speech/results/?uuid=${encodeURIComponent(uuid)}`, { headers: authHeaders(false) }, (x) => x.json());
      transient = 0;
    } catch (e) {
      if ((e.code === 'upstream_timeout' || e.code === 'upstream_unreachable' || e.code === 'tts_upstream_error') && ++transient <= 3) continue;
      throw e;
    }
    const status = String((r && r.status) || '').toLowerCase();
    if (status === 'completed') {
      if (!r.result_url) throw new ApiError(502, 'bad_result', 'TTS.ai finished but returned no audio URL.');
      return { uuid, jobId: first.json.job_id || null, resultUrl: assertAllowedAudioUrl(r.result_url).href };
    }
    if (status === 'failed' || status === 'error') {
      throw new ApiError(502, 'generation_failed', `TTS.ai could not generate this audio${r.error ? `: ${String(r.error).slice(0, 150)}` : '.'}`);
    }
  }
  throw new ApiError(504, 'generation_timeout', `Speech was not ready after ${Math.round(GENERATION_TIMEOUT_MS / 1000)} seconds. Try again or use shorter text.`);
}

async function downloadAudio(resultUrl) {
  let url = assertAllowedAudioUrl(resultUrl);
  for (let hop = 0; hop < 4; hop++) {
    const out = await request(url.href, { redirect: 'manual', headers: { Accept: 'audio/*' } }, async (r) => {
      if (r.status >= 300 && r.status < 400) return { redirect: r.headers.get('location') };
      const len = parseInt(r.headers.get('content-length'), 10);
      if (len > MAX_AUDIO_BYTES) throw new ApiError(502, 'audio_too_large', 'Audio file is larger than allowed.');
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('audio/') && !ct.startsWith('application/octet-stream')) {
        throw new ApiError(502, 'bad_audio_type', 'TTS.ai returned something that is not audio.');
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_AUDIO_BYTES) throw new ApiError(502, 'audio_too_large', 'Audio file is larger than allowed.');
      return { audio: buf, contentType: ct.startsWith('audio/') ? ct.split(';')[0] : 'audio/mpeg' };
    });
    if (out.audio) return out;
    if (!out.redirect) throw new ApiError(502, 'bad_redirect', 'TTS.ai sent an invalid redirect.');
    url = assertAllowedAudioUrl(new URL(out.redirect, url).href); // every hop is re-validated
  }
  throw new ApiError(502, 'too_many_redirects', 'Too many redirects while fetching audio.');
}

let active = 0;
async function synthesize(input, { wantAudio }) {
  if (active >= MAX_CONCURRENT) {
    throw new ApiError(429, 'busy', 'Another announcement is still being generated. Try again in a couple of seconds.', { retryAfter: 3 });
  }
  active++;
  try {
    const params = await parseParams(input);
    const job = await generateJob(params);
    let audio = job.audio, contentType = job.contentType;
    if (wantAudio && !audio) ({ audio, contentType } = await downloadAudio(job.resultUrl));
    return { params, job, audio, contentType: contentType || 'audio/mpeg' };
  } finally {
    active--;
  }
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy; needed for per-IP rate limiting

const jsonLimited = (limit) => rateLimit({
  windowMs: 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } }),
});
const generateLimiter = jsonLimited(RATE_LIMIT_PER_MIN);
const lightLimiter = jsonLimited(60);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function checkToken(req) {
  if (!ENDPOINT_TOKEN) return;
  const given = String(req.query.token || req.get('x-api-token') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ENDPOINT_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new ApiError(401, 'invalid_token', 'Missing or wrong token.');
}

function sendAudio(res, audio, contentType, uuid) {
  res.set({
    'Content-Type': contentType, 'Content-Length': audio.length, 'Content-Disposition': 'inline; filename="speech.mp3"',
    'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'X-Job-Uuid',
  });
  if (uuid) res.set('X-Job-Uuid', uuid);
  res.status(200).end(audio);
}

app.get('/health', (req, res) => res.json({
  status: 'ok', uptimeSeconds: Math.round(process.uptime()), apiKeyConfigured: Boolean(API_KEY), tokenRequiredForGetTts: Boolean(ENDPOINT_TOKEN),
}));

app.get('/api/config', lightLimiter, (req, res) => res.json({
  models: MODELS, defaultModel: DEFAULT_MODEL, defaultVoice: DEFAULT_VOICE, maxTextLength: MAX_TEXT,
  usingApiKey: Boolean(API_KEY), sample: 'Welcome to the stream! Thank you for the follow, and enjoy the show.',
}));

app.get('/api/voices', lightLimiter, wrap(async (req, res) => {
  const model = req.query.model ? String(req.query.model).toLowerCase() : '';
  const voices = await getVoices();
  res.json({ voices: model ? voices.filter((v) => !v.model || v.model === model) : voices });
}));

// Dashboard: returns MP3 bytes.
app.post('/api/generate', generateLimiter, express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const { audio, contentType, job } = await synthesize(req.body || {}, { wantAudio: true });
  sendAudio(res, audio, contentType, job.uuid);
}));

// Synchra / any HTTP client: GET /api/tts?text=Hello  (add &format=json for job info instead of audio)
app.get('/api/tts', generateLimiter, wrap(async (req, res) => {
  checkToken(req);
  const asJson = req.query.format === 'json' || req.query.mode === 'json';
  const { params, job, audio, contentType } = await synthesize(req.query, { wantAudio: !asJson });
  if (asJson) {
    return res.json({
      ok: true, status: 'completed', uuid: job.uuid, jobId: job.jobId, audioUrl: job.resultUrl,
      model: params.model, voice: params.voice, speed: params.speed, characters: params.text.length,
    });
  }
  sendAudio(res, audio, contentType, job.uuid);
}));

// ---------- Overlay queue: Synchra calls /api/announce, the overlay page plays it ----------
const OVERLAY_WAIT_MS = int(process.env.OVERLAY_WAIT_MS, 25000, 100, 55000);
const QUEUE_MAX = 20;
const QUEUE_TTL_MS = 2 * 60 * 1000; // announcements older than this are dropped
const queue = [];
let waiters = [];
let seq = 0;

function requireToken(req) {
  if (!ENDPOINT_TOKEN) throw new ApiError(503, 'token_required', 'Set the ENDPOINT_TOKEN environment variable to use the announce queue.');
  checkToken(req);
}
function prune() { const now = Date.now(); while (queue.length && now - queue[0].at > QUEUE_TTL_MS) queue.shift(); }
function flush() {
  prune();
  while (queue.length && waiters.length) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    w.res.json({ item: queue.shift() });
  }
}

// GET (or POST JSON) /api/announce?text=Hello&token=...  -> queues speech for the overlay page. Returns fast (202).
app.all('/api/announce', generateLimiter, express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use GET or POST.');
  requireToken(req);
  prune();
  if (queue.length >= QUEUE_MAX) throw new ApiError(429, 'queue_full', 'Announcement queue is full. Try again shortly.', { retryAfter: 5 });
  const p = await parseParams(req.method === 'GET' ? req.query : (req.body || {}));
  const item = { id: String(++seq), text: p.text, model: p.model, voice: p.voice, speed: p.speed, at: Date.now() };
  queue.push(item);
  flush();
  res.status(202).json({ ok: true, queued: true, id: item.id, queueLength: queue.length, characters: p.text.length });
}));

// The overlay page long-polls this: returns the next announcement, or 204 if nothing arrived in ~25 s.
app.get('/api/overlay/next', lightLimiter, wrap(async (req, res) => {
  requireToken(req);
  res.set('Cache-Control', 'no-store');
  prune();
  if (queue.length) return res.json({ item: queue.shift() });
  const w = { res };
  w.timer = setTimeout(() => { waiters = waiters.filter((x) => x !== w); res.status(204).end(); }, OVERLAY_WAIT_MS);
  waiters.push(w);
  req.on('close', () => { if (!res.writableEnded) { clearTimeout(w.timer); waiters = waiters.filter((x) => x !== w); } });
}));

app.use('/api', (req, res, next) => next(new ApiError(404, 'not_found', 'Unknown API route.')));
app.use(express.static(path.join(__dirname, 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'bad_json', 'Request body is not valid JSON.');
  if (err.type === 'entity.too.large') err = new ApiError(413, 'too_large', 'Request body is too large.');
  if (!(err instanceof ApiError)) { console.error('Unexpected error:', err.message); err = new ApiError(500, 'server_error', 'Something went wrong on the server.'); }
  if (err.extra.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
  res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.extra.max ? { max: err.extra.max } : {}) } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stream TTS Player listening on 0.0.0.0:${PORT} (API key ${API_KEY ? 'configured' : 'not set - anonymous mode'}, token ${ENDPOINT_TOKEN ? 'required' : 'off'})`);
});
