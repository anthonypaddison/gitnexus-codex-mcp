import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareLiveFreshness } from '../../src/core/contexts/live-freshness.js';

describe('live repository freshness', () => {
  let directory: string;
  let root: string;
  let initial: string;

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Freshness Test', '-c', 'user.email=freshness@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  const commit = (cwd: string, message: string): string => {
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-live-freshness-')));
    root = path.join(directory, 'live');
    await fs.mkdir(root);
    git(root, '-c', 'init.templateDir=', 'init', '--quiet', '--initial-branch=main');
    initial = commit(root, 'initial');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reports the same committed HEAD as current', async () => {
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'current', liveHead: initial });
  });

  it('counts commits behind in the live graph', async () => {
    commit(root, 'second');
    const head = commit(root, 'third');
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'behind', liveHead: head, commitsBehind: 2 });
  });

  it('reports an index ahead of live as ahead/diverged', async () => {
    const indexed = commit(root, 'indexed');
    git(root, 'checkout', '--quiet', '--detach', initial);
    expect(await compareLiveFreshness(indexed, root)).toEqual({ status: 'ahead/diverged', liveHead: initial });
  });

  it('reports divergent history without a misleading behind count', async () => {
    const indexed = commit(root, 'indexed branch');
    git(root, 'checkout', '--quiet', '--detach', initial);
    const head = commit(root, 'live branch');
    expect(await compareLiveFreshness(indexed, root)).toEqual({ status: 'ahead/diverged', liveHead: head });
  });

  it('uses live history even when the snapshot still matches the indexed revision', async () => {
    const snapshot = path.join(directory, 'snapshot');
    await fs.cp(root, snapshot, { recursive: true });
    const head = commit(root, 'live only');
    expect(await compareLiveFreshness(initial, snapshot)).toEqual({ status: 'current', liveHead: initial });
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'behind', liveHead: head, commitsBehind: 1 });
  });

  it('returns unknown when the explicit live mapping or indexed revision is missing', async () => {
    expect(await compareLiveFreshness(initial, undefined)).toEqual({ status: 'unknown' });
    expect(await compareLiveFreshness(undefined, root)).toEqual({ status: 'unknown', liveHead: initial });
    expect(await compareLiveFreshness('HEAD', root)).toEqual({ status: 'unknown', liveHead: initial });
  });

  it('rejects missing and non-Git paths and a nested working directory', async () => {
    const plain = path.join(directory, 'plain');
    const nested = path.join(root, 'nested');
    await fs.mkdir(plain);
    await fs.mkdir(nested);
    for (const candidate of [path.join(directory, 'missing'), plain, nested]) {
      expect(await compareLiveFreshness(initial, candidate)).toEqual({ status: 'unknown' });
    }
  });

  it('requires a canonical absolute root rather than a symlink or relative alias', async () => {
    const alias = path.join(directory, 'alias');
    await fs.symlink(root, alias);
    for (const candidate of [alias, path.relative(process.cwd(), root), root + path.sep]) {
      expect(await compareLiveFreshness(initial, candidate)).toEqual({ status: 'unknown' });
    }
  });

  it('does not inherit environment variables redirecting Git to another repository', async () => {
    const other = path.join(directory, 'other');
    await fs.cp(root, other, { recursive: true });
    const head = commit(root, 'live change');
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'behind', liveHead: head, commitsBehind: 1 });
  });

  it('returns unknown for a missing indexed object', async () => {
    expect(await compareLiveFreshness('0'.repeat(40), root)).toEqual({ status: 'unknown', liveHead: initial });
  });

  it('does not fetch a missing indexed object from a configured promisor remote', async () => {
    const source = path.join(directory, 'source');
    await fs.cp(root, source, { recursive: true });
    const indexed = commit(source, 'remote only');
    git(root, 'config', 'remote.origin.url', source);
    git(root, 'config', 'remote.origin.promisor', 'true');
    git(root, 'config', 'extensions.partialClone', 'origin');
    const packs = await fs.readdir(path.join(root, '.git', 'objects', 'pack'));
    expect(await compareLiveFreshness(indexed, root)).toEqual({ status: 'unknown', liveHead: initial });
    expect(await fs.readdir(path.join(root, '.git', 'objects', 'pack'))).toEqual(packs);
  });

  it('does not infer divergent ancestry from a shallow boundary', async () => {
    const head = commit(root, 'shallow head');
    await fs.writeFile(path.join(root, '.git', 'shallow'), head + '\n');
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'unknown', liveHead: head });
    expect(await compareLiveFreshness(head, root)).toEqual({ status: 'current', liveHead: head });
  });

  it('returns unknown when ancestry is incomplete despite both endpoint objects existing', async () => {
    const middle = commit(root, 'middle');
    const head = commit(root, 'head');
    await fs.unlink(path.join(root, '.git', 'objects', middle.slice(0, 2), middle.slice(2)));
    expect(await compareLiveFreshness(initial, root)).toEqual({ status: 'unknown', liveHead: head });
  });

  it('ignores replacement refs that would fabricate a current live ancestry', async () => {
    const indexed = commit(root, 'indexed branch');
    git(root, 'checkout', '--quiet', '--detach', initial);
    const head = commit(root, 'live branch');
    git(root, 'replace', head, indexed);
    expect(await compareLiveFreshness(indexed, root)).toEqual({ status: 'ahead/diverged', liveHead: head });
  });
});
