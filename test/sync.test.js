'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sync = require('../server/sync');

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function mkClone(bare, name) {
  const d = path.join(path.dirname(bare), name);
  execFileSync('git', ['clone', '-q', bare, d], { stdio: 'ignore' });
  g(d, 'config', 'user.name', 't'); g(d, 'config', 'user.email', 't@t');
  return d;
}
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-sync-'));
  const bare = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const a = mkClone(bare, 'pcA');
  g(a, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(a, 'data/sync/sessions'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data/sync/sessions/.keep'), '');
  fs.writeFileSync(path.join(a, '.gitignore'), 'data/private/\n');
  g(a, 'add', '-A'); g(a, 'commit', '-qm', 'init'); g(a, 'push', '-q', '-u', 'origin', 'main');
  const b = mkClone(bare, 'pcB');
  return { base, bare, a, b };
}
const addSession = (dir, name) => fs.writeFileSync(path.join(dir, 'data/sync/sessions', name), JSON.stringify({ id: name }));

test('endSync stages only the allowlist, never stray or private files', async () => {
  const { a, bare } = setup();
  sync.setRoot(a);
  addSession(a, '2026-01-01_pcA_s1.json');
  fs.writeFileSync(path.join(a, 'stray.txt'), 'nope');
  fs.mkdirSync(path.join(a, 'data/private'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data/private/raw.json'), 'secret');
  const r = await sync.endSync('s1');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.pushed, true);
  const tracked = g(bare, 'ls-tree', '-r', '--name-only', 'main');
  assert.match(tracked, /data\/sync\/sessions\/2026-01-01_pcA_s1\.json/);
  assert.ok(!/stray|private/.test(tracked));
  assert.match(g(a, 'status', '--porcelain'), /stray\.txt/, 'stray file left untouched locally');
});

test('two PCs adding different session files merge without conflict', async () => {
  const { a, b } = setup();
  addSession(a, '2026-01-02_pcA_x.json'); sync.setRoot(a);
  assert.equal((await sync.endSync('x')).pushed, true);
  addSession(b, '2026-01-02_pcB_y.json'); sync.setRoot(b);
  const r = await sync.endSync('y'); // push rejected -> fetch + merge pull -> push
  assert.equal(r.ok, true, r.message);
  assert.equal(r.merged, true);
  assert.ok(fs.existsSync(path.join(b, 'data/sync/sessions/2026-01-02_pcA_x.json')));
});

test('startSync fast-forwards, and refuses (without touching files) when it cannot', async () => {
  const { a, b } = setup();
  sync.setRoot(a); addSession(a, 'p1.json'); await sync.endSync('p1');
  sync.setRoot(b);
  const ok = await sync.startSync();
  assert.equal(ok.ok, true, ok.message);
  assert.ok(fs.existsSync(path.join(b, 'data/sync/sessions/p1.json')));
  fs.writeFileSync(path.join(a, 'README.md'), 'A'); g(a, 'add', 'README.md'); g(a, 'commit', '-qm', 'A'); g(a, 'push', '-q');
  fs.writeFileSync(path.join(b, 'README.md'), 'B'); g(b, 'add', 'README.md'); g(b, 'commit', '-qm', 'B');
  const res = await sync.startSync();
  assert.equal(res.ok, false);
  assert.equal(res.needsAttention, true);
  assert.equal(fs.readFileSync(path.join(b, 'README.md'), 'utf8'), 'B', 'local change preserved');
});

test('conflicting end-sync merge is aborted and local data is preserved', async () => {
  const { a, b } = setup();
  sync.setRoot(a); fs.writeFileSync(path.join(a, 'README.md'), 'A'); g(a, 'add', 'README.md'); g(a, 'commit', '-qm', 'A'); g(a, 'push', '-q');
  sync.setRoot(b); fs.writeFileSync(path.join(b, 'README.md'), 'B'); g(b, 'add', 'README.md'); g(b, 'commit', '-qm', 'B');
  addSession(b, 'z.json');
  const r = await sync.endSync('z');
  assert.equal(r.ok, false);
  assert.equal(r.needsAttention, true);
  assert.equal(g(b, 'status', '--porcelain'), '', 'no merge in progress, no conflict markers');
  assert.equal(fs.readFileSync(path.join(b, 'README.md'), 'utf8'), 'B');
});

test('offline: commit stays local, reported as offline, later sync pushes it', async () => {
  const { a, bare } = setup();
  sync.setRoot(a);
  const moved = `${bare}.moved`; fs.renameSync(bare, moved);
  addSession(a, 'off.json');
  const r = await sync.endSync('off');
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  assert.equal(r.committed, true);
  const s = await sync.startSync();
  assert.equal(s.ok, false);
  assert.equal(s.offline, true);
  fs.renameSync(moved, bare);
  const again = await sync.endSync('off2');
  assert.equal(again.pushed, true, again.message);
  assert.match(g(bare, 'ls-tree', '-r', '--name-only', 'main'), /off\.json/);
});

test('no repo / no remote degrade gracefully', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-norepo-'));
  sync.setRoot(d);
  assert.equal((await sync.status()).state, 'no-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  g(d, 'config', 'user.name', 't'); g(d, 'config', 'user.email', 't@t');
  fs.mkdirSync(path.join(d, 'data/sync'), { recursive: true });
  fs.writeFileSync(path.join(d, 'data/sync/a.json'), '{}');
  const r = await sync.endSync('n');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.pushed, false);
  assert.equal(r.committed, true);
});

test('PC that created the repo (no upstream set) still pulls other PCs and merges', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-noup-'));
  const bare = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const a = path.join(base, 'pcA');
  execFileSync('git', ['init', '-q', '-b', 'main', a]);
  g(a, 'config', 'user.name', 't'); g(a, 'config', 'user.email', 't@t');
  g(a, 'remote', 'add', 'origin', bare); // like `gh repo create --source . --remote origin`: no -u
  fs.mkdirSync(path.join(a, 'data/sync/sessions'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data/sync/sessions/first.json'), '{}');
  g(a, 'add', '-A'); g(a, 'commit', '-qm', 'init'); g(a, 'push', 'origin', 'main'); // deliberately no -u
  const b = mkClone(bare, 'pcB');
  addSession(b, 'fromB.json'); g(b, 'add', '-A'); g(b, 'commit', '-qm', 'B'); g(b, 'push', '-q');
  sync.setRoot(a);
  const s = await sync.startSync();
  assert.equal(s.ok, true, s.message);
  assert.ok(fs.existsSync(path.join(a, 'data/sync/sessions/fromB.json')), 'startSync pulled the other PC data');
  // and the rejected-push path works without upstream too
  const c = mkClone(bare, 'pcC'); addSession(c, 'fromC.json'); g(c, 'add', '-A'); g(c, 'commit', '-qm', 'C'); g(c, 'push', '-q');
  addSession(a, 'fromA.json');
  const r = await sync.endSync('a');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.merged, true);
});
