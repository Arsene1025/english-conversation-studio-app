'use strict';
// Text-first client. voice.js is loaded lazily, only when a voice input/output is actually active.
const $ = (id) => document.getElementById(id);
const S = { settings: null, session: null, state: null, voice: null, busy: false, lastCoach: '' };

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const needsVoice = (s) => s.input === 'voice' || s.output === 'voice';

function notice(msg, kind) {
  const n = $('notice'); n.textContent = msg || ''; n.classList.toggle('hidden', !msg);
  n.style.color = kind === 'bad' ? 'var(--bad)' : '';
}

// ---------- start screen ----------
function renderStart() {
  const st = S.state, s = S.settings;
  for (const b of document.querySelectorAll('#modePick button')) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
  $('mixedPick').classList.toggle('hidden', s.mode !== 'mixed');
  $('inPick').value = s.input; $('outPick').value = s.output;
  $('levelPick').value = s.level; setTopicUi(s.topic);
  $('btnResume').classList.toggle('hidden', !st.open);
  if (st.open) $('btnResume').textContent = `기존 학습 이어하기 (${st.open.topic}, ${st.open.turns}턴)`;
  const sy = st.sync, b = $('syncBadge');
  b.textContent = `GitHub: ${sy.state === 'ready' ? (st.startSync && st.startSync.offline ? '오프라인' : '연결됨') : sy.state === 'no-remote' ? '미연결' : '저장소 없음'}`;
  b.className = 'badge ' + (sy.state === 'ready' ? 'ok' : 'warn'); b.title = (st.startSync && st.startSync.message) || sy.message;
  const p = st.progress, box = $('progress'); box.textContent = '';
  if (!p.sessionCount) { box.textContent = '아직 완료된 학습이 없습니다. 첫 세션을 시작해 보세요!'; return; }
  box.append(el('div', null, `총 ${p.sessionCount}회 · ${p.totalMinutes}분 · 추정 수준 ${p.levelEstimate || '-'}`));
  if (p.recurring.length) {
    box.append(el('h3', null, '자주 반복하는 실수 (복습 대상)'));
    for (const r of p.recurring.slice(0, 5)) box.append(el('div', null, `• ${r.tag} ×${r.count} — "${r.example.original}" → "${r.example.corrected}"`));
  }
  if (p.reviewVocab.length) { box.append(el('h3', null, '복습할 표현')); box.append(el('div', null, p.reviewVocab.slice(0, 8).map((v) => v.phrase).join(' · '))); }
}

async function refresh() {
  S.state = await api('/api/state'); S.settings = S.state.settings; renderStart();
}

function setTopicUi(topic) {
  const sel = $('topicPick');
  const known = [...sel.options].some((o) => o.value === topic && o.value !== '__custom__');
  sel.value = known ? topic : '__custom__';
  if (!known) $('topicCustom').value = topic;
  $('topicCustomWrap').classList.toggle('hidden', known);
}
$('topicPick').addEventListener('change', () => $('topicCustomWrap').classList.toggle('hidden', $('topicPick').value !== '__custom__'));

function pickedTopic() {
  if ($('topicPick').value !== '__custom__') return $('topicPick').value;
  return $('topicCustom').value.trim().slice(0, 80) || 'daily life';
}

function pickedSettings() {
  const mode = document.querySelector('#modePick [aria-checked=true]').dataset.mode;
  return { mode, input: $('inPick').value, output: $('outPick').value, level: $('levelPick').value, topic: pickedTopic() };
}

async function startSession(resumeId) {
  $('startMsg').textContent = resumeId ? '이어서 불러오는 중…' : 'Claude가 첫 질문을 준비하고 있어요…';
  $('btnNew').disabled = true;
  try {
    const r = await api('/api/session/start', { ...pickedSettings(), resumeId });
    S.session = r.session; S.settings = r.settings;
    enterChat();
  } catch (e) { $('startMsg').textContent = `시작 실패: ${e.message}`; }
  finally { $('btnNew').disabled = false; }
}

