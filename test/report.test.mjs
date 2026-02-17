import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, TOOL_ID, ConfigError } from '../src/index.mjs';

const policy = { schemaVersion: '1', audience: 'public', asOf: '2026-01-31', maxAgeDays: 30, stale: 'exclude' };
const source = (path, dataClass = 'public', reviewedOn = '2026-01-01') => ({ path, purpose: 'API guide', owner: 'docs-team', scope: 'REST API', dataClass, reviewedOn });
const manifest = (...sources) => ({ schemaVersion: '1', complete: true, sources });
const verified = (bytes, identity) => ({ bytes, identity, linkVerified: true });
const load = async path => verified(Buffer.from(`Document at ${path}`), path);

test('good public source is indexed with local link, declared metadata and content hash', async () => {
  const r = await buildIndex(manifest(source('docs/api.md')), policy, load);
  assert.equal(TOOL_ID, 'llms-docs-indexer');
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.findings, []);
  assert.equal(r.index.length, 1);
  assert.equal(r.index[0].link, 'docs/api.md');
  assert.equal(r.index[0].purpose, 'API guide');
  assert.match(r.index[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(r.index[0].freshness, 'current');
});

test('private source is excluded from a public index without leaking its path or hash', async () => {
  const r = await buildIndex(manifest(source('docs/public.md'), source('secrets/private.md', 'restricted')), policy, load);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.index.map(x => x.link), ['docs/public.md']);
  assert.equal(JSON.stringify(r).includes('secrets/private.md'), false);
  assert.equal(r.summary.excluded, 1);
});

test('excluded private source is never opened or checked for freshness', async () => {
  let opened = false;
  const privateSource = source('secrets/missing.md', 'restricted', '2026-02-01');
  const r = await buildIndex(manifest(privateSource), policy, async () => { opened = true; throw Error('should not read'); });
  assert.equal(r.status, 'pass'); assert.equal(r.summary.excluded, 1);
  assert.equal(opened, false); assert.deepEqual(r.index, []);
});

test('an all-private manifest records evaluated exclusions without claiming public content', async () => {
  const r = await buildIndex(manifest(source('private.md', 'restricted')), policy, async () => { throw Error('must not open'); });
  assert.equal(r.status, 'pass'); assert.equal(r.summary.checked, 1);
  assert.equal(r.summary.included, 0); assert.equal(r.summary.excluded, 1);
  assert.deepEqual(r.index, []);
});

test('stale source is not silently presented as current', async () => {
  const r = await buildIndex(manifest(source('docs/old.md', 'public', '2025-12-31')), policy, load);
  assert.equal(r.status, 'fail');
  assert.equal(r.index.length, 0);
  assert.equal(r.findings[0].ruleId, 'stale-source');
  const flagged = await buildIndex(manifest(source('docs/old.md', 'public', '2025-12-31')), { ...policy, stale: 'include-flagged' }, load);
  assert.equal(flagged.status, 'fail');
  assert.equal(flagged.index[0].freshness, 'stale');
});

test('stale-excluded source is reported without opening its content', async () => {
  let opened = false;
  const r = await buildIndex(manifest(source('docs/missing.md', 'public', '2025-12-31')), policy, async () => { opened = true; throw Error('should not read'); });
  assert.equal(r.status, 'fail'); assert.equal(r.findings[0].ruleId, 'stale-source');
  assert.equal(r.summary.excluded, 1); assert.equal(opened, false);
});

test('exact freshness boundary is accepted and one day beyond is stale', async () => {
  const at = await buildIndex(manifest(source('docs/at.md', 'public', '2026-01-01')), policy, load);
  const over = await buildIndex(manifest(source('docs/over.md', 'public', '2025-12-31')), policy, load);
  assert.equal(at.status, 'pass');
  assert.equal(over.status, 'fail');
});

test('unknown classification and missing source never pass', async () => {
  const unknown = await buildIndex(manifest(source('docs/x.md', 'unknown')), policy, load);
  assert.equal(unknown.status, 'incomplete');
  assert.equal(unknown.index.length, 0);
  const missing = await buildIndex(manifest(source('docs/x.md')), policy, async () => { throw Error('private path'); });
  assert.equal(missing.status, 'incomplete');
  assert.equal(JSON.stringify(missing).includes('private path'), false);
});

test('declared partial inventory is incomplete instead of an authoritative pass', async () => {
  const r = await buildIndex({ ...manifest(source('docs/x.md')), complete: false }, policy, load);
  assert.equal(r.status, 'incomplete');
  assert.equal(r.index.length, 0);
});

