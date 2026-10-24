'use strict';
// Starts the real server with a mocked TTS.ai (see mock-ttsai.js) and checks behaviour.
// It does NOT contact the live TTS.ai service.
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const KEY = 'sk-tts-TESTKEY-123';
const TOKEN = 'tok_secret';
let logs = '';

function start(port, env) {
  const p = spawn(process.execPath, ['-r', './test/mock-ttsai.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), POLL_INTERVAL_MS: '100', OVERLAY_WAIT_MS: '300', GENERATION_TIMEOUT_MS: '1500', ...env },
  });
  p.stdout.on('data', (d) => (logs += d)); p.stderr.on('data', (d) => (logs += d));
  return p;
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let pass = 0, fail = 0;
function check(name, ok, extra = '') { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + extra}`); }

(async () => {
  const A = 'http://127.0.0.1:3111', B = 'http://127.0.0.1:3112', C = 'http://127.0.0.1:3113';
  const servers = [
    start(3111, { TTS_API_KEY: KEY, ENDPOINT_TOKEN: TOKEN, RATE_LIMIT_PER_MIN: '100' }), // authenticated + token
    start(3112, { TTS_API_KEY: '', RATE_LIMIT_PER_MIN: '100' }),                           // anonymous
    start(3113, { TTS_API_KEY: KEY, RATE_LIMIT_PER_MIN: '3' }),                            // tight rate limit
  ];
  try {
    await Promise.all([waitUp(3111), waitUp(3112), waitUp(3113)]);
    const get = (base, q, headers) => fetch(`${base}/api/tts?${q}`, { headers });
    const err = async (r) => (await r.json()).error || {};
    const T = `token=${TOKEN}`;

    let r = await fetch(`${A}/health`); let j = await r.json();
    check('health endpoint', r.status === 200 && j.status === 'ok' && !JSON.stringify(j).includes(KEY));

    r = await fetch(`${A}/api/config`); const cfgText = await r.text();
    check('config works and does not leak key', r.status === 200 && !cfgText.includes(KEY));

    r = await fetch(`${A}/api/voices?model=kokoro`); j = await r.json();
    check('voices list loaded (kokoro only)', r.status === 200 && j.voices.length === 2 && j.voices.every((v) => v.model === 'kokoro'));

    r = await get(A, 'text=Hello');
    check('GET /api/tts without token -> 401', r.status === 401 && (await err(r)).code === 'invalid_token');

    r = await get(A, `text=Welcome%20to%20MalikGPT&${T}`); let buf = Buffer.from(await r.arrayBuffer());
    check('GET /api/tts returns MP3 bytes (polls until complete, downloads)', r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && buf.slice(0, 3).toString() === 'ID3', `${r.status} ${r.headers.get('content-type')}`);

    r = await get(A, `text=Hi&format=json&${T}`); j = await r.json();
    check('JSON mode returns audioUrl + job info', r.status === 200 && j.ok && j.audioUrl.startsWith('https://api.tts.ai/') && !!j.uuid, JSON.stringify(j));

    r = await fetch(`${A}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Dashboard test', model: 'kokoro', voice: 'bm_george', speed: 1.2 }) });
    buf = Buffer.from(await r.arrayBuffer());
    check('POST /api/generate (dashboard) returns audio', r.status === 200 && buf.slice(0, 3).toString() === 'ID3');

    r = await get(A, `text=%20%20&${T}`);
    check('empty text -> 400 empty_text', r.status === 400 && (await err(r)).code === 'empty_text');
    r = await get(A, `${T}`);
    check('missing text -> 400', r.status === 400);
    r = await get(A, `text=${'a'.repeat(501)}&${T}`);
    check('too-long text -> 400 text_too_long', r.status === 400 && (await err(r)).code === 'text_too_long');
    r = await get(A, `text=Hi&voice=nope_voice&${T}`);
    check('invalid voice -> 400 invalid_voice', r.status === 400 && (await err(r)).code === 'invalid_voice');
    r = await get(A, `text=Hi&model=evilmodel&${T}`);
    check('invalid model -> 400 invalid_model', r.status === 400 && (await err(r)).code === 'invalid_model');
    r = await get(A, `text=Hi&speed=9&${T}`);
    check('invalid speed -> 400 invalid_speed', r.status === 400 && (await err(r)).code === 'invalid_speed');
    r = await get(A, `text=Hi&model=piper&${T}`); j = await r.json().catch(() => ({}));
    check('piper without voice picks a piper voice', r.status === 200, JSON.stringify(j));

    r = await get(A, `text=AUTHFAIL&${T}`);
    check('TTS.ai 401 -> 502 tts_auth_failed', r.status === 502 && (await err(r)).code === 'tts_auth_failed');
    r = await get(A, `text=RATELIMIT&${T}`);
    check('TTS.ai 429 -> 429 + Retry-After', r.status === 429 && r.headers.get('retry-after') === '30' && (await err(r)).code === 'tts_rate_limited');
    r = await get(A, `text=FAILJOB&${T}`);
    check('failed job -> 502 generation_failed', r.status === 502 && (await err(r)).code === 'generation_failed');
    const t0 = Date.now(); r = await get(A, `text=SLOWJOB&${T}`);
    check('stuck job -> 504 generation_timeout', r.status === 504 && (await err(r)).code === 'generation_timeout' && Date.now() - t0 < 4000);
    r = await get(A, `text=BADURL&${T}`);
    check('non-TTS.ai result_url is refused (not fetched)', r.status === 502 && (await err(r)).code === 'blocked_audio_url');

    r = await get(B, 'text=Anonymous%20hello'); buf = Buffer.from(await r.arrayBuffer());
    check('anonymous mode works (no Authorization header sent)', r.status === 200 && buf.slice(0, 3).toString() === 'ID3', String(r.status));

    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await get(C, `text=Rate${i}`)).status);
    check('app rate limiter -> 429 after limit', codes.slice(0, 3).every((c) => c === 200) && codes[4] === 429, codes.join(','));

    r = await fetch(`${A}/api/announce?text=Hi`);
    check('announce without token -> 401', r.status === 401);
    r = await fetch(`${A}/api/overlay/next?token=wrong`);
    check('overlay/next with wrong token -> 401', r.status === 401);
    r = await fetch(`${A}/api/announce?text=%20&${T}`);
    check('announce with empty text -> 400', r.status === 400 && (await err(r)).code === 'empty_text');
    r = await fetch(`${B}/api/announce?text=Hi`);
    check('announce refused when ENDPOINT_TOKEN is not set -> 503', r.status === 503 && (await err(r)).code === 'token_required');
    r = await fetch(`${A}/api/announce?text=Overlay%20hello&${T}`); j = await r.json();
    check('announce queues -> 202', r.status === 202 && j.queued === true, JSON.stringify(j));
    r = await fetch(`${A}/api/overlay/next?${T}`); j = await r.json();
    check('overlay/next returns the queued announcement', r.status === 200 && j.item.text === 'Overlay hello' && j.item.voice === 'af_bella', JSON.stringify(j));
    const qs = new URLSearchParams({ text: j.item.text, model: j.item.model, voice: j.item.voice, speed: j.item.speed, token: TOKEN });
    r = await fetch(`${A}/api/tts?${qs}`); buf = Buffer.from(await r.arrayBuffer());
    check('overlay then fetches audio for that announcement', r.status === 200 && buf.slice(0, 3).toString() === 'ID3');
    r = await fetch(`${A}/api/overlay/next?${T}`);
    check('overlay/next with empty queue -> 204 after wait', r.status === 204);
    const waiting = fetch(`${A}/api/overlay/next?${T}`);
    await new Promise((x) => setTimeout(x, 100));
    await fetch(`${A}/api/announce?text=Live%20wake&${T}`);
    r = await waiting; j = await r.json().catch(() => ({}));
    check('waiting overlay is woken instantly by a new announcement', r.status === 200 && j.item && j.item.text === 'Live wake');

    r = await fetch(`${A}/api/nope`);
    check('unknown API route -> JSON 404', r.status === 404 && (await err(r)).code === 'not_found');

    check('API key never appears in server logs', !logs.includes(KEY));
  } catch (e) {
    fail++; console.log('FAIL  harness error:', e.message);
  } finally {
    servers.forEach((s) => s.kill());
    console.log(`\n${pass} passed, ${fail} failed (mocked TTS.ai; live API not contacted)`);
    process.exit(fail ? 1 : 0);
  }
})();
