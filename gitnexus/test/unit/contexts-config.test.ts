import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  discoverRepositories,
  loadContextConfig,
  parseContextConfig,
  saveContextConfig,
  validateRepositoryRoot,
  type ContextConfig,
} from '../../src/core/contexts/config.js';
import { registerContextCommands } from '../../src/cli/contexts.js';

describe('owner-controlled repository contexts', () => {
  let directory: string;
  let parent: string;
  let policy: string;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-context-policy-')));
    parent = path.join(directory, 'projects');
    policy = path.join(directory, 'policy', 'contexts.yaml');
    await fs.mkdir(parent);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = async (root: string): Promise<void> => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  };
  const empty = (): ContextConfig => ({ version: 1, parent, repositories: {}, contexts: {} });
  const command = async (...args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    registerContextCommands(program);
    await program.parseAsync(['contexts', '--config', policy, ...args], { from: 'user' });
  };

  it('writes private atomic policies, reads changes back, and rejects stale writers', async () => {
    await saveContextConfig(empty(), policy);
    expect((await fs.stat(policy)).mode & 0o777).toBe(0o600);
    const first = await loadContextConfig(policy);
    const stale = await loadContextConfig(policy);
    first.contexts.home = [];
    await saveContextConfig(first, policy);
    expect((await loadContextConfig(policy)).contexts.home).toEqual([]);
    stale.contexts.work = [];
    await expect(saveContextConfig(stale, policy)).rejects.toThrow('changed');
    expect(await fs.readdir(path.dirname(policy))).toEqual(['contexts.yaml']);
  });

  it('rejects broad permissions, symlink policies and hard-linked policies', async () => {
    await saveContextConfig(empty(), policy);
    await fs.chmod(policy, 0o644);
    await expect(loadContextConfig(policy)).rejects.toThrow('owner-only');
    await fs.chmod(policy, 0o600);
    const linked = path.join(path.dirname(policy), 'linked.yaml');
    await fs.symlink(policy, linked);
    await expect(loadContextConfig(linked)).rejects.toThrow();
    await fs.unlink(linked);
    await fs.link(policy, linked);
    await expect(loadContextConfig(policy)).rejects.toThrow('regular');
  });

  it('discovers same-basename ordinary roots and excludes symlinks, linked and nested roots', async () => {
    const first = path.join(parent, 'one', 'service');
    const second = path.join(parent, 'two', 'service');
    await repo(first);
    await repo(second);
    await repo(path.join(first, 'nested'));
    await fs.symlink(first, path.join(parent, 'alias'));
    const linked = path.join(parent, 'linked');
    await fs.mkdir(linked);
    await fs.writeFile(path.join(linked, '.git'), 'gitdir: /not-followed\n');
    expect(await discoverRepositories(parent)).toEqual([first, second]);
    await expect(validateRepositoryRoot(path.join(first, 'nested'), parent)).rejects.toThrow('Nested');
    await expect(validateRepositoryRoot(linked, parent)).rejects.toThrow('Linked');
    await expect(validateRepositoryRoot(path.join(parent, 'alias'), parent)).rejects.toThrow('symlinks');
  });

  it('rejects unapproved identity, invalid memberships, unsupported policy versions and oversized contexts', () => {
    const config = empty();
    expect(() => parseContextConfig(JSON.stringify({ ...config, version: 2 }))).toThrow('version');
    expect(() => parseContextConfig(JSON.stringify({ ...config, contexts: { work: ['unknown'] } }))).toThrow('approved');
    expect(() => parseContextConfig(JSON.stringify({ ...config, repositories: { example: { root: path.join(parent, 'example') } } }))).toThrow('identity');
    const names = Array.from({ length: 17 }, (_, index) => `repo${index}`);
    const repositories = Object.fromEntries(names.map((name) => [name, { root: path.join(parent, name), identity: { device: '1', inode: '1' } }]));
    expect(() => parseContextConfig(JSON.stringify({ ...config, repositories, contexts: { work: names } }))).toThrow('16');
    expect(() => parseContextConfig(JSON.stringify({ ...config, contexts: { ['x'.repeat(65)]: [] } }))).toThrow('Invalid name');
  });

  it('setup does not approve candidates and explicit commands manage and revoke membership', async () => {
    const root = path.join(parent, 'service');
    await repo(root);
    await command('setup', '--parent', parent);
    expect((await loadContextConfig(policy)).repositories).toEqual({});
    await expect(command('add', 'work', 'service')).rejects.toThrow('not approved');
    await command('approve', 'service', root);
    await command('add', 'work', 'service');
    await command('use', 'work');
    const configured = await loadContextConfig(policy);
    expect(configured.activeContext).toBe('work');
    expect(configured.contexts.work).toEqual(['service']);
    await command('remove', 'work', 'service');
    expect((await loadContextConfig(policy)).contexts.work).toEqual([]);
    await command('add', 'work', 'service');
    await command('revoke', 'service');
    expect((await loadContextConfig(policy)).repositories).toEqual({});
    expect((await loadContextConfig(policy)).contexts.work).toEqual([]);
    expect((await fs.stat(root)).isDirectory()).toBe(true);
    await expect(fs.lstat(path.join(root, '.gitnexus'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires explicit reapproval after a directory is replaced', async () => {
    const root = path.join(parent, 'service');
    await repo(root);
    await command('setup', '--parent', parent);
    await command('approve', 'service', root);
    await fs.rename(root, path.join(parent, 'old-service'));
    await repo(root);
    await expect(command('add', 'work', 'service')).rejects.toThrow('reapprove');
    await command('approve', 'service', root);
    await command('add', 'work', 'service');
    expect((await loadContextConfig(policy)).contexts.work).toEqual(['service']);
  });
});
