import { createHash } from 'node:crypto';

export const TOOL_ID = 'llms-docs-indexer';
export const LIMITS = Object.freeze({ manifestBytes: 262_144, policyBytes: 65_536, sourceBytes: 262_144, totalBytes: 4_194_304, sources: 100, depth: 3, milliseconds: 5_000 });
export const RULE_SEVERITY = Object.freeze({ 'manifest-invalid': 'error', 'manifest-partial': 'error', 'manifest-unreadable': 'error', 'source-invalid': 'error', 'source-unreadable': 'error', 'source-duplicate': 'error', 'source-unknown': 'error', 'source-future': 'error', 'source-byte-limit': 'error', 'total-byte-limit': 'error', 'record-limit': 'error', 'depth-limit': 'error', 'time-limit': 'error', 'stale-source': 'error' });
const INCOMPLETE = new Set(Object.keys(RULE_SEVERITY).filter(x => x !== 'stale-source'));
const forbidden = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\p{Cf}]/u;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const exactKeys = (x, keys) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 200 && x === x.trim() && !forbidden.test(x);
const path = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && /^[A-Za-z0-9._/-]+$/.test(x) && !x.startsWith('/') && x.split('/').every(s => s !== '' && s !== '.' && s !== '..');
function day(x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x; }
function depthExceeded(value, depth = 0) { if (depth > LIMITS.depth) return true; return value && typeof value === 'object' && Object.values(value).some(x => depthExceeded(x, depth + 1)); }

export class ConfigError extends Error {}
function policyOf(raw) {
  if (!record(raw) || !exactKeys(raw, ['schemaVersion', 'audience', 'asOf', 'maxAgeDays', 'stale']) || raw.schemaVersion !== '1' || !['public', 'internal'].includes(raw.audience) || !day(raw.asOf) || !Number.isInteger(raw.maxAgeDays) || raw.maxAgeDays < 0 || raw.maxAgeDays > 3650 || !['exclude', 'include-flagged'].includes(raw.stale)) throw new ConfigError('Invalid index policy');
  return raw;
}
function add(findings, ruleId, pointer, message) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  findings.push({ ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file: '@manifest', pointer } });
}
function report(findings, index, checked, excluded) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  index.sort((a, b) => cmp(a.link, b.link));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.length ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, included: index.length, excluded, errors: findings.length, warnings: 0 }, findings, index };
}
export function incomplete(ruleId, message) { const findings = []; add(findings, ruleId, '', message); return report(findings, [], 0, 0); }

export async function buildIndex(manifest, rawPolicy, loadSource, { now = () => performance.now() } = {}) {
  const started = now(), policy = policyOf(rawPolicy), findings = [], index = [], seen = new Set();
  if (!record(manifest) || !exactKeys(manifest, ['schemaVersion', 'complete', 'sources']) || manifest.schemaVersion !== '1' || !Array.isArray(manifest.sources) || manifest.sources.length === 0) return incomplete('manifest-invalid', 'A version 1 manifest with a nonempty source list is required.');
  if (manifest.complete !== true) return incomplete('manifest-partial', 'Manifest does not declare complete source evidence.');
  if (depthExceeded(manifest)) return incomplete('depth-limit', 'Manifest exceeds nesting depth 3.');
  if (manifest.sources.length > LIMITS.sources) return incomplete('record-limit', 'Manifest exceeds 100 sources.');
  if (typeof loadSource !== 'function') throw new ConfigError('A source loader is required');
  let checked = 0, excluded = 0, totalBytes = 0;
  for (const [i, source] of manifest.sources.entries()) {
    const pointer = `/sources/${i}`;
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Indexing exceeded 5000 milliseconds.');
    if (!record(source) || !exactKeys(source, ['path', 'purpose', 'owner', 'scope', 'dataClass', 'reviewedOn']) || !path(source.path) || !text(source.purpose) || !text(source.owner) || !text(source.scope) || !day(source.reviewedOn)) { add(findings, 'source-invalid', pointer, 'Source metadata is unusable.'); continue; }
    if (!['public', 'internal', 'restricted'].includes(source.dataClass)) { add(findings, 'source-unknown', `${pointer}/dataClass`, 'Source permission class is unknown.'); continue; }
    const allowed = source.dataClass === 'public' || (policy.audience === 'internal' && source.dataClass === 'internal');
    if (!allowed) { excluded++; continue; }
    const ageDays = (Date.parse(`${policy.asOf}T00:00:00Z`) - Date.parse(`${source.reviewedOn}T00:00:00Z`)) / 86_400_000;
    if (ageDays < 0) { add(findings, 'source-future', `${pointer}/reviewedOn`, 'Review date is after the declared as-of date.'); continue; }
    const stale = ageDays > policy.maxAgeDays;
    if (stale) add(findings, 'stale-source', `${pointer}/reviewedOn`, 'Source review age exceeds the policy limit.');
    if (stale && policy.stale === 'exclude') { excluded++; continue; }
    let loaded;
    try { loaded = await loadSource(source.path); } catch (error) { add(findings, error?.message === 'byte-limit' ? 'source-byte-limit' : 'source-unreadable', pointer, error?.message === 'byte-limit' ? 'Source exceeds 262144 bytes.' : 'Source could not be read within the declared root.'); continue; }
    const bytes = loaded?.bytes;
    const identity = loaded?.identity;
    if (!(bytes instanceof Uint8Array) || typeof identity !== 'string' || !identity || loaded?.linkVerified !== true) { add(findings, 'source-unreadable', pointer, 'Source link was not verified within the declared root.'); continue; }
    checked++;
    if (bytes.length > LIMITS.sourceBytes) { add(findings, 'source-byte-limit', pointer, 'Source exceeds 262144 bytes.'); continue; }
    try { if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\u0000')) throw new Error('NUL'); }
    catch { add(findings, 'source-unreadable', pointer, 'Source is not usable UTF-8 text.'); continue; }
    totalBytes += bytes.length;
    if (totalBytes > LIMITS.totalBytes) return incomplete('total-byte-limit', 'Source data exceeds 4194304 total bytes.');
    if (seen.has(identity)) { add(findings, 'source-duplicate', pointer, 'Source resolves to a duplicate document.'); continue; }
    seen.add(identity);
    index.push({ link: source.path, purpose: source.purpose, owner: source.owner, scope: source.scope, dataClass: source.dataClass, reviewedOn: source.reviewedOn, freshness: stale ? 'stale' : 'current', sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Indexing exceeded 5000 milliseconds.');
  return report(findings, index, checked, excluded);
}
