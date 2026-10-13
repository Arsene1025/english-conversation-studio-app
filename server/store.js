'use strict';
// Local persistence.
//   data/private/  (gitignored)  raw sessions, settings, machine id  -> never leaves this PC
//   data/sync/     (git-synced)  sanitized per-session summaries     -> one file per session, so PCs never collide
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const DATA = process.env.ENGLISH_DATA_DIR || path.resolve(__dirname, '..', 'data');
const PRIVATE = path.join(DATA, 'private');
const SYNC = path.join(DATA, 'sync');
const RAW = path.join(PRIVATE, 'sessions');
const SUMMARIES = path.join(SYNC, 'sessions');

const DEFAULT_SETTINGS = { mode: 'text', input: 'text', output: 'text', autoPlay: true, rate: 1, voiceBackend: 'auto', autoEnd: false, level: 'B1', topic: 'daily life' };
const MODES = ['text', 'voice', 'mixed'];
const METHODS = ['text', 'voice'];

function ensure() { for (const d of [PRIVATE, RAW, SUMMARIES]) fs.mkdirSync(d, { recursive: true }); }

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function machineId() {
  ensure();
  const f = path.join(PRIVATE, 'machine.json');
  let m = readJson(f, null);
  if (!m) {
    m = { id: `${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'pc'}-${crypto.randomBytes(2).toString('hex')}` };
    writeJson(f, m);
  }
  return m.id;
}

// ---- settings -------------------------------------------------------------
function normalizeSettings(s) {
  const o = { ...DEFAULT_SETTINGS, ...(s || {}) };
  if (!MODES.includes(o.mode)) o.mode = 'text';
  if (o.mode === 'text') { o.input = 'text'; o.output = 'text'; }
  else if (o.mode === 'voice') { o.input = 'voice'; o.output = 'voice'; }
  else { if (!METHODS.includes(o.input)) o.input = 'text'; if (!METHODS.includes(o.output)) o.output = 'text'; }
  o.rate = Math.min(2, Math.max(0.5, Number(o.rate) || 1));
  o.autoPlay = o.autoPlay !== false;
  o.autoEnd = o.autoEnd === true;
  return o;
}
function getSettings() { ensure(); return normalizeSettings(readJson(path.join(PRIVATE, 'settings.json'), {})); }
function saveSettings(patch) {
  ensure();
  const next = normalizeSettings({ ...getSettings(), ...patch });
  writeJson(path.join(PRIVATE, 'settings.json'), next);
  return next;
}

// ---- sessions -------------------------------------------------------------
const safeId = (id) => /^[a-z0-9-]{6,64}$/.test(id);

function createSession({ mode, input, output, level, topic }) {
  ensure();
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const s = {
    id, machine: machineId(), startedAt: new Date().toISOString(), endedAt: null,
    level, topic, levelEstimate: null, turns: [], modeLog: [{ at: new Date().toISOString(), mode, input, output }],
  };
  writeJson(path.join(RAW, `${id}.json`), s);
  return s;
}
function getSession(id) { if (!safeId(id)) return null; return readJson(path.join(RAW, `${id}.json`), null); }
function saveSession(s) { writeJson(path.join(RAW, `${s.id}.json`), s); }
function listSessions() {
  ensure();
  return fs.readdirSync(RAW).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(RAW, f), null)).filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, topic: s.topic, level: s.level, turns: s.turns.length }));
}
// Sessions whose tab was closed never got /end. Finalize them (summary uses the last turn time) so nothing is lost from sync.
function finalizeAbandoned(exceptId) {
  const done = [];
  for (const meta of listSessions()) {
    if (meta.endedAt || meta.id === exceptId) continue;
    const s = getSession(meta.id);
    if (!s) continue;
    const users = s.turns.filter((t) => t.role === 'user');
    s.endedAt = (s.turns.at(-1) && s.turns.at(-1).at) || s.startedAt;
    saveSession(s);
    if (users.length) { writeSummary(s); done.push(s.id); }
  }
  return done;
}
function openSession() { const l = listSessions().find((s) => !s.endedAt); return l ? getSession(l.id) : null; }

// ---- sanitizing for sync ---------------------------------------------------
function sanitize(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .slice(0, 300);
}

