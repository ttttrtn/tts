(() => {
  const $ = (id) => document.getElementById(id);
  const el = { text: $('text'), counter: $('counter'), model: $('model'), voice: $('voice'), speed: $('speed'),
    speedOut: $('speedOut'), gen: $('generate'), msg: $('msg'), player: $('player'), audio: $('audio'),
    play: $('play'), pause: $('pause'), seek: $('seek'), volume: $('volume'), download: $('download'), sample: $('sample') };
  let cfg = { maxTextLength: 500, sample: '', defaultModel: 'kokoro', defaultVoice: 'af_bella', models: ['kokoro'] };
  let blobUrl = null;

  function show(kind, text) { el.msg.hidden = false; el.msg.className = `msg ${kind}`; el.msg.textContent = text; el.msg.setAttribute('role', kind === 'error' ? 'alert' : 'status'); }
  function hideMsg() { el.msg.hidden = true; }

  function updateCounter() {
    const n = el.text.value.length;
    el.counter.textContent = `${n} / ${cfg.maxTextLength}`;
    el.counter.classList.toggle('over', n > cfg.maxTextLength);
  }

  async function loadVoices() {
    el.voice.innerHTML = '<option>Loading voices…</option>';
    try {
      const r = await fetch(`/api/voices?model=${encodeURIComponent(el.model.value)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Could not load voices.');
      if (!data.voices.length) throw new Error('No voices returned for this model.');
      el.voice.innerHTML = '';
      for (const v of data.voices) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = [v.name, v.language, v.gender].filter(Boolean).join(' · ');
        el.voice.appendChild(o);
      }
      if (el.model.value === cfg.defaultModel && data.voices.some((v) => v.id === cfg.defaultVoice)) el.voice.value = cfg.defaultVoice;
    } catch (e) {
      el.voice.innerHTML = '<option value="">Voices unavailable</option>';
      show('error', e.message);
    }
  }

  async function generate() {
    hideMsg();
    const text = el.text.value.trim();
    if (!text) return show('error', 'Type an announcement first.');
    if (text.length > cfg.maxTextLength) return show('error', `Too long: ${text.length} characters (limit ${cfg.maxTextLength}).`);
    if (!el.voice.value) return show('error', 'Choose a voice first.');
    el.gen.disabled = true; el.gen.classList.add('loading'); el.gen.textContent = 'Generating…';
    try {
      const r = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: el.model.value, voice: el.voice.value, speed: Number(el.speed.value) }),
      });
      if (!r.ok) {
        let m = `Request failed (HTTP ${r.status}).`;
        try { m = (await r.json()).error.message; } catch { /* keep default */ }
        const wait = r.headers.get('retry-after');
        throw new Error(r.status === 429 && wait ? `${m} Try again in about ${wait}s.` : m);
      }
      const blob = await r.blob();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      el.audio.src = blobUrl;
      el.download.href = blobUrl;
      el.player.hidden = false;
      show('success', 'Speech ready. Press play.');
      el.audio.play().catch(() => {}); // browsers may block autoplay; the Play button still works
    } catch (e) {
      show('error', e.message);
    } finally {
      el.gen.disabled = false; el.gen.classList.remove('loading'); el.gen.textContent = 'Generate speech';
    }
  }

  el.text.addEventListener('input', updateCounter);
  el.sample.addEventListener('click', () => { el.text.value = cfg.sample; updateCounter(); el.text.focus(); });
  el.speed.addEventListener('input', () => { el.speedOut.textContent = `${Number(el.speed.value).toFixed(1)}×`; });
  el.model.addEventListener('change', loadVoices);
  el.gen.addEventListener('click', generate);
  el.play.addEventListener('click', () => el.audio.play());
  el.pause.addEventListener('click', () => el.audio.pause());
  el.volume.addEventListener('input', () => { el.audio.volume = Number(el.volume.value); });
  el.audio.addEventListener('timeupdate', () => { if (el.audio.duration) el.seek.value = (el.audio.currentTime / el.audio.duration) * 100; });
  el.seek.addEventListener('input', () => { if (el.audio.duration) el.audio.currentTime = (el.seek.value / 100) * el.audio.duration; });

  (async () => {
    try {
      cfg = await (await fetch('/api/config')).json();
    } catch { show('error', 'Could not reach the server.'); }
    el.model.innerHTML = '';
    for (const m of cfg.models) { const o = document.createElement('option'); o.value = o.textContent = m; el.model.appendChild(o); }
    el.model.value = cfg.defaultModel;
    updateCounter();
    loadVoices();
  })();
})();
