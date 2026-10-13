'use strict';
// Server-less helpers used by sync.ps1 / status.ps1:  node server/cli.js status | sync
const sync = require('./sync');
const store = require('./store');

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const st = await sync.status();
    const p = store.progress();
    console.log(`Git      : ${st.state} - ${st.message}${st.dirtySync ? ` (${st.dirtySync} unsynced study file(s))` : ''}`);
    console.log(`Backend  : ${process.env.COACH_BACKEND || 'claude-cli'}`);
    console.log(`Machine  : ${store.machineId()}`);
    console.log(`Sessions : ${p.sessionCount} synced summaries, ${p.totalMinutes} min, level ${p.levelEstimate || '-'}`);
    const s = store.getSettings();
    console.log(`Last mode: ${s.mode} (input=${s.input}, output=${s.output})`);
    try {
      const r = await fetch('http://127.0.0.1:3900/.well-known/voicestudio-speech', { signal: AbortSignal.timeout(1500) });
      console.log(`VoiceStudio: ${r.ok ? 'running' : `HTTP ${r.status}`}`);
    } catch { console.log('VoiceStudio: not running (text mode works; browser voice is the fallback)'); }
  } else if (cmd === 'sync') {
    const a = await sync.startSync(); console.log(`pull: ${a.message}`);
    const b = await sync.endSync(null); console.log(`push: ${b.message}`);
    process.exitCode = a.needsAttention || (!b.ok && !b.offline) ? 1 : 0;
  } else {
    console.log('usage: node server/cli.js status|sync'); process.exitCode = 2;
  }
})();
