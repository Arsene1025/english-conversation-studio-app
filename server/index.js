'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const coach = require('./coach');
const sync = require('./sync');

const WEB = path.resolve(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 25 * 1024 * 1024;

function createApp({ backend, voiceModule } = {}) {
  const locks = new Map(); // per-session serialization of turns
  let startSyncResult = null;
  const loadVoice = () => voiceModule || require('./voicestudio'); // lazy: text mode never loads this

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const readBody = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => { const b = await readBody(req, 1024 * 1024); try { return b.length ? JSON.parse(b) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); } };

  async function turn(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  }

  const history = (s) => s.turns.map((t) => ({ role: t.role, text: t.text }));
  const ctxFor = (s, newInput) => ({ history: history(s), level: s.level, topic: s.topic, review: store.reviewTargets(), newInput });

  async function coachTurn(s, newInput, settings) {
    const { reply, meta } = await coach.respond(ctxFor(s, newInput), backend);
    const now = new Date().toISOString();
    if (newInput) {
      s.turns.push({ role: 'user', text: newInput.text, inputMethod: newInput.inputMethod, mode: settings.mode, at: now, stt_suspect: reply.stt_suspect });
    }
    s.turns.push({ role: 'coach', text: reply.reply_en, outputMethod: settings.output, mode: settings.mode, at: now, corrections: reply.corrections, vocab: reply.vocab, stt_note_ko: reply.stt_note_ko });
    if (reply.level_estimate) s.levelEstimate = reply.level_estimate;
    store.saveSession(s);
    return { reply, meta };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    // DNS-rebinding / cross-site guard: only our own origin may call the API.
    if (p.startsWith('/api/')) {
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'bad origin' });
    }

    if (m === 'GET' && p === '/api/state') {
      return send(res, 200, {
        settings: store.getSettings(), progress: store.progress(), sessions: store.listSessions().slice(0, 10),
        open: (() => { const o = store.openSession(); return o ? { id: o.id, topic: o.topic, level: o.level, turns: o.turns.length } : null; })(),
        sync: await sync.status(), startSync: startSyncResult,
        backend: process.env.COACH_BACKEND || 'claude-cli', machine: store.machineId(),
      });
    }
    if (m === 'POST' && p === '/api/settings') return send(res, 200, { settings: store.saveSettings(await readJson(req)) });

    if (m === 'POST' && p === '/api/session/start') {
      const b = await readJson(req);
      const settings = store.saveSettings({ ...(b.mode ? { mode: b.mode } : {}), ...(b.input ? { input: b.input } : {}), ...(b.output ? { output: b.output } : {}), ...(b.level ? { level: b.level } : {}), ...(b.topic ? { topic: String(b.topic).slice(0, 80) } : {}) });
      store.finalizeAbandoned(b.resumeId ? String(b.resumeId) : null);
      let s;
      if (b.resumeId) {
        s = store.getSession(String(b.resumeId));
        if (!s) return send(res, 404, { error: 'session not found' });
        s.modeLog.push({ at: new Date().toISOString(), mode: settings.mode, input: settings.input, output: settings.output });
        s.endedAt = null; store.saveSession(s);
        return send(res, 200, { session: s, settings });
      }
      s = store.createSession({ mode: settings.mode, input: settings.input, output: settings.output, level: settings.level, topic: settings.topic });
      try { await turn(s.id, () => coachTurn(s, null, settings)); } catch (e) { return send(res, 502, { error: `Coach unavailable: ${e.message}`, session: s }); }
      return send(res, 200, { session: s, settings });
    }

    let mm;
    if ((mm = p.match(/^\/api\/session\/([a-z0-9-]+)(?:\/(message|mode|end))?$/))) {
      const s = store.getSession(mm[1]);
      if (!s) return send(res, 404, { error: 'session not found' });
      if (m === 'GET' && !mm[2]) return send(res, 200, { session: s });
      if (m === 'POST' && mm[2] === 'message') {
        const b = await readJson(req);
        const text = String(b.text || '').trim().slice(0, 1500);
        if (!text) return send(res, 400, { error: 'empty message' });
        const settings = store.getSettings();
        const inputMethod = b.inputMethod === 'voice' ? 'voice' : 'text';
        try {
          const out = await turn(s.id, async () => { const fresh = store.getSession(s.id); return { fresh, ...(await coachTurn(fresh, { text, inputMethod }, settings)) }; });
          return send(res, 200, { session: out.fresh, reply: out.reply });
        } catch (e) { return send(res, 502, { error: `Coach unavailable: ${e.message}` }); }
      }
      if (m === 'POST' && mm[2] === 'mode') {
        const b = await readJson(req);
        const settings = store.saveSettings({ mode: b.mode, input: b.input, output: b.output, ...(b.autoPlay !== undefined ? { autoPlay: b.autoPlay } : {}), ...(b.rate ? { rate: b.rate } : {}) });
        await turn(s.id, async () => { const f = store.getSession(s.id); f.modeLog.push({ at: new Date().toISOString(), mode: settings.mode, input: settings.input, output: settings.output }); store.saveSession(f); });
        return send(res, 200, { settings }); // history is untouched: same session continues across modes
      }
      if (m === 'POST' && mm[2] === 'end') {
        const out = await turn(s.id, async () => {
          const f = store.getSession(s.id);
          f.endedAt = new Date().toISOString(); store.saveSession(f);
          return store.writeSummary(f);
        });
        const syncResult = await sync.endSync(s.id);
        return send(res, 200, { summary: out.summary, sync: syncResult });
      }
    }

    if (m === 'POST' && p === '/api/sync') { const a = await sync.startSync(); const b = await sync.endSync(null); return send(res, 200, { pull: a, push: b }); }
    if (m === 'GET' && p === '/api/sync/status') return send(res, 200, await sync.status());

    // ---- voice (never reachable in text mode) ----
    if (p.startsWith('/api/voice/')) {
      if (store.getSettings().mode === 'text') return send(res, 403, { error: 'voice is disabled in text mode' });
      let vs;
      try { vs = loadVoice(); } catch (e) { return send(res, 503, { error: e.message }); }
      if (m === 'GET' && p === '/api/voice/status') return send(res, 200, await vs.status());
      if (m === 'POST' && p === '/api/voice/stt') {
        try { return send(res, 200, { text: await vs.transcribe(await readBody(req), (req.headers['content-type'] || 'audio/webm').split(';')[0]) }); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
      if (m === 'POST' && p === '/api/voice/tts') {
        const b = await readJson(req);
        const text = String(b.text || '').slice(0, 2000);
        if (!text) return send(res, 400, { error: 'empty text' });
        try { const a = await vs.synthesize(text); res.writeHead(200, { 'content-type': a.type, 'cache-control': 'no-store' }); return res.end(a.buf); }
        catch (e) { return send(res, 502, { error: e.message }); }
      }
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    // ---- static ----
    if (m !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end(); });
  });
  server.runStartSync = async () => { startSyncResult = await sync.startSync(); return startSyncResult; };
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4177); // avoids VoiceStudio's 3900/3902
  const server = createApp();
  server.listen(port, '127.0.0.1', async () => {
    console.log(`English Conversation Studio: http://127.0.0.1:${port}  (backend: ${process.env.COACH_BACKEND || 'claude-cli'})`);
    const r = await server.runStartSync();
    console.log(`[sync] ${r.message}`);
  });
}

module.exports = { createApp };
