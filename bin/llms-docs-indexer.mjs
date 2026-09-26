#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { buildIndex, incomplete, ConfigError, LIMITS } from '../src/index.mjs';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Usage: llms-docs-indexer --root DIR --manifest FILE --policy FILE\nWrites one JSON report to stdout; reads only local files.\n');
} else {
  let root, manifestName, policyName;
  try {
    for (let i = 0; i < argv.length; i++) {
      const option = argv[i];
      if (!['--root', '--manifest', '--policy'].includes(option) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ConfigError('Invalid option');
      const value = argv[++i];
      if (option === '--root') { if (root) throw new ConfigError('Repeated root'); root = value; }
      if (option === '--manifest') { if (manifestName) throw new ConfigError('Repeated manifest'); manifestName = value; }
      if (option === '--policy') { if (policyName) throw new ConfigError('Repeated policy'); policyName = value; }
    }
    if (!root || !manifestName || !policyName || isAbsolute(manifestName) || isAbsolute(policyName)) throw new ConfigError('Root and relative input paths required');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new ConfigError('Root must be a directory');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }

  const inside = file => { const rel = relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  async function confined(name, limit) {
    const file = await realpath(resolve(root, name));
    if (!inside(file)) throw new Error('outside-root');
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error('invalid-file');
    if (metadata.size > limit) throw new Error('byte-limit');
    const bytes = await readFile(file, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > limit) throw new Error('byte-limit');
    return { bytes, file };
  }
  async function json(name, limit) {
    const { bytes } = await confined(name, limit);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  let policy;
  try {
    policy = await json(policyName, LIMITS.policyBytes);
    // Validate configuration before interpreting subject evidence.
    await buildIndex({ schemaVersion: '1', complete: true, sources: [] }, policy, async () => new Uint8Array());
  } catch { process.stderr.write('Policy cannot be read or is invalid.\n'); process.exit(2); }

  let result;
  try {
    const manifest = await json(manifestName, LIMITS.manifestBytes);
    result = await buildIndex(manifest, policy, async name => {
      const { bytes, file } = await confined(name, LIMITS.sourceBytes);
      return { bytes, identity: file, linkVerified: true };
    });
  } catch {
    result = incomplete('manifest-unreadable', 'Manifest could not be read, decoded, or parsed within the declared root.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