function summarize(s) {
  const end = s.endedAt ? new Date(s.endedAt) : new Date();
  const modeTurns = { text: 0, voice: 0 };
  for (const t of s.turns) if (t.role === 'user') modeTurns[t.inputMethod === 'voice' ? 'voice' : 'text']++;
  const usedModes = [...new Set(s.modeLog.map((m) => m.mode))];
  const errors = [];
  const vocab = new Map();
  for (const t of s.turns) {
    if (t.role !== 'coach') continue;
    for (const c of t.corrections || []) {
      errors.push({ kind: c.kind, tag: c.tag, original: sanitize(c.original), corrected: sanitize(c.corrected), natural: sanitize(c.natural), explanation_ko: sanitize(c.explanation_ko) });
    }
    for (const v of t.vocab || []) vocab.set(v.phrase.toLowerCase(), { phrase: sanitize(v.phrase), meaning_ko: sanitize(v.meaning_ko) });
  }
  const userTurns = s.turns.filter((t) => t.role === 'user').length;
  return {
    schema: 1, id: s.id, date: s.startedAt.slice(0, 10), machine: s.machine,
    startedAt: s.startedAt, endedAt: s.endedAt || end.toISOString(),
    durationMin: Math.round((end - new Date(s.startedAt)) / 6000) / 10,
    modes: usedModes, userTurnsByInput: modeTurns, topic: s.topic, level: s.level, levelEstimate: s.levelEstimate,
    userTurns, grammarErrors: errors.filter((e) => e.kind === 'grammar').length,
    errors, vocab: [...vocab.values()],
  };
}

function writeSummary(s) {
  ensure();
  const sum = summarize(s);
  const file = path.join(SUMMARIES, `${sum.date}_${sum.machine}_${sum.id}.json`);
  writeJson(file, sum);
  return { summary: sum, file: path.relative(path.resolve(DATA, '..'), file).replace(/\\/g, '/') };
}

function loadSummaries() {
  ensure();
  return fs.readdirSync(SUMMARIES).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(SUMMARIES, f), null)).filter(Boolean)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// Aggregated at read time from all per-session files (from every PC), so there is no shared mutable progress file.
function progress() {
  const sums = loadSummaries();
  const tags = new Map();
  const vocab = new Map();
  let minutes = 0;
  for (const s of sums) {
    minutes += s.durationMin || 0;
    for (const e of s.errors) {
      if (e.kind !== 'grammar') continue;
      const t = tags.get(e.tag) || { tag: e.tag, count: 0, sessions: new Set(), example: e };
      t.count++; t.sessions.add(s.id); t.example = e; tags.set(e.tag, t);
    }
    for (const v of s.vocab) vocab.set(v.phrase.toLowerCase(), { ...v, lastSeen: s.date });
  }
  const recurring = [...tags.values()].map((t) => ({ tag: t.tag, count: t.count, sessions: t.sessions.size, example: t.example }))
    .sort((a, b) => b.count - a.count);
  const lastWithLevel = [...sums].reverse().find((s) => s.levelEstimate);
  const reviewVocab = [...vocab.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 20);
  return {
    sessionCount: sums.length, totalMinutes: Math.round(minutes),
    levelEstimate: lastWithLevel ? lastWithLevel.levelEstimate : null,
    recurring: recurring.slice(0, 10), reviewVocab,
    recentSessions: sums.slice(-5).reverse().map((s) => ({ id: s.id, date: s.date, topic: s.topic, modes: s.modes, durationMin: s.durationMin, userTurns: s.userTurns, grammarErrors: s.grammarErrors })),
  };
}

// Short strings the coach should weave into the next conversation.
function reviewTargets(n = 3) {
  const p = progress();
  const t = p.recurring.filter((r) => r.count >= 2).slice(0, 2).map((r) => `grammar pattern "${r.tag}" (e.g. "${r.example.original}" -> "${r.example.corrected}")`);
  const v = p.reviewVocab.slice(0, 2).map((x) => `phrase "${x.phrase}"`);
  return [...t, ...v].slice(0, n);
}

module.exports = {
  DATA, PRIVATE, SYNC, DEFAULT_SETTINGS, MODES, getSettings, saveSettings, normalizeSettings, machineId,
  createSession, finalizeAbandoned, getSession, saveSession, listSessions, openSession, summarize, writeSummary, loadSummaries, progress, reviewTargets, sanitize, safeId,
};
