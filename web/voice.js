'use strict';
// Loaded lazily by app.js ONLY when voice input or output is active. Text mode never executes this file.
// Engines:
//  - "voicestudio": local VoiceStudio via our loopback proxy (/api/voice/*). EXPERIMENTAL until verified on a real install.
//  - "browser":     Web Speech API. NOTE: Chrome/Edge speech recognition sends audio to the browser vendor's cloud service.
window.createVoice = async function createVoice(opts) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let vs = { available: false };
  try { vs = await opts.api('/api/voice/status'); } catch { /* proxy unavailable -> browser engine */ }
  const pref = opts.getSettings().voiceBackend;
  const useVS = vs.available && pref !== 'browser';
  const canSpeak = useVS || 'speechSynthesis' in window;
  const canListen = useVS ? !!(navigator.mediaDevices && window.MediaRecorder) : !!SR;

  const v = {
    engineLabel: useVS ? 'VoiceStudio (로컬)' : (SR || canSpeak ? '브라우저 음성 (STT는 클라우드)' : '음성 불가'),
    canListen, canSpeak, speaking: false, listening: false,
  };
  let stopRequested = false, rec = null, stream = null, recorder = null, chunks = [], audioEl = null, vadTimer = null, ctx = null, cancelled = false;

  const state = (t, r) => opts.onState(t, r);
  const settings = () => opts.getSettings();

  // ---- TTS ----
  v.speak = async function speak(text) {
    v.stopSpeaking(); await v.cancelListening(); // half-duplex: never listen while speaking
    if (!canSpeak) return opts.onError('음성 출력을 사용할 수 없습니다');
    v.speaking = true; state('재생 중…', false);
    const done = () => { v.speaking = false; state('대기', false); };
    try {
      if (useVS) {
        const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS HTTP ${r.status}`);
        const url = URL.createObjectURL(await r.blob());
        audioEl = new Audio(url); audioEl.playbackRate = settings().rate;
        audioEl.onended = audioEl.onerror = () => { URL.revokeObjectURL(url); done(); };
        await audioEl.play();
      } else {
        const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = settings().rate;
        const en = speechSynthesis.getVoices().find((x) => /^en(-|_)US/i.test(x.lang)); if (en) u.voice = en;
        u.onend = u.onerror = done; speechSynthesis.speak(u);
      }
    } catch (e) { done(); opts.onError(`음성 재생 실패: ${e.message}`); }
  };
  v.stopSpeaking = function stopSpeaking() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (v.speaking) { v.speaking = false; state('대기', false); }
  };

  // ---- STT ----
  v.startListening = async function startListening() {
    if (v.listening || v.speaking) return;
    if (!canListen) return opts.onError('음성 인식을 사용할 수 없습니다');
    cancelled = false; stopRequested = false; v.listening = true; state('듣는 중…', true);
    try { useVS ? await startRecorder() : startBrowserSR(); }
    catch (e) { v.listening = false; state('대기', false); opts.onError(e.name === 'NotAllowedError' ? '마이크 권한이 거부되었습니다' : `마이크 오류: ${e.message}`); }
  };
  v.stopListening = function stopListening() {
    if (!v.listening) return;
    if (settings().autoEnd) return; // auto end-of-speech detection owns the stop
    finishListening();
  };
  function finishListening() { stopRequested = true; if (rec) { try { rec.stop(); } catch { /* ignore */ } } if (recorder && recorder.state !== 'inactive') recorder.stop(); }
  v.cancelListening = async function cancelListening() {
    if (!v.listening) return;
    cancelled = true; if (rec) { try { rec.abort(); } catch { /* ignore */ } } if (recorder && recorder.state !== 'inactive') recorder.stop();
    cleanupMic(); v.listening = false; state('대기', false);
  };

  function startBrowserSR() {
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = (e) => { let t = ''; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) finalText = t; } opts.onText(t); };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') opts.onError(`음성 인식 오류: ${e.error}`); };
    rec.onend = () => { v.listening = false; state('대기', false); rec = null; if (!cancelled && finalText) opts.onFinal(finalText); };
    rec.start();
  }

  async function startRecorder() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    chunks = []; recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      cleanupMic(); v.listening = false;
      if (cancelled) return state('대기', false);
      state('인식 중…', false);
      try {
        const blob = new Blob(chunks, { type: recorder && recorder.mimeType || 'audio/webm' });
        const r = await fetch('/api/voice/stt', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || `STT HTTP ${r.status}`);
        opts.onText(j.text); opts.onFinal(j.text);
      } catch (e) { opts.onError(`음성 인식 실패: ${e.message}`); }
      state('대기', false);
    };
    recorder.start();
    if (stopRequested) return finishListening(); // button released while the mic permission/stream was still opening
    if (settings().autoEnd) startVad();
  }
  // Simple energy-based end-of-speech detection: stop 1.3s after speech was heard, or after 8s of nothing.
  function startVad() {
    ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize); let heard = false, quietSince = Date.now(); const t0 = Date.now();
    vadTimer = setInterval(() => {
      an.getByteTimeDomainData(buf); let s = 0; for (const b of buf) s += (b - 128) ** 2; const rms = Math.sqrt(s / buf.length);
      if (rms > 6) { heard = true; quietSince = Date.now(); }
      if ((heard && Date.now() - quietSince > 1300) || (!heard && Date.now() - t0 > 8000)) { clearInterval(vadTimer); finishListening(); }
    }, 100);
  }
  function cleanupMic() {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  v.dispose = function dispose() { v.stopSpeaking(); cancelled = true; if (rec) { try { rec.abort(); } catch { /* ignore */ } } if (recorder && recorder.state !== 'inactive') recorder.stop(); cleanupMic(); v.listening = false; };
  return v;
};
