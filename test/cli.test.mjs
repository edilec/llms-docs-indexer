import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/llms-docs-indexer.mjs', import.meta.url).pathname;
const policy = { schemaVersion: '1', audience: 'public', asOf: '2026-01-31', maxAgeDays: 30, stale: 'exclude' };
const manifest = { schemaVersion: '1', complete: true, sources: [{ path: 'docs/guide.md', purpose: 'Guide', owner: 'docs-team', scope: 'Local API', dataClass: 'public', reviewedOn: '2026-01-01' }] };
async function fixture(fn, source = manifest, config = policy) {
  const root = await mkdtemp(join(tmpdir(), 'docs-index-'));
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'docs')));
    await writeFile(join(root, 'docs/guide.md'), '# Guide\n');
    await writeFile(join(root, 'manifest.json'), typeof source === 'string' ? source : JSON.stringify(source));
    await writeFile(join(root, 'policy.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const run = (root, extra = []) => spawnSync(process.execPath, [cli, '--root', root, '--manifest', 'manifest.json', '--policy', 'policy.json', ...extra], { encoding: 'utf8', maxBuffer: 4_194_304 });

test('good local documentation produces a passing index whose link exists', async () => {
  await fixture(async root => {
    const p = run(root); assert.equal(p.status, 0); const r = JSON.parse(p.stdout);
    assert.equal(r.status, 'pass'); assert.equal(r.index[0].link, 'docs/guide.md');
  });
});
test('malformed manifest is incomplete without echoing its content', async () => {
  await fixture(async root => {
    const p = run(root); assert.equal(p.status, 2); const r = JSON.parse(p.stdout);
    assert.equal(r.status, 'incomplete'); assert.equal(p.stdout.includes('secret-sentinel'), false);
  }, 'secret-sentinel');
});
test('invalid policy exits two with empty stdout', async () => {
  await fixture(async root => { const p = run(root); assert.equal(p.status, 2); assert.equal(p.stdout, ''); }, manifest, { ...policy, maxAgeDays: -1 });
});
test('missing documentation remains incomplete and never emits a dead link', async () => {
  await fixture(async root => {
    const p = run(root); assert.equal(p.status, 2); const r = JSON.parse(p.stdout);
    assert.equal(r.status, 'incomplete'); assert.deepEqual(r.index, []);
  }, { ...manifest, sources: [{ ...manifest.sources[0], path: 'docs/missing.md' }] });
});

test('public index excludes missing private source without opening it', async () => {
  const sources = [...manifest.sources, { ...manifest.sources[0], path: 'secrets/missing.md', dataClass: 'restricted', reviewedOn: '2026-02-01' }];
  await fixture(async root => {
    const p = run(root); assert.equal(p.status, 0); const r = JSON.parse(p.stdout);
    assert.equal(r.status, 'pass'); assert.equal(r.summary.excluded, 1);
    assert.equal(p.stdout.includes('secrets/missing.md'), false);
  }, { ...manifest, sources });
});

test('stale excluded source fails without needing its missing content', async () => {
  await fixture(async root => {
    const p = run(root); assert.equal(p.status, 1); const r = JSON.parse(p.stdout);
    assert.equal(r.status, 'fail'); assert.equal(r.findings[0].ruleId, 'stale-source');
    assert.deepEqual(r.index, []);
  }, { ...manifest, sources: [{ ...manifest.sources[0], path: 'docs/missing.md', reviewedOn: '2025-12-31' }] });
});
test('source symlink outside the declared root is refused', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'docs-index-out-'));
  try {
    await writeFile(join(outside, 'private.md'), 'private-sentinel');
    await fixture(async root => {
      await symlink(join(outside, 'private.md'), join(root, 'docs/linked.md'));
      const p = run(root); assert.equal(p.status, 2); const r = JSON.parse(p.stdout);
      assert.equal(r.status, 'incomplete'); assert.deepEqual(r.index, []);
      assert.equal(p.stdout.includes('private-sentinel'), false);
    }, { ...manifest, sources: [{ ...manifest.sources[0], path: 'docs/linked.md' }] });
  } finally { await rm(outside, { recursive: true, force: true }); }
});
test('explicit partial manifest cannot claim an authoritative pass', async () => {
  await fixture(async root => { const p = run(root); assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).status, 'incomplete'); }, { ...manifest, complete: false });
});

test('manifest byte bound accepts 262144 and rejects 262145', async () => {
  const base = JSON.stringify(manifest), exact = base + ' '.repeat(262_144 - Buffer.byteLength(base));
  await fixture(async root => { const p = run(root); assert.equal(p.status, 0); }, exact);
  await fixture(async root => { const p = run(root); assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).findings[0].ruleId, 'manifest-unreadable'); }, exact + ' ');
});

test('policy byte bound accepts 65536 and rejects 65537 with empty stdout', async () => {
  const base = JSON.stringify(policy), exact = base + ' '.repeat(65_536 - Buffer.byteLength(base));
  await fixture(async root => { const p = run(root); assert.equal(p.status, 0); }, manifest, exact);
  await fixture(async root => { const p = run(root); assert.equal(p.status, 2); assert.equal(p.stdout, ''); }, manifest, exact + ' ');
});

test('document byte bound accepts 262144 and rejects 262145', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'docs/guide.md'), 'x'.repeat(262_144));
    assert.equal(run(root).status, 0);
    await writeFile(join(root, 'docs/guide.md'), 'x'.repeat(262_145));
    const over = run(root); assert.equal(over.status, 2);
    assert.equal(JSON.parse(over.stdout).findings[0].ruleId, 'source-byte-limit');
  });
});