// ---------- chat ----------
function enterChat() {
  $('start').classList.add('hidden'); $('chat').classList.remove('hidden');
  $('log').textContent = ''; $('corrBody').textContent = '내가 쓴 문장에 대한 교정이 여기에 표시됩니다.'; $('vocabBody').textContent = '-';
  S.session.turns.forEach((t, i) => addMsg(t, i === S.session.turns.length - 1 && t.role === 'coach' ? 'auto' : 'quiet'));
  applyMode(false);
}

function addMsg(t, playMode) {
  const m = el('div', `msg ${t.role}`);
  m.append(el('div', null, t.text));
  const tools = el('div', 'tools');
  const copy = el('button', null, '복사'); copy.onclick = () => navigator.clipboard.writeText(t.text).then(() => { copy.textContent = '복사됨'; setTimeout(() => (copy.textContent = '복사'), 1200); }).catch(() => {});
  tools.append(copy);
  if (t.role === 'user') {
    const edit = el('button', null, '다시 편집'); edit.onclick = () => { $('input').value = t.text; $('input').focus(); }; tools.append(edit);
    if (t.inputMethod === 'voice') m.append(el('div', 'tag', '🎙️ 음성 인식 결과'));
  } else {
    const again = el('button', null, '🔁 듣기'); again.onclick = () => speak(t.text, true); again.className = 'speakbtn'; tools.append(again);
    S.lastCoach = t.text;
  }
  m.append(tools); $('log').append(m); $('log').scrollTop = $('log').scrollHeight;
  if (t.role === 'coach') {
    if (t.corrections) showCorrections(t.corrections, t.vocab, t.stt_note_ko);
    if (playMode === 'auto' && S.settings.output === 'voice' && S.settings.autoPlay) speak(t.text, false);
  }
  syncControls();
}

// The corrections panel always belongs to the learner's PREVIOUS message, so label it that way.
function showCorrections(list, vocab, sttNote) {
  const box = $('corrBody'); box.textContent = '';
  const lastUser = [...S.session.turns].reverse().find((x) => x.role === 'user');
  if (!lastUser) box.textContent = '첫 질문에 답하면 교정이 표시됩니다.';
  else {
    box.append(el('div', 'muted', `내 문장: "${lastUser.text}"`));
    if (sttNote || lastUser.stt_suspect) box.append(el('div', 'warn-note', `⚠️ 음성 인식 오류일 수 있어요. ${sttNote || ''} 문장을 확인/수정해 주세요.`));
    if (!list.length) box.append(el('div', 'ok-note', '교정할 부분이 없어요 — 잘했어요! ✅'));
    for (const c of list) {
      const d = el('div', `corr ${c.kind}`);
      d.append(el('div', 'k', c.kind === 'grammar' ? '문법 오류' : '더 자연스럽게 (스타일)'));
      const o = el('div'); o.append(el('s', null, c.original), document.createTextNode(' → '), el('span', 'fix', c.corrected)); d.append(o);
      if (c.natural && c.natural !== c.corrected) { const n = el('div'); n.append('자연스러운 표현: ', el('span', 'nat', c.natural)); d.append(n); }
      d.append(el('div', 'muted', c.explanation_ko)); box.append(d);
    }
  }
  const vb = $('vocabBody'); vb.textContent = '';
  if (!vocab || !vocab.length) vb.textContent = '-';
  else for (const v of vocab) vb.append(el('div', null, `• ${v.phrase} — ${v.meaning_ko}`));
}

async function send(text, inputMethod) {
  if (S.busy || !text.trim()) return;
  S.busy = true; syncControls(); notice('');
  await stopVoice();
  addMsg({ role: 'user', text: text.trim(), inputMethod }, 'quiet');
  const thinking = el('div', 'msg coach muted', 'Claude가 생각 중…'); $('log').append(thinking); $('log').scrollTop = $('log').scrollHeight;
  try {
    const r = await api(`/api/session/${S.session.id}/message`, { text, inputMethod });
    thinking.remove();
    // The user bubble was already added optimistically; drop it from the stored list view and re-render the last coach turn only.
    S.session = r.session;
    $('input').value = ''; $('sttHint').classList.add('hidden');
    addMsg(S.session.turns[S.session.turns.length - 1], 'auto');
  } catch (e) {
    thinking.remove(); notice(`응답 실패: ${e.message} — 입력은 그대로 두었어요. 다시 전송해 보세요.`, 'bad');
    // roll back optimistic bubble so a retry doesn't duplicate
    const last = $('log').querySelector('.msg.user:last-of-type'); if (last) last.remove();
  } finally { S.busy = false; syncControls(); $('input').focus(); }
}

