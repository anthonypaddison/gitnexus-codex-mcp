import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as typeof import('js-yaml');

export const DEFAULT_CONTEXT_CONFIG_PATH = path.join(os.homedir(), '.gitnexus', 'contexts.yaml');

export interface RepositoryIdentity {
  device: string;
  inode: string;
}

export interface ContextRepository {
  root: string;
  identity: RepositoryIdentity;
}

export interface ContextConfig {
  version: 1;
  parent: string;
  activeContext?: string;
  repositories: Record<string, ContextRepository>;
  contexts: Record<string, string[]>;
}

const runFile = promisify(execFile);

export async function rejectMacAcl(file: string): Promise<void> {
  // macOS ACL grants can override the POSIX mode checked by lstat.
  if (process.platform !== 'darwin') return;
  const { stdout } = await runFile('/bin/ls', ['-lde', '--', file], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024,
  });
  if (/^\s*\d+: /m.test(stdout)) throw new Error('Context policy and index paths must not have ACL entries.');
}

const loadedBytes = new WeakMap<ContextConfig, string>();

export function validateContextName(name: string): void {
  if (
    name.length > 64 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    throw new Error(`Invalid name: ${name}. Use up to 64 letters, numbers, dots, underscores or hyphens.`);
  }
}

function mapping(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping.`);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function absolute(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute, normalized path.`);
  }
}

function beneath(root: string, parent: string): boolean {
  const relative = path.relative(parent, root);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function parseContextConfig(content: string): ContextConfig {
  const raw: unknown = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  mapping(raw, 'Context policy');
  exactKeys(raw, ['version', 'parent', 'activeContext', 'repositories', 'contexts'], 'Context policy');
  if (raw.version !== 1) throw new Error('Context policy requires version: 1.');
  absolute(raw.parent, 'parent');
  mapping(raw.repositories, 'repositories');
  mapping(raw.contexts, 'contexts');
  const repositories: Record<string, ContextRepository> = Object.create(null);
  const roots = new Set<string>();
  for (const [name, repository] of Object.entries(raw.repositories)) {
    validateContextName(name);
    mapping(repository, `Repository ${name}`);
    exactKeys(repository, ['root', 'identity'], `Repository ${name}`);
    absolute(repository.root, `Repository ${name} root`);
    if (!beneath(repository.root, raw.parent)) throw new Error(`Repository ${name} is outside parent.`);
    if (roots.has(repository.root)) throw new Error(`Duplicate repository root: ${repository.root}`);
    roots.add(repository.root);
    mapping(repository.identity, `Repository ${name} identity`);
    exactKeys(repository.identity, ['device', 'inode'], `Repository ${name} identity`);
    for (const field of ['device', 'inode']) {
      if (
        typeof repository.identity[field] !== 'string' ||
        !/^\d+$/.test(repository.identity[field] as string)
      ) {
        throw new Error(`Repository ${name} requires approved device and inode identity; reapprove it.`);
      }
    }
    repositories[name] = {
      root: repository.root,
      identity: {
        device: repository.identity.device as string,
        inode: repository.identity.inode as string,
      },
    };
  }
  const contexts: Record<string, string[]> = Object.create(null);
  for (const [name, members] of Object.entries(raw.contexts)) {
    validateContextName(name);
    if (
      !Array.isArray(members) ||
      members.some((member) => typeof member !== 'string' || !Object.hasOwn(repositories, member))
    ) {
      throw new Error(`Context ${name} must contain approved repository names only.`);
    }
    if (members.length > 16) throw new Error(`Context ${name} exceeds the limit of 16 repositories.`);
    if (new Set(members).size !== members.length) throw new Error(`Context ${name} has duplicate members.`);
    contexts[name] = [...members] as string[];
  }
  if (
    raw.activeContext !== undefined &&
    (typeof raw.activeContext !== 'string' || !Object.hasOwn(contexts, raw.activeContext))
  ) {
    throw new Error('activeContext must name a configured context.');
  }
  return {
    version: 1,
    parent: raw.parent,
    repositories,
    contexts,
    ...(raw.activeContext === undefined ? {} : { activeContext: raw.activeContext as string }),
  };
}

function checkOwner(stat: { uid: number; mode: number }, file: string, directory = false): void {
  if (typeof process.getuid !== 'function') {
    throw new Error('Context policy requires POSIX ownership checks.');
  }
  if (stat.uid !== process.getuid() || (stat.mode & (directory ? 0o022 : 0o077)) !== 0) {
    const permissions = directory ? 'not writable by others' : 'owner-only (chmod 600)';
    throw new Error(`${file} must be owned by the current user and ${permissions}.`);
  }
}

export async function loadContextConfig(file = DEFAULT_CONTEXT_CONFIG_PATH): Promise<ContextConfig> {
  const directory = path.dirname(path.resolve(file));
  if (await fs.realpath(directory) !== directory) {
    throw new Error('Context policy directory cannot traverse symlinks.');
  }
  checkOwner(await fs.lstat(directory), directory, true);
  await rejectMacAcl(directory);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Context policy must be a regular file with one link.');
    }
    checkOwner(stat, file);
    await rejectMacAcl(file);
    if (stat.size > 1024 * 1024) throw new Error('Context policy exceeds 1 MiB.');
    const content = await handle.readFile('utf8');
    const config = parseContextConfig(content);
    loadedBytes.set(config, content);
    return config;
  } finally {
    await handle.close();
  }
}