test('duplicate resolved document identity is incomplete', async () => {
  const r = await buildIndex(manifest(source('docs/a.md'), source('docs/alias.md')), policy, async () => verified(Buffer.from('same'), 'real/a.md'));
  assert.equal(r.status, 'incomplete');
  assert.equal(r.findings.some(x => x.ruleId === 'source-duplicate'), true);
});

test('library refuses unverified bare bytes and non-text content', async () => {
  const m = manifest(source('docs/not-proven.md'));
  const bare = await buildIndex(m, policy, async () => Buffer.from('fake document'));
  assert.equal(bare.status, 'incomplete'); assert.deepEqual(bare.index, []);
  const invalidUtf8 = await buildIndex(m, policy, async () => ({ bytes: Buffer.from([255]), identity: 'docs/not-proven.md', linkVerified: true }));
  assert.equal(invalidUtf8.status, 'incomplete'); assert.deepEqual(invalidUtf8.index, []);
  const nul = await buildIndex(m, policy, async () => ({ bytes: Buffer.from([65, 0, 66]), identity: 'docs/not-proven.md', linkVerified: true }));
  assert.equal(nul.status, 'incomplete'); assert.deepEqual(nul.index, []);
});

test('invalid policy is configuration error', async () => {
  await assert.rejects(buildIndex(manifest(source('docs/x.md')), { ...policy, audience: 'public', maxAgeDays: -1 }, load), ConfigError);
});

test('source count accepts 100 and rejects 101', async () => {
  const sources = Array.from({ length: 100 }, (_, i) => source(`docs/${i}.md`));
  const at = await buildIndex(manifest(...sources), policy, load);
  assert.equal(at.status, 'pass'); assert.equal(at.index.length, 100);
  sources.push(source('docs/extra.md'));
  const over = await buildIndex(manifest(...sources), policy, load);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'record-limit');
});

test('source byte limit accepts 262144 and rejects 262145', async () => {
  const at = await buildIndex(manifest(source('docs/x.md')), policy, async path => verified(Buffer.alloc(262_144, 65), path));
  assert.equal(at.status, 'pass');
  const over = await buildIndex(manifest(source('docs/x.md')), policy, async path => verified(Buffer.alloc(262_145, 65), path));
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'source-byte-limit');
});

test('total source byte limit accepts 4194304 and rejects 4194305', async () => {
  const sources = Array.from({ length: 16 }, (_, i) => source(`docs/${i}.md`));
  const at = await buildIndex(manifest(...sources), policy, async path => verified(Buffer.alloc(262_144, 65), path));
  assert.equal(at.status, 'pass'); assert.equal(at.index.length, 16);
  sources.push(source('docs/extra.md'));
  const over = await buildIndex(manifest(...sources), policy, async name => verified(Buffer.alloc(name === 'docs/extra.md' ? 1 : 262_144, 65), name));
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'total-byte-limit');
});

test('manifest nesting accepts depth 3 and rejects depth 4', async () => {
  const at = await buildIndex(manifest(source('docs/x.md')), policy, load);
  assert.equal(at.status, 'pass');
  const over = await buildIndex(manifest({ ...source('docs/x.md'), extra: { nested: true } }), policy, load);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'depth-limit');
});

test('evaluation clock accepts 5000 and rejects 5001 milliseconds', async () => {
  const clock = limit => { let first = true; return () => { if (first) { first = false; return 0; } return limit; }; };
  assert.equal((await buildIndex(manifest(source('docs/x.md')), policy, load, { now: clock(5000) })).status, 'pass');
  const over = await buildIndex(manifest(source('docs/x.md')), policy, load, { now: clock(5001) });
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'time-limit');
});

test('metadata length accepts 200 and rejects 201 UTF-16 units', async () => {
  const at = await buildIndex(manifest({ ...source('docs/x.md'), purpose: 'x'.repeat(200) }), policy, load);
  assert.equal(at.status, 'pass');
  const over = await buildIndex(manifest({ ...source('docs/x.md'), purpose: 'x'.repeat(201) }), policy, load);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'source-invalid');
});

test('path length accepts 256 and rejects 257 characters', async () => {
  const at = await buildIndex(manifest(source(`docs/${'x'.repeat(251)}`)), policy, load);
  assert.equal(at.status, 'pass');
  const over = await buildIndex(manifest(source(`docs/${'x'.repeat(252)}`)), policy, load);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'source-invalid');
});

test('review-age policy accepts 3650 and rejects 3651 days', async () => {
  assert.equal((await buildIndex(manifest(source('docs/x.md')), { ...policy, maxAgeDays: 3650 }, load)).status, 'pass');
  await assert.rejects(buildIndex(manifest(source('docs/x.md')), { ...policy, maxAgeDays: 3651 }, load), ConfigError);
});
