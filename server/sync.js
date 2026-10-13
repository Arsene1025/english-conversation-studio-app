'use strict';
// Safe git sync. Never force-pushes, never hard-resets, never `git add -A`.
// Only the allowlist below is ever staged.
const { execFile } = require('node:child_process');
const path = require('node:path');

let ROOT = process.env.ENGLISH_REPO_DIR || path.resolve(__dirname, '..');
const ALLOWLIST = ['data/sync', 'CLAUDE.md', '.claude/skills', 'README.md'];

function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: opts.timeout || 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}

async function status() {
  const inRepo = (await git(['rev-parse', '--is-inside-work-tree'])).out === 'true';
  if (!inRepo) return { state: 'no-repo', message: 'Git 저장소가 아닙니다 (setup.ps1 실행 필요)' };
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  const remote = (await git(['remote', 'get-url', 'origin'])).out;
  const porcelain = (await git(['status', '--porcelain'])).out;
  const dirtySync = porcelain.split('\n').filter((l) => l && /data\/sync\//.test(l)).length;
  let ahead = 0, behind = 0;
  if (remote) {
    const c = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]); // not @{upstream}: works before tracking is set
    if (c.ok) [ahead, behind] = c.out.split(/\s+/).map(Number);
  }
  return {
    state: remote ? 'ready' : 'no-remote', branch, remote, ahead, behind, dirty: porcelain ? porcelain.split('\n').length : 0, dirtySync,
    message: remote ? `${branch} · ahead ${ahead} / behind ${behind}` : 'GitHub 원격 저장소가 아직 연결되지 않았습니다 (로컬 기록은 정상 저장됨)',
  };
}

// Run on app start: fetch, then fast-forward only. Anything else is reported, not "fixed".
async function startSync() {
  const st = await status();
  if (st.state !== 'ready') return { ok: false, skipped: true, reason: st.state, message: st.message };
  const f = await git(['fetch', 'origin'], { timeout: 30000 });
  if (!f.ok) return { ok: false, offline: true, message: `오프라인이거나 fetch 실패 — 로컬 기록으로 계속합니다 (${f.err.split('\n')[0]})` };
  const after = await status();
  if (!after.behind) return { ok: true, message: '이미 최신 상태입니다', status: after };
  const p = await git(['pull', '--ff-only', 'origin', after.branch]); // explicit args: immune to user pull.* config
  if (p.ok) return { ok: true, message: `GitHub에서 ${after.behind}개 커밋을 가져왔습니다`, status: await status() };
  return { ok: false, needsAttention: true, message: `자동 병합 불가 (fast-forward 아님). 로컬 변경은 그대로 유지됩니다. 수동 확인 필요: ${p.err.split('\n')[0]}` };
}

// Run at session end: stage allowlist only, commit, merge-if-needed, push.
async function endSync(sessionId) {
  const st = await status();
  if (st.state === 'no-repo') return { ok: false, committed: false, message: st.message };
  const existing = [];
  for (const p of ALLOWLIST) {
    const r = await git(['ls-files', '--others', '--modified', '--exclude-standard', '--', p]);
    if (r.out) existing.push(p);
  }
  let committed = false;
  if (existing.length) {
    const add = await git(['add', '--', ...existing]);
    if (!add.ok) return { ok: false, committed: false, message: `stage 실패: ${add.err}` };
    const staged = await git(['diff', '--cached', '--quiet']);
    if (!staged.ok) {
      const c = await git(['commit', '-m', sessionId ? `study: session ${sessionId} summary` : 'study: sync records']);
      if (!c.ok) return { ok: false, committed: false, message: `commit 실패: ${c.err || c.out}` };
      committed = true;
    }
  }
  if (st.state === 'no-remote') return { ok: true, committed, pushed: false, message: committed ? '로컬 커밋 완료 (원격 미연결 — push 생략)' : '변경 없음' };
  let push = await git(['push', '-u', 'origin', 'HEAD'], { timeout: 60000 });
  if (push.ok) return { ok: true, committed, pushed: true, message: committed ? 'GitHub에 동기화했습니다' : '변경 없음 (최신 상태)' };
  // Rejected or offline. Try a plain merge pull (distinct per-session files => normally conflict-free).
  const fetch = await git(['fetch', 'origin'], { timeout: 30000 });
  if (!fetch.ok) return { ok: false, committed, pushed: false, offline: true, message: '오프라인 — 로컬에 커밋됨. 연결되면 sync로 다시 push됩니다' };
  const pull = await git(['pull', '--no-rebase', '--no-ff', '--no-edit', 'origin', st.branch]);
  if (!pull.ok) {
    await git(['merge', '--abort']); // restores the pre-merge state; nothing is overwritten
    return { ok: false, committed, pushed: false, needsAttention: true, message: `병합 충돌 — 자동 병합을 취소했고 로컬 데이터는 그대로입니다. 수동 해결 필요: ${pull.err.split('\n')[0]}` };
  }
  push = await git(['push', '-u', 'origin', 'HEAD'], { timeout: 60000 });
  return push.ok
    ? { ok: true, committed, pushed: true, merged: true, message: '다른 PC의 기록과 병합 후 동기화했습니다' }
    : { ok: false, committed, pushed: false, message: `push 실패: ${push.err.split('\n')[0]}` };
}

module.exports = { status, startSync, endSync, ALLOWLIST, setRoot: (r) => { ROOT = r; } };
