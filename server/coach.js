'use strict';
// Coach engine: builds the prompt, calls an LLM backend, validates the structured reply.
// Backends: "claude-cli" (headless `claude -p`, uses the logged-in Claude Code account)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAX_CORRECTIONS = 3;

const SCHEMA = {
  type: 'object',
  properties: {
    reply_en: { type: 'string', description: 'Natural English reply. This is the ONLY text that is read aloud.' },
    question: { type: 'string', description: 'The single follow-up question (already included at the end of reply_en).' },
    corrections: {
      type: 'array', maxItems: MAX_CORRECTIONS,
      items: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          corrected: { type: 'string', description: 'Grammatically fixed sentence/phrase' },
          natural: { type: 'string', description: 'More natural spoken phrasing (may equal corrected)' },
          kind: { type: 'string', enum: ['grammar', 'style'] },
          tag: { type: 'string', description: 'Short English label of the error pattern, e.g. "past tense irregular", "articles"' },
          explanation_ko: { type: 'string', description: 'Brief Korean explanation' },
        },
        required: ['original', 'corrected', 'kind', 'tag', 'explanation_ko'],
      },
    },
    stt_suspect: { type: 'boolean', description: 'True if the learner text looks like a speech-recognition error' },
    stt_note_ko: { type: 'string' },
    vocab: {
      type: 'array', maxItems: 4,
      items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_ko: { type: 'string' } }, required: ['phrase', 'meaning_ko'] },
    },
    level_estimate: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
  },
  required: ['reply_en', 'corrections'],
};

function loadSkillRules() {
  try {
    const p = path.join(ROOT, '.claude', 'skills', 'english-coach', 'SKILL.md');
    return fs.readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  } catch { return ''; }
}

function systemPrompt() {
  return `You are an English conversation partner and coach for a Korean-speaking learner.
Your output is ONE JSON object matching the provided schema. Nothing else.

Conversation rules:
- Speak like a real native speaker in casual conversation, not like a textbook.
- Ask exactly ONE question per turn, at the end of reply_en. Keep reply_en short (1-3 sentences) so it sounds natural when read aloud.
- Match the learner's level; simplify when they struggle, stretch when they are comfortable.
- Support varied topics: daily life, travel, hobbies, games, programming, etc.
- On the very first turn (no learner message yet), greet briefly and ask one opening question on the chosen topic.
- If review targets are given, weave ONE of them into the conversation naturally; never announce "this is a review".

Correction rules (corrections[]):
- At most ${MAX_CORRECTIONS} items, only the most important. Return [] if the sentence is fine. Never invent errors in a correct sentence.
- kind="grammar" for real errors; kind="style" for optional naturalness improvements. Keep them distinct.
- "corrected" = minimal grammatical fix; "natural" = how a native would say it.
- explanation_ko = brief, plain Korean. tag = short English pattern label (reuse the same label for the same pattern).
- If the learner message came from SPEECH RECOGNITION, do NOT correct capitalization/punctuation, and do NOT treat likely mis-hearings (homophones, odd word substitutions) as grammar errors; set stt_suspect=true with a short Korean stt_note_ko instead. Never rate pronunciation.
- vocab: up to 4 useful words/phrases from this exchange with Korean meanings.
- level_estimate: your running CEFR estimate of the learner.

Coaching style reference (from the english-coach skill; the output FORMAT below overrides its markdown layout):
${loadSkillRules()}

Overrides: the learner is Korean (ignore the "Chinese speakers" tip); at most ${MAX_CORRECTIONS} corrections (not 5); do not use the markdown layout above; explanations are in Korean; there is no separate "Learn something new" section (use vocab instead).`;
}

function buildUserPrompt({ history, level, topic, review, newInput }) {
  const lines = [];
  lines.push(`Learner level (self-selected): ${level}`);
  lines.push(`Topic: ${topic}`);
  if (review && review.length) lines.push(`Review targets (recurring mistakes / phrases to revisit naturally): ${review.join('; ')}`);
  lines.push('', '--- Conversation so far ---');
  if (!history.length) lines.push('(none yet)');
  for (const t of history) {
    lines.push(t.role === 'user' ? `Learner: ${t.text}` : `Coach: ${t.text}`);
  }
  lines.push('--- End ---', '');
  if (newInput) {
    const via = newInput.inputMethod === 'voice' ? 'SPEECH RECOGNITION (may contain recognition errors)' : 'typed keyboard text';
    lines.push(`New learner message (source: ${via}):`, newInput.text);
  } else {
    lines.push('There is no learner message yet. Start the conversation.');
  }
  return lines.join('\n');
}

function clean(s, max = 1000) { return typeof s === 'string' ? s.trim().slice(0, max) : ''; }

function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const corrections = (Array.isArray(o.corrections) ? o.corrections : []).slice(0, MAX_CORRECTIONS).map((c) => ({
    original: clean(c.original, 400),
    corrected: clean(c.corrected, 400),
    natural: clean(c.natural, 400) || clean(c.corrected, 400),
    kind: c.kind === 'style' ? 'style' : 'grammar',
    tag: clean(c.tag, 60).toLowerCase() || 'other',
    explanation_ko: clean(c.explanation_ko, 600),
  })).filter((c) => c.original && c.corrected && c.original !== c.corrected);
  return {
    reply_en: clean(o.reply_en, 2000),
    question: clean(o.question, 500),
    corrections,
    stt_suspect: o.stt_suspect === true,
    stt_note_ko: clean(o.stt_note_ko, 300),
    vocab: (Array.isArray(o.vocab) ? o.vocab : []).slice(0, 4)
      .map((v) => ({ phrase: clean(v.phrase, 80), meaning_ko: clean(v.meaning_ko, 120) })).filter((v) => v.phrase),
    level_estimate: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(o.level_estimate) ? o.level_estimate : null,
  };
}

// ---- backends -------------------------------------------------------------

function callClaudeCli(prompt, { model = process.env.COACH_MODEL || 'sonnet', exe = process.env.CLAUDE_EXE || 'claude', timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
      '--system-prompt', systemPrompt(), '--tools', '', '--setting-sources', '', '--model', model, '--no-session-persistence'];
    // cwd defaults to a neutral dir so the developer CLAUDE.md of this repo is not loaded.
    const neutral = cwd || path.join(require('node:os').tmpdir(), 'english-studio-neutral');
    fs.mkdirSync(neutral, { recursive: true });
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // force subscription login
    const p = spawn(exe, args, { cwd: neutral, windowsHide: true, env });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude CLI timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude CLI not runnable: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(`claude CLI error: ${String(j.result).slice(0, 300)}`));
        let data = j.structured_output;
        if (!data && typeof j.result === 'string') {
          try { data = JSON.parse(j.result); } catch { data = { reply_en: j.result, corrections: [] }; }
        }
        resolve({ data, meta: { cost_usd: j.total_cost_usd, backend: 'claude-cli' } });
      } catch (e) { reject(new Error(`bad claude CLI output: ${e.message}`)); }
    });
    p.stdin.end(prompt);
  });
}

function pickBackend() { return callClaudeCli; }

// `backend` may be injected (tests use a fake).
async function respond(ctx, backend = pickBackend()) {
  const prompt = buildUserPrompt(ctx);
  const { data, meta } = await backend(prompt);
  const reply = normalize(data);
  if (!reply.reply_en) throw new Error('Coach returned an empty reply');
  return { reply, meta };
}

module.exports = { SCHEMA, systemPrompt, buildUserPrompt, normalize, respond, callClaudeCli, MAX_CORRECTIONS };
