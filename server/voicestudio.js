'use strict';
// Loopback-only client for a locally running VoiceStudio (default http://127.0.0.1:3900).
// Documented by VoiceStudio:  GET /.well-known/voicestudio-speech, POST /v1/audio/transcriptions (OpenAI-compatible),
//                             MCP tool `generate_speech` at /mcp/ (JSON-RPC over Streamable HTTP).
// NOT documented (so discovered at runtime / best effort): the multipart field names for STT, the text
// parameter name of generate_speech. These paths are EXPERIMENTAL until verified against a real install.
const BASE = (process.env.VOICESTUDIO_URL || 'http://127.0.0.1:3900').replace(/\/$/, '');
const KEY = process.env.OMNIVOICE_API_KEY || '';

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE) && !process.env.VOICESTUDIO_ALLOW_REMOTE) {
  throw new Error('VOICESTUDIO_URL must be loopback (set VOICESTUDIO_ALLOW_REMOTE=1 to override)');
}

const headers = (extra = {}) => ({ ...(KEY ? { authorization: `Bearer ${KEY}` } : {}), ...extra });

async function timed(url, init = {}, ms = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function status() {
  try {
    const r = await timed(`${BASE}/.well-known/voicestudio-speech`, { headers: headers() }, 1500);
    if (!r.ok) return { available: false, reason: `HTTP ${r.status}` };
    return { available: true, base: BASE, discovery: await r.json().catch(() => ({})) };
  } catch (e) { return { available: false, reason: 'VoiceStudio not running' }; }
}

async function transcribe(buf, contentType = 'audio/webm', language = 'en') {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: contentType }), contentType.includes('wav') ? 'speech.wav' : 'speech.webm');
  form.append('language', language);
  const r = await timed(`${BASE}/v1/audio/transcriptions`, { method: 'POST', headers: headers(), body: form }, 60000);
  if (!r.ok) throw new Error(`VoiceStudio STT HTTP ${r.status}`);
  const j = await r.json();
  if (typeof j.text !== 'string') throw new Error('VoiceStudio STT: unexpected response shape');
  return j.text.trim();
}

// ---- minimal MCP client (Streamable HTTP) ----
let mcpSession = null;
let textParam = null;
async function rpc(method, params, id) {
  const r = await timed(`${BASE}/mcp/`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) }),
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }),
  }, 60000);
  if (!r.ok) throw new Error(`MCP ${method} HTTP ${r.status}`);
  const sid = r.headers.get('mcp-session-id'); if (sid) mcpSession = sid;
  if (!id) return null;
  const body = await r.text();
  let json;
  if ((r.headers.get('content-type') || '').includes('event-stream')) {
    const line = body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop();
    json = JSON.parse(line);
  } else json = JSON.parse(body);
  if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
  return json.result;
}
function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.startsWith('{')) { try { const r = findKey(JSON.parse(v), key); if (r) return r; } catch { /* not json */ } }
    const r = findKey(v, key); if (r) return r;
  }
  return null;
}
async function synthesize(text) {
  if (!mcpSession) {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'english-conversation-studio', version: '1.0' } }, 1);
    await rpc('notifications/initialized', {});
  }
  if (!textParam) {
    const list = await rpc('tools/list', {}, 2);
    const tool = (list.tools || []).find((t) => t.name === 'generate_speech');
    if (!tool) throw new Error('VoiceStudio MCP has no generate_speech tool');
    const props = Object.keys((tool.inputSchema || {}).properties || {});
    textParam = ['text', 'input', 'prompt', 'content'].find((p) => props.includes(p)) || (tool.inputSchema.required || [])[0];
    if (!textParam) throw new Error('Cannot determine generate_speech text parameter');
  }
  const res = await rpc('tools/call', { name: 'generate_speech', arguments: { [textParam]: text, language: 'English', format: 'wav' } }, 3);
  const b64 = findKey(res, 'wav_base64') || findKey(res, 'data');
  if (b64) return { buf: Buffer.from(b64, 'base64'), type: 'audio/wav' };
  const url = findKey(res, 'audio_url');
  if (url) {
    const r = await timed(url.startsWith('http') ? url : `${BASE}${url}`, { headers: headers() }, 30000);
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'audio/wav' };
  }
  throw new Error('generate_speech returned no audio');
}

module.exports = { status, transcribe, synthesize, BASE };
