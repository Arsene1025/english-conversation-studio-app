# English Conversation Studio — project notes for Claude Code

Local web app (Node, zero npm dependencies) for English practice with Claude: text, voice, or mixed.

## Run / test
- `scripts\start.cmd` (or `node server/index.js`) → http://127.0.0.1:4177
- `npm test` → `node --test "test/*.test.js"` (uses a fake coach + temp git repos; never touches real data)
- `node server/cli.js status|sync`

## Architecture (keep these boundaries)
- `server/coach.js` — prompt + JSON schema + backend (`claude-cli` only = `claude -p` headless with `--tools "" --setting-sources ""` in a neutral cwd; API-key backend intentionally removed and ANTHROPIC_API_KEY is stripped from the child env so usage stays on the subscription). History is stored by us and resent every turn (no `--resume`), so mode switches and multi-PC restores don't depend on CLI session state.
- Coach output is structured: `reply_en` (the ONLY thing spoken by TTS), `corrections[]` (max 3, `kind` grammar|style, Korean explanations, screen only), `stt_suspect`, `vocab`, `level_estimate`.
- `server/store.js` — `data/private/` (gitignored: raw sessions, settings, machine id) vs `data/sync/sessions/` (sanitized per-session summaries, one file per session so PCs never conflict). Progress/review is aggregated at read time.
- `server/sync.js` — git sync. NEVER force-push, hard-reset, or `git add -A`; stage only the allowlist; abort merges on conflict.
- `server/voicestudio.js` — optional, loopback-only VoiceStudio client. Loaded lazily; `/api/voice/*` returns 403 in text mode.
- `web/voice.js` — loaded lazily by `web/app.js` only when input or output is voice. Text mode must never call getUserMedia/SpeechRecognition/speechSynthesis (a test enforces this).

## Rules
- Text mode must work with no VoiceStudio, no mic, no models.
- Do not invent VoiceStudio APIs. Documented: `/.well-known/voicestudio-speech`, `POST /v1/audio/transcriptions`, MCP tool `generate_speech` at `/mcp/`. Undocumented details (multipart field names, text param) are discovered/best-effort and marked EXPERIMENTAL.
- Never commit secrets, audio, or raw transcripts. Don't modify global `~/.claude` settings.
- `.ps1` files are UTF-8 with BOM (Windows PowerShell 5.1); keep it that way.
- Speech-recognition errors are not grammar errors; never score pronunciation.
