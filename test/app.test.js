'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-app-'));
process.env.ENGLISH_DATA_DIR = path.join(tmp, 'data');
process.env.ENGLISH_REPO_DIR = tmp; // not a git repo -> sync reports no-repo, never touches the real repo
const { createApp } = require('../server/index');
const coach = require('../server/coach');
const store = require('../server/store');

const calls = [];
const fakeBackend = async (prompt) => {
  calls.push(prompt);
  if (!/New learner message/.test(prompt)) return { data: { reply_en: 'Hi! What did you do today?', corrections: [] } };
  return { data: {
    reply_en: 'Nice! Where did you go?', level_estimate: 'B1', stt_suspect: /RECOGNITION/.test(prompt),
    corrections: [
      { original: 'I goed', corrected: 'I went', kind: 'grammar', tag: 'Past Tense Irregular', explanation_ko: '불규칙 동사' },
      { original: 'play game', corrected: 'played games', kind: 'grammar', tag: 'past tense', explanation_ko: '과거형' },
      { original: 'good', corrected: 'great', kind: 'style', tag: 'word choice', explanation_ko: '더 자연스러움' },
      { original: 'x', corrected: 'y', kind: 'grammar', tag: 'extra', explanation_ko: '4번째는 잘려야 함' },
    ],
    vocab: [{ phrase: 'hang out', meaning_ko: '놀다' }],
  } };
};

let server, base;
let voiceLoaded = 0;
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test.before(async () => {
  server = createApp({ backend: fakeBackend, voiceModule: new Proxy({}, { get() { voiceLoaded++; return async () => ({ available: false }); } }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('text mode: opening question, typed turn, corrections capped at 3 and kinds kept apart', async () => {
  const start = await post('/api/session/start', { mode: 'text', level: 'B1', topic: 'travel' });
  assert.equal(start.status, 200);
  assert.equal(start.body.session.turns.length, 1);
  assert.match(start.body.session.turns[0].text, /\?/);
  const r = await post(`/api/session/${start.body.session.id}/message`, { text: 'I goed to school', inputMethod: 'text' });
  assert.equal(r.status, 200);
  const coachTurn = r.body.session.turns.at(-1);
  assert.equal(coachTurn.corrections.length, coach.MAX_CORRECTIONS);
  assert.deepEqual(coachTurn.corrections.map((c) => c.kind), ['grammar', 'grammar', 'style']);
  assert.equal(coachTurn.corrections[0].tag, 'past tense irregular');
  assert.equal(voiceLoaded, 0, 'voice module must not be touched in text mode');
});

test('mode switch keeps the same session/history and persists last mode; context reaches the coach', async () => {
  const s = (await post('/api/session/start', { mode: 'text' })).body.session;
  await post(`/api/session/${s.id}/message`, { text: 'My name is Sam.', inputMethod: 'text' });
  const sw = await post(`/api/session/${s.id}/mode`, { mode: 'mixed', input: 'voice', output: 'text' });
  assert.equal(sw.body.settings.mode, 'mixed');
  assert.equal(sw.body.settings.input, 'voice');
  assert.equal(sw.body.settings.output, 'text');
  const r = await post(`/api/session/${s.id}/message`, { text: 'I like games', inputMethod: 'voice' });
  assert.equal(r.body.session.turns.length, 5);
  assert.equal(r.body.session.turns[3].inputMethod, 'voice');
  assert.match(calls.at(-1), /My name is Sam\./, 'earlier text-mode turn is in the context of the later voice turn');
  assert.match(calls.at(-1), /SPEECH RECOGNITION/);
  assert.equal(r.body.reply.stt_suspect, true);
  assert.equal(store.getSettings().mode, 'mixed');
  assert.equal(store.getSession(s.id).modeLog.length, 2);
});

test('voice routes are blocked in text mode and only then (no mic/TTS requests)', async () => {
  await post('/api/settings', { mode: 'text' });
  const before = voiceLoaded;
  assert.equal((await fetch(base + '/api/voice/status')).status, 403);
  assert.equal((await post('/api/voice/tts', { text: 'hi' })).status, 403);
  assert.equal(voiceLoaded, before);
  await post('/api/settings', { mode: 'voice' });
  assert.equal((await fetch(base + '/api/voice/status')).status, 200);
  await post('/api/settings', { mode: 'text' });
});

test('client never statically loads or calls voice code (text mode stays voice-free)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert.ok(!/voice\.js/.test(html), 'index.html must not include voice.js');
  const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  assert.ok(!/getUserMedia|SpeechRecognition|speechSynthesis/.test(app), 'app.js must not touch mic/TTS APIs');
  assert.match(app, /if \(needsVoice\(S\.settings\)\) await ensureVoice\(\); else teardownVoice\(\)/);
});

test('end session writes a sanitized summary, progress aggregates and review targets appear', async () => {
  const s = (await post('/api/session/start', { mode: 'text' })).body.session;
  await post(`/api/session/${s.id}/message`, { text: 'mail me at a.b@c.com 010-1234-5678', inputMethod: 'text' });
  const end = await post(`/api/session/${s.id}/end`);
  assert.equal(end.status, 200);
  assert.equal(end.body.summary.userTurns, 1);
  assert.ok(end.body.summary.grammarErrors >= 1);
  assert.equal(end.body.sync.ok, false); // tmp is not a git repo -> reported, not thrown
  const files = fs.readdirSync(path.join(process.env.ENGLISH_DATA_DIR, 'sync', 'sessions'));
  assert.ok(files.some((f) => f.includes(s.id)));
  const raw = JSON.stringify(end.body.summary);
  assert.ok(!raw.includes('a.b@c.com') && !raw.includes('1234-5678'));
  assert.ok(!raw.includes('mail me at'), 'raw user text is not part of the synced summary');
  const p = store.progress();
  assert.ok(p.recurring.find((r) => r.tag === 'past tense irregular').count >= 1);
  assert.ok(store.reviewTargets().some((t) => /hang out/.test(t)), 'vocab from the session becomes a review target');
  assert.ok(store.reviewTargets().length > 0);
});

test('coach failure returns a clear error and keeps history untouched', async () => {
  const bad = createApp({ backend: async () => { throw new Error('boom'); } });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${bad.address().port}`;
  const s = store.createSession({ mode: 'text', input: 'text', output: 'text', level: 'B1', topic: 'x' });
  const r = await fetch(`${b}/api/session/${s.id}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.status, 502);
  assert.equal(store.getSession(s.id).turns.length, 0);
  bad.close();
});

test('API rejects foreign Origin headers', async () => {
  const r = await fetch(base + '/api/state', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('static serving blocks path traversal', async () => {
  const r = await fetch(base + '/..%2fserver%2findex.js');
  assert.equal(r.status, 404);
});

test('abandoned sessions (tab closed, never ended) are summarized when the next session starts', async () => {
  const old = (await post('/api/session/start', { mode: 'text' })).body.session;
  await post(`/api/session/${old.id}/message`, { text: 'I goed home.', inputMethod: 'text' });
  const empty = (await post('/api/session/start', { mode: 'text' })).body.session; // finalizes `old`
  const dir = path.join(process.env.ENGLISH_DATA_DIR, 'sync', 'sessions');
  assert.ok(fs.readdirSync(dir).some((f) => f.includes(old.id)), 'abandoned session got a summary');
  assert.ok(store.getSession(old.id).endedAt);
  await post('/api/session/start', { mode: 'text' }); // `empty` has no user turns -> closed without a summary
  assert.ok(store.getSession(empty.id).endedAt);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(empty.id)));
});
