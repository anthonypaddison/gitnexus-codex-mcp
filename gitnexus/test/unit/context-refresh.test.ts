import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadContextConfig, saveContextConfig, validateRepositoryRoot } from '../../src/core/contexts/config.js';
import { refreshContextRepository, type RefreshDependencies, type RefreshStage } from '../../src/core/contexts/refresh.js';

const suite = process.platform === 'darwin' ? describe : describe.skip;
suite('manual context refresh', () => {
  let directory: string;
  let parent: string;
  let old: string;
  let live: string;
  let policy: string;
  let original: Buffer;
  let head: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd, encoding: 'utf8', timeout: 5000 }).trim();

  const commit = (cwd: string) => {
    git(cwd, 'commit', '--allow-empty', '-qm', 'fixture');
    return git(cwd, 'rev-parse', 'HEAD');
  };

  async function markReady(root: string, revision: string) {
    const index = path.join(root, '.gitnexus');
    await fs.mkdir(index, { mode: 0o700 });
    await fs.writeFile(path.join(index, 'meta.json'), JSON.stringify({ repoPath: root, lastCommit: revision }), { mode: 0o600 });
    await fs.writeFile(path.join(index, 'lbug'), 'synthetic index marker', { mode: 0o600 });
  }

  const buildIndex = (stage: RefreshStage) => markReady(stage.root, stage.head);
  const verifyQuery = async () => {};
  const refresh = (options: { alias?: string; expectHead?: string } = {}, overrides: Partial<RefreshDependencies> = {}) =>
    refreshContextRepository({ alias: 'selected', expectHead: head, configFile: policy, ...options }, { buildIndex, verifyQuery, ...overrides });

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-refresh-test-')));
    parent = path.join(directory, 'approved');
    old = path.join(parent, 'previous');
    live = path.join(directory, 'live');
    policy = path.join(directory, 'contexts.yaml');
    await fs.mkdir(old, { recursive: true, mode: 0o700 });
    git(old, '-c', 'init.templateDir=', 'init', '-q');
    await fs.writeFile(path.join(old, 'source.ts'), 'export const ready = true;\n');
    git(old, 'add', 'source.ts');
    await markReady(old, commit(old));
    git(directory, 'clone', '-q', '--no-hardlinks', old, live);
    head = commit(live);
    const other = path.join(parent, 'other');
    git(directory, 'clone', '-q', '--no-hardlinks', old, other);
    await saveContextConfig({
      version: 1, parent, activeContext: 'active', contexts: { active: ['selected'], other: ['other'] },
      repositories: {
        selected: { root: old, liveRoot: live, identity: await validateRepositoryRoot(old, parent) },
        other: { root: other, identity: await validateRepositoryRoot(other, parent) },
      },
    }, policy);
    original = Buffer.concat([Buffer.from('# must survive rollback\n'), await fs.readFile(policy)]);
    await fs.writeFile(policy, original);
  });

  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  async function expectOriginal() {
    expect(await fs.readFile(policy)).toEqual(original);
    expect(await fs.readdir(parent)).toEqual(expect.arrayContaining(['other', 'previous']));
    expect(await fs.readFile(path.join(old, '.gitnexus/lbug'), 'utf8')).toBe('synthetic index marker');
  }

  it.each(['unknown', 'other'])('rejects %s outside the active context', async (alias) => {
    await expect(refresh({ alias })).rejects.toThrow(/approved alias/i);
    await expectOriginal();
  });

  it('rejects a wrong or abbreviated live commit before indexing', async () => {
    const build = vi.fn(buildIndex);
    await expect(refresh({ expectHead: head.slice(0, 8) }, { buildIndex: build })).rejects.toThrow(/full/i);
    await expect(refresh({ expectHead: '0'.repeat(40) }, { buildIndex: build })).rejects.toThrow(/does not match/i);
    expect(build).not.toHaveBeenCalled();
    await expectOriginal();
  });

  it('rejects a replaced snapshot identity', async () => {
    await fs.rename(old, old + '-original');
    git(directory, 'clone', '-q', '--no-hardlinks', old + '-original', old);
    await expect(refresh()).rejects.toThrow(/replaced/i);
    expect(await fs.readFile(policy)).toEqual(original);
  });

  it('rejects a missing database or a symlinked snapshot', async () => {
    await fs.chmod(old, 0o777);
    await expect(refresh()).rejects.toThrow(/safe permissions/i);
    await fs.chmod(old, 0o700);
    await fs.unlink(path.join(old, '.gitnexus/lbug'));
    await expect(refresh()).rejects.toThrow(/missing/i);
    await fs.rename(old, old + '-original');
    await fs.symlink(old + '-original', old);
    await expect(refresh()).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(policy)).toEqual(original);
  });

  it('rejects a committed symlink before running the indexer', async () => {
    await fs.symlink('../outside', path.join(live, 'unsafe.ts'));
    git(live, 'add', 'unsafe.ts');
    head = commit(live);
    const build = vi.fn(buildIndex);
    await expect(refresh({}, { buildIndex: build })).rejects.toThrow(/symlink/i);
    expect(build).not.toHaveBeenCalled();
    await expectOriginal();
  });

  it('rejects HEAD drift after indexing finishes', async () => {
    await expect(refresh({}, { buildIndex: async (stage) => {
      await buildIndex(stage);
      commit(live);
    } })).rejects.toThrow(/HEAD changed/i);
    await expectOriginal();
  });

  it.each(['buildIndex', 'verifyQuery'] as const)('preserves the original when %s fails', async (step) => {
    await expect(refresh({}, { [step]: async () => { throw new Error('fixture stage failure'); } }))
      .rejects.toThrow('fixture stage failure');
    await expectOriginal();
  });

  it('preserves a concurrent policy edit before activation', async () => {
    const changed = Buffer.concat([original, Buffer.from('# concurrent edit\n')]);
    await expect(refresh({}, { verifyQuery: async () => { await fs.writeFile(policy, changed); } }))
      .rejects.toThrow(/policy changed/i);
    expect(await fs.readFile(policy)).toEqual(changed);
    expect((await loadContextConfig(policy)).repositories.selected.root).toBe(old);
  });

  it.each([false, true])('guards rollback when post-activation validation fails (concurrent edit %s)', async (concurrent) => {
    let newRoot: string;
    const saveConfig: typeof saveContextConfig = async (config, file, options) => {
      await saveContextConfig(config, file, options);
      if (options?.beforeWrite) {
        newRoot = config.repositories.selected.root;
        await fs.unlink(path.join(newRoot, '.gitnexus/lbug'));
        if (concurrent) await fs.appendFile(policy, '# concurrent edit\n');
      }
    };
    await expect(refresh({}, { saveConfig })).rejects.toThrow(concurrent ? /rollback could not complete/i : /validation failed/i);
    if (concurrent) {
      expect((await loadContextConfig(policy)).repositories.selected.root).toBe(newRoot!);
      expect(await fs.readFile(policy, 'utf8')).toContain('# concurrent edit');
      expect(await fs.stat(newRoot!)).toBeTruthy();
    } else await expectOriginal();
  });

  it('rejects an overlapping refresh of the same alias', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const first = refresh({}, { verifyQuery: async () => { entered(); await finish; } });
    try {
      await Promise.race([waiting, first]);
      await expect(refresh()).rejects.toThrow(/refresh.*(?:running|progress|locked)/i);
    } finally { release(); await first; }
    expect((await loadContextConfig(policy)).repositories.selected.root).not.toBe(old);
  });

  it('blocks network sockets and writes outside the private candidate', async () => {
    const probe = `
      const net = require('node:net');
      const fs = require('node:fs');
      try { fs.writeFileSync(process.argv[1], 'bad'); process.exit(2); }
      catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
      const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
      socket.setTimeout(1500, () => process.exit(3));
      socket.once('connect', () => process.exit(4));
      socket.once('error', (error) => { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; });
    `;
    const wouldWrite = path.join(live, 'outside.txt');
    await refresh({}, { verifyQuery: async (stage) => {
      await stage.run(process.execPath, ['-e', probe, wouldWrite], { cwd: stage.root, home: stage.home, writableRoots: [stage.root] });
    } });
    await expect(fs.lstat(wouldWrite)).rejects.toMatchObject({code: 'ENOENT'});
  });
});