// ---------- mode switching ----------
async function applyMode(persist) {
  const sel = { mode: $('modeSwitch').value || S.settings.mode };
  if (!persist) { $('modeSwitch').value = S.settings.mode; $('inSwitch').value = S.settings.input; $('outSwitch').value = S.settings.output; $('autoPlay').checked = S.settings.autoPlay; $('rate').value = S.settings.rate; $('autoEnd').checked = S.settings.autoEnd; }
  else {
    await stopVoice(); await stopRecording(); // clean up playback/recording BEFORE switching
    const r = await api(`/api/session/${S.session.id}/mode`, { mode: sel.mode, input: $('inSwitch').value, output: $('outSwitch').value, autoPlay: $('autoPlay').checked, rate: Number($('rate').value) });
    S.settings = r.settings;
    $('modeSwitch').value = S.settings.mode; $('inSwitch').value = S.settings.input; $('outSwitch').value = S.settings.output;
  }
  $('mixedInline').classList.toggle('hidden', S.settings.mode !== 'mixed');
  $('rateOut').textContent = `${Number($('rate').value).toFixed(1)}×`;
  if (needsVoice(S.settings)) await ensureVoice(); else teardownVoice();
  syncControls();
}

function syncControls() {
  const s = S.settings; if (!s) return;
  const voiceIn = s.input === 'voice', voiceOut = s.output === 'voice';
  $('voiceBar').classList.toggle('hidden', !needsVoice(s));
  $('btnMic').classList.toggle('hidden', !voiceIn);
  $('micState').classList.toggle('hidden', !voiceIn);
  $('autoEnd').parentElement.classList.toggle('hidden', !voiceIn);
  for (const id of ['btnStop', 'btnReplay', 'rate', 'rateOut']) $(id).classList.toggle('hidden', !voiceOut);
  $('autoPlay').parentElement.classList.toggle('hidden', !voiceOut);
  $('rate').parentElement.classList.toggle('hidden', !voiceOut);
  for (const b of document.querySelectorAll('.speakbtn')) b.classList.toggle('hidden', !voiceOut && !S.voice);
  $('btnSend').disabled = S.busy; $('input').disabled = S.busy;
  if (S.voice) $('btnMic').disabled = S.busy || S.voice.speaking;
  $('input').placeholder = voiceIn ? '마이크로 말하거나, 직접 입력해도 됩니다' : '영어로 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)';
}

// ---------- voice (lazy) ----------
async function ensureVoice() {
  if (S.voice) return;
  try {
    await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/voice.js'; sc.onload = res; sc.onerror = () => rej(new Error('voice.js load failed')); document.head.append(sc); });
    S.voice = await window.createVoice({
      getSettings: () => S.settings, api,
      onState: (t, rec) => { $('micState').textContent = t; $('btnMic').classList.toggle('rec', !!rec); syncControls(); },
      onText: (t) => { $('input').value = t; $('sttHint').classList.remove('hidden'); $('input').focus(); },
      onFinal: (t) => { if (S.settings.autoEnd && t.trim()) send(t, 'voice'); },
      onError: (m) => notice(`${m} — 텍스트 모드로 계속 사용할 수 있어요.`, 'bad'),
    });
    $('voiceEngine').textContent = S.voice.engineLabel; $('voiceEngine').className = 'badge ' + (S.voice.canListen || S.voice.canSpeak ? 'ok' : 'bad');
    if (!S.voice.canListen && S.settings.input === 'voice') notice('이 브라우저/환경에서는 음성 인식을 쓸 수 없어요. 텍스트로 입력해 주세요.', 'bad');
  } catch (e) { notice(`음성 기능을 사용할 수 없습니다: ${e.message}. 텍스트 모드는 정상 동작합니다.`, 'bad'); }
}
function teardownVoice() { if (S.voice) { S.voice.dispose(); S.voice = null; } }
async function stopVoice() { if (S.voice) S.voice.stopSpeaking(); }
async function stopRecording() { if (S.voice) await S.voice.cancelListening(); }
function speak(text, force) { if (S.voice && (force || S.settings.output === 'voice')) S.voice.speak(text); else if (force) ensureVoice().then(() => S.voice && S.voice.speak(text)); }

