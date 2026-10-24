'use strict';
// Preloaded with `node -r ./test/mock-ttsai.js server.js`. Replaces global fetch so that
// requests to api.tts.ai hit this fake instead of the real service. Used ONLY for tests.
const KEY = process.env.TTS_API_KEY || '';
const jobs = new Map();
let n = 0;
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'api.tts.ai') throw new Error(`mock blocked real network call to ${url.hostname}`);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';

  if (url.pathname.endsWith('/voices/')) {
    return json({ voices: [
      { id: 'af_bella', name: 'Bella', model: 'kokoro', language: 'en', gender: 'female' },
      { id: 'bm_george', name: 'George', model: 'kokoro', language: 'en', gender: 'male' },
      { id: 'en_US-amy-medium', name: 'Amy', model: 'piper', language: 'en', gender: 'female' },
    ], total: 3 });
  }
  if (url.pathname.endsWith('/tts/') && init.method === 'POST') {
    if (KEY && auth !== `Bearer ${KEY}`) return json({ error: 'bad key' }, 401);
    if (!KEY && auth) return json({ error: 'mock: anonymous mode must send no Authorization header' }, 500);
    const body = JSON.parse(init.body);
    if (body.format !== 'mp3') return json({ error: 'mock: expected mp3' }, 400);
    if (body.text.includes('AUTHFAIL')) return json({ error: 'Invalid API key' }, 401);
    if (body.text.includes('RATELIMIT')) return json({ error: 'Rate limit' }, 429, { 'retry-after': '30' });
    const uuid = `job${String(++n).padStart(6, '0')}abcdef`;
    jobs.set(uuid, { polls: 0, text: body.text });
    return json({ uuid, job_id: 'x-' + uuid, status: 'queued', credits_used: body.text.length, credits_remaining: 1000 });
  }
  if (url.pathname.endsWith('/speech/results/')) {
    const job = jobs.get(url.searchParams.get('uuid'));
    if (!job) return json({ error: 'not found' }, 404);
    job.polls++;
    if (job.text.includes('SLOWJOB')) return json({ status: 'processing' });
    if (job.polls < 2) return json({ status: 'processing' });
    if (job.text.includes('FAILJOB')) return json({ status: 'failed', error: 'model crashed' });
    if (job.text.includes('BADURL')) return json({ status: 'completed', result_url: 'https://evil.example.com/a.mp3' });
    return json({ status: 'completed', result_url: `https://api.tts.ai/static/downloads/${url.searchParams.get('uuid')}/output.mp3` });
  }
  if (url.pathname.startsWith('/static/downloads/')) {
    return new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  return json({ error: 'mock: unknown route ' + url.pathname }, 404);
};