export async function saveContextConfig(
  config: ContextConfig,
  file = DEFAULT_CONTEXT_CONFIG_PATH,
): Promise<void> {
  const content = yaml.dump(config, { noRefs: true, lineWidth: 100 });
  parseContextConfig(content);
  const target = path.resolve(file);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) {
    throw new Error('Context policy directory cannot traverse symlinks.');
  }
  const dirStat = await fs.lstat(directory);
  if (!dirStat.isDirectory()) throw new Error('Context policy parent must be a directory.');
  checkOwner(dirStat, directory, true);
  await rejectMacAcl(directory);
  const lockPath = `${target}.lock`;
  const lock = await fs.open(lockPath, 'wx', 0o600);
  const temporary = path.join(directory, `.contexts-${randomUUID()}.tmp`);
  try {
    const expected = loadedBytes.get(config);
    let exists = false;
    try {
      const current = await loadContextConfig(target);
      exists = true;
      if (expected === undefined || loadedBytes.get(current) !== expected) {
        throw new Error('Context policy changed; reload it before saving.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (expected !== undefined) throw new Error('Context policy was removed; reload before saving.');
    }
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exists) await fs.rename(temporary, target);
    else await fs.link(temporary, target);
    loadedBytes.set(config, content);
  } finally {
    await fs.rm(temporary, { force: true });
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function hasGitEntry(root: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoGitAncestor(directory: string): Promise<void> {
  while (true) {
    if (await hasGitEntry(directory)) throw new Error('Nested repositories are not supported.');
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export async function validateRepositoryRoot(
  root: string,
  parent: string,
): Promise<RepositoryIdentity> {
  absolute(parent, 'parent');
  absolute(root, 'Repository root');
  if (!beneath(root, parent)) throw new Error('Repository must be beneath the selected parent.');
  if (await fs.realpath(parent) !== parent || await fs.realpath(root) !== root) {
    throw new Error('Repository paths cannot traverse symlinks.');
  }
  const stat = await fs.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Repository root must be an ordinary directory.');
  }
  const git = await fs.lstat(path.join(root, '.git'));
  if (!git.isDirectory() || git.isSymbolicLink()) {
    throw new Error('Linked worktrees and symlinked Git directories are not supported.');
  }
  const head = await fs.lstat(path.join(root, '.git', 'HEAD'));
  if (!head.isFile() || head.isSymbolicLink()) {
    throw new Error('Repository must contain an ordinary Git HEAD file.');
  }
  await assertNoGitAncestor(path.dirname(root));
  return { device: String(stat.dev), inode: String(stat.ino) };
}

export async function discoverRepositories(parent: string): Promise<string[]> {
  absolute(parent, 'parent');
  if (await fs.realpath(parent) !== parent || !(await fs.lstat(parent)).isDirectory()) {
    throw new Error('Select an ordinary, canonical parent directory.');
  }
  await assertNoGitAncestor(parent);
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) {
      throw new Error('Discovery cannot traverse symlinked directories.');
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const candidate = path.join(directory, entry.name);
      if (await hasGitEntry(candidate)) {
        const git = await fs.lstat(path.join(candidate, '.git'));
        if (git.isDirectory() && !git.isSymbolicLink()) {
          await validateRepositoryRoot(candidate, parent);
          found.push(candidate);
        }
      } else await visit(candidate);
    }
  };
  await visit(parent);
  return found;
}