// ---------- end session ----------
async function endSession() {
  $('btnEnd').disabled = true; await stopVoice(); await stopRecording(); teardownVoice();
  notice('학습 내용을 요약하고 동기화하는 중…');
  try {
    const r = await api(`/api/session/${S.session.id}/end`, {});
    const sy = r.sync;
    alert(`세션 종료\n· ${r.summary.userTurns}턴 · ${r.summary.durationMin}분 · 문법 오류 ${r.summary.grammarErrors}개\n· 동기화: ${sy.ok ? '✅' : '⚠️'} ${sy.message}`);
  } catch (e) { alert(`종료 처리 실패: ${e.message}\n로컬 기록은 유지됩니다.`); }
  S.session = null; $('btnEnd').disabled = false; notice('');
  $('chat').classList.add('hidden'); $('start').classList.remove('hidden'); await refresh();
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', async () => {
  for (const b of document.querySelectorAll('#modePick button')) b.onclick = () => { for (const x of document.querySelectorAll('#modePick button')) x.setAttribute('aria-checked', String(x === b)); $('mixedPick').classList.toggle('hidden', b.dataset.mode !== 'mixed'); };
  $('btnNew').onclick = () => startSession();
  $('btnResume').onclick = () => startSession(S.state.open.id);
  $('modeSwitch').onchange = () => applyMode(true);
  $('inSwitch').onchange = () => { $('modeSwitch').value = 'mixed'; applyMode(true); };
  $('outSwitch').onchange = () => { $('modeSwitch').value = 'mixed'; applyMode(true); };
  $('autoPlay').onchange = () => api(`/api/session/${S.session.id}/mode`, { mode: S.settings.mode, input: S.settings.input, output: S.settings.output, autoPlay: $('autoPlay').checked }).then((r) => (S.settings = r.settings));
  $('autoEnd').onchange = () => api('/api/settings', { autoEnd: $('autoEnd').checked }).then((r) => (S.settings = r.settings));
  $('rate').oninput = () => { $('rateOut').textContent = `${Number($('rate').value).toFixed(1)}×`; };
  $('rate').onchange = () => api('/api/settings', { rate: Number($('rate').value) }).then((r) => (S.settings = r.settings));
  $('btnEnd').onclick = endSession;
  $('btnStop').onclick = () => stopVoice();
  $('btnReplay').onclick = () => S.lastCoach && speak(S.lastCoach, true);
  $('form').onsubmit = (e) => { e.preventDefault(); send($('input').value, S.voiceDraft ? 'voice' : 'text'); S.voiceDraft = false; };
  $('input').addEventListener('input', () => { /* edited text is still the voice draft, but flagged as user-corrected */ });
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); } });
  const mic = $('btnMic');
  const down = (e) => { e.preventDefault(); if (S.voice && !mic.disabled) { S.voiceDraft = true; S.voice.startListening(); } };
  const up = () => { if (S.voice) S.voice.stopListening(); };
  mic.addEventListener('pointerdown', down); mic.addEventListener('pointerup', up); mic.addEventListener('pointerleave', up);
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && document.activeElement === mic) down(e); });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && document.activeElement === mic) up(); });
  try { await refresh(); } catch (e) { $('startMsg').textContent = `서버 연결 실패: ${e.message}`; }
});
