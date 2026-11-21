import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  DEFAULT_CONTEXT_CONFIG_PATH, loadContextConfig, saveContextConfig, rejectMacAcl,
  validateContextName, validateRepositoryRoot, parseContextConfig,
  type ContextConfig, type RepositoryIdentity,
} from './config.js';
import { inspectContextIndex } from './index-safety.js';
import { buildRefreshIndex, verifyRefreshQuery } from './refresh-engine.js';

const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_OBJECT = 128 * 1024 * 1024;

export interface RefreshRunOptions {
  cwd: string;
  home: string;
  writableRoots: string[];
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  maxBuffer?: number;
}
export type RefreshRunner = (
  command: string, args: string[], options: RefreshRunOptions,
) => Promise<{ stdout: Buffer; stderr: Buffer }>;
export interface RefreshStage {
  root: string;
  home: string;
  head: string;
  run: RefreshRunner;
}
export interface RefreshDependencies {
  loadConfig: typeof loadContextConfig;
  saveConfig: typeof saveContextConfig;
  run: RefreshRunner;
  buildIndex: (stage: RefreshStage) => Promise<void>;
  verifyQuery: (stage: RefreshStage) => Promise<void>;
}
export interface RefreshOptions {
  alias: string;
  expectHead: string;
  configFile?: string;
}
export interface RefreshResult {
  alias: string;
  previousRoot: string;
  root: string;
  head: string;
  policyBackup: string;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameIdentity(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}
async function directoryIdentity(directory: string, privateDirectory = false): Promise<RepositoryIdentity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & BigInt(privateDirectory ? 0o077 : 0o022)) !== 0n) {
    throw new Error('Refresh requires canonical directories owned by the current user with safe permissions.');
  }
  await rejectMacAcl(directory);
  return { device: String(stat.dev), inode: String(stat.ino) };
}
async function readOrdinary(file: string, limit = MAX_OBJECT): Promise<Buffer> {
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Git paths cannot traverse symlinks.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0) throw new Error('Git input must be an ordinary, safely owned file with one link.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Read refs directly: repository config, includes, helpers and lazy fetching never run. */
async function liveHead(root: string): Promise<string> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || await fs.realpath(root) !== root) {
    throw new Error('The approved liveRoot must be an exact canonical path.');
  }
  await directoryIdentity(root);
  const git = path.join(root, '.git');
  const stat = await fs.lstat(git);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(git) !== git) {
    throw new Error('Refresh does not support linked worktrees or redirected Git directories.');
  }
  await directoryIdentity(git);
  let value = (await readOrdinary(path.join(git, 'HEAD'), 4096)).toString('utf8').trim();
  const visited = new Set<string>();
  for (let depth = 0; depth < 8 && value.startsWith('ref: '); depth++) {
    const ref = value.slice(5);
    if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.split('/').some((part) => !part || part === '.' || part === '..') ||
        visited.has(ref)) throw new Error('Unsupported live Git reference.');
    visited.add(ref);
    try { value = (await readOrdinary(path.join(git, ref), 4096)).toString('utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const lines = (await readOrdinary(path.join(git, 'packed-refs'), 16 * 1024 * 1024)).toString('utf8').split('\n');
      const matches = lines.filter((line) => line.endsWith(` ${ref}`));
      if (matches.length !== 1) throw new Error('The approved live HEAD cannot be resolved.');
      value = matches[0].split(' ')[0];
    }
  }
  if (!revision.test(value)) throw new Error('The approved live HEAD is not a full commit ID.');
  return value;
}

/** No live files or Git config are copied, and object redirection is rejected. */
async function validateObjects(directory: string): Promise<void> {
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o022) !== 0 ||
      await fs.realpath(directory) !== directory) throw new Error('Git object paths cannot traverse symlinks.');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error('Git objects contain an unsafe path or hard link.');
    }
    if (stat.isDirectory()) await validateObjects(file);
    else if (entry.name === 'alternates' || entry.name === 'http-alternates') {
      throw new Error('Git object alternates are not supported during refresh.');
    }
  }
}

let localGit: Promise<string> | undefined;
function findLocalGit(): Promise<string> {
  return localGit ??= (async () => {
    if (process.platform !== 'darwin') return '/usr/bin/git';
    // /usr/bin/git is an xcrun shim that can try to update a cache outside the sandbox.
    const { stdout } = await promisify(execFile)('/usr/bin/xcode-select', ['-p'], {
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 3000, maxBuffer: 8192,
    });
    const developer = stdout.trim();
    if (!path.isAbsolute(developer)) throw new Error('No local Apple Git toolchain is active.');
    const candidates = new Set([
      path.join(developer, 'usr/bin/git'),
      '/Library/Developer/CommandLineTools/usr/bin/git',
    ]);
    for (const candidate of candidates) {
      try {
        const git = await fs.realpath(candidate);
        const stat = await fs.stat(git);
        if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
            (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111)) continue;
        await promisify(execFile)('/usr/bin/codesign', [
          '--verify', '--strict', '--requirement', 'anchor apple and identifier "com.apple.git"', git,
        ], { env: { PATH: '/usr/bin:/bin' }, timeout: 3000, maxBuffer: 8192 });
        return git;
      } catch {
        // Try the standalone Apple tools if the selected copy is absent or untrusted.
      }
    }
    throw new Error('No Apple-signed Git executable with safe ownership and permissions is available.');
  })();
}

/** Fail closed if the operating system cannot enforce offline, confined writes. */
export const runRefreshSandbox: RefreshRunner = async (command, args, options) => {
  if (!path.isAbsolute(command)) throw new Error('Refresh subprocess executables must use absolute paths.');
  const writable = [...new Set([options.home, ...options.writableRoots])];
  for (const directory of writable) {
    await directoryIdentity(directory, true);
  }
  const git = await findLocalGit();
  const program = command === '/usr/bin/git' ? git : command;
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(git)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: options.home,
    TMPDIR: path.join(options.home, 'tmp'),
    XDG_CONFIG_HOME: path.join(options.home, 'config'),
    XDG_CACHE_HOME: path.join(options.home, 'cache'),
    XDG_DATA_HOME: path.join(options.home, 'data'),
    LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '',
    ...options.env,
  };
  let executable: string;
  let sandboxArgs: string[];
  if (process.platform === 'darwin') {
    executable = '/usr/bin/sandbox-exec';
    const rules = writable.map((directory) => `(subpath ${JSON.stringify(directory)})`).join(' ');
    sandboxArgs = ['-p', `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* ${rules} (literal "/dev/null"))`, program, ...args];
  } else if (process.platform === 'linux') {
    executable = '/usr/bin/bwrap';
    sandboxArgs = ['--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
      ...writable.flatMap((directory) => ['--bind', directory, directory]),
      '--dev', '/dev', '--proc', '/proc', '--', program, ...args];
  } else throw new Error('Refresh requires an available OS-enforced offline sandbox (macOS sandbox-exec or Linux bubblewrap).');
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, sandboxArgs, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const limit = options.maxBuffer ?? MAX_OBJECT;
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Refresh subprocess timed out.'); child.kill('SIGKILL'); }, 20 * 60 * 1000);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { failure = new Error('Refresh subprocess output exceeded its limit.'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`Offline refresh sandbox could not start: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) {
        const action = command === '/usr/bin/git' ? `git ${args[0]}` : path.basename(command);
        reject(new Error(`Offline refresh subprocess (${action}) failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`));
      }
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.on('error', () => { /* A failed child can close stdin before the buffered input is consumed. */ });
    child.stdin.end(options.input);
  });
};

async function privateTree(directory: string, repair: boolean): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error('The candidate contains a symlink, hard link or unsafe owner.');
  }
  const mode = stat.isDirectory() || (stat.mode & 0o100) ? 0o700 : 0o600;
  if (repair && (stat.mode & 0o7777) !== mode) await fs.chmod(directory, mode);
  else if ((stat.mode & 0o077) !== 0) throw new Error('Candidate files must be owner-only.');
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(directory)) await privateTree(path.join(directory, name), repair);
  }
}

async function materialize(
  liveRoot: string, root: string, home: string, workspace: string, head: string, run: RefreshRunner,
): Promise<void> {
  const objects = path.join(liveRoot, '.git', 'objects');
  await validateObjects(objects);
  const source = path.join(workspace, 'source.git');
  const template = path.join(workspace, 'empty-template');
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(path.join(source, 'refs'), { mode: 0o700 });
  await fs.mkdir(path.join(source, 'objects'), { mode: 0o700 });
  await fs.mkdir(template, { mode: 0o700 });
  await fs.writeFile(path.join(source, 'HEAD'), `${head}\n`, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(source, 'config'), head.length === 64
    ? '[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n'
    : '[core]\nrepositoryformatversion = 0\n', { mode: 0o600, flag: 'wx' });
  const common: RefreshRunOptions = { cwd: root, home, writableRoots: [workspace] };
  const sourceGit = async (args: string[]) => (await run('/usr/bin/git', ['--no-replace-objects', `--git-dir=${source}`, ...args], {
    ...common, env: { GIT_OBJECT_DIRECTORY: objects },
  })).stdout;
  if ((await sourceGit(['cat-file', '-t', head])).toString().trim() !== 'commit') throw new Error('Expected HEAD is not a commit.');
  const listing = await sourceGit(['ls-tree', '-rtz', '--full-tree', head]);
  const records = listing.toString('utf8').split('\0').filter(Boolean);
  if (!Buffer.from(listing.toString('utf8')).equals(listing)) throw new Error('Committed paths require valid UTF-8.');
  const entries = records.map((record) => {
    const match = /^(\d{6}) (blob|tree) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Unsupported committed tree entry (including submodules).');
    const [, mode, type, oid, name] = match;
    if (!revision.test(oid) || !['100644', '100755', '040000'].includes(mode) || path.isAbsolute(name) || name.includes('\\') ||
        name.split('/').some((part) => !part || part === '.' || part === '..' || ['.git', '.gitnexus'].includes(part.toLowerCase())) ||
        !inside(root, path.resolve(root, name))) {
      throw new Error('Committed paths contain a symlink, reserved namespace or traversal.');
    }
    return { mode, type, oid, name };
  });
  await run('/usr/bin/git', ['init', '--quiet', `--template=${template}`, `--object-format=${head.length === 64 ? 'sha256' : 'sha1'}`, root], common);
  const commit = await sourceGit(['cat-file', 'commit', head]);
  const rootTree = /^tree ([0-9a-f]+)\n/.exec(commit.toString('utf8'))?.[1];
  if (!rootTree || !revision.test(rootTree)) throw new Error('Commit tree is invalid.');
  const objectIds = [...new Set([head, rootTree, ...entries.map((entry) => entry.oid)])];
  const pack = await run('/usr/bin/git', ['--no-replace-objects', `--git-dir=${source}`, 'pack-objects', '--stdout', '--no-reuse-delta', '--no-reuse-object'], {
    ...common, env: { GIT_OBJECT_DIRECTORY: objects }, input: Buffer.from(objectIds.join('\n') + '\n'),
  });
  await run('/usr/bin/git', ['index-pack', '--stdin'], { ...common, input: pack.stdout });
  await fs.writeFile(path.join(root, '.git', 'HEAD'), `${head}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(root, '.git', 'shallow'), `${head}\n`, { mode: 0o600, flag: 'wx' });
  await run('/usr/bin/git', ['fsck', '--strict', '--no-reflogs'], common);
  const blobs = [...new Set(entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid))];
  const batch = await run('/usr/bin/git', ['cat-file', '--batch'], { ...common, input: Buffer.from(blobs.length ? blobs.join('\n') + '\n' : '') });
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (const oid of blobs) {
    const end = batch.stdout.indexOf(10, offset);
    if (end < offset) throw new Error('Incomplete Git object batch.');
    const header = batch.stdout.subarray(offset, end).toString('ascii');
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    const size = match ? Number(match[2]) : -1;
    if (!match || match[1] !== oid || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= batch.stdout.length ||
        batch.stdout[end + size + 1] !== 10) throw new Error('Invalid Git object batch.');
    contents.set(oid, batch.stdout.subarray(end + 1, end + size + 1));
    offset = end + size + 2;
  }
  if (offset !== batch.stdout.length) throw new Error('Unexpected trailing Git object data.');
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.type === 'tree') { await fs.mkdir(file, { recursive: true, mode: 0o700 }); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, contents.get(entry.oid)!, {
      mode: entry.mode === '100755' ? 0o700 : 0o600, flag: 'wx',
    });
  }
  await run('/usr/bin/git', ['read-tree', head], common);
  await run('/usr/bin/git', ['update-index', '--refresh'], common);
  await privateTree(root, true);
}

async function validateCandidate(stage: RefreshStage, parent: string, identity: RepositoryIdentity): Promise<void> {
  if (!sameIdentity(await validateRepositoryRoot(stage.root, parent), identity)) throw new Error('Candidate directory was replaced.');
  await privateTree(stage.root, false);
  const index = await inspectContextIndex(parent, stage.root, identity);
  if (index.state !== 'ready' || index.indexedRevision !== stage.head || index.head !== stage.head) {
    throw new Error(`Candidate index validation failed: ${index.state}.`);
  }
  const result = await stage.run('/usr/bin/git', [
    'diff', '--no-ext-diff', '--no-textconv', '--name-only', stage.head, '--',
  ], { cwd: stage.root, home: stage.home, writableRoots: [] });
  if (result.stdout.length) throw new Error('Candidate snapshot tracked files changed.');
}

/** Refresh one approved active-context alias; preserve its previous snapshot and all other policy fields. */
export async function refreshContextRepository(
  options: RefreshOptions, overrides: Partial<RefreshDependencies> = {},
): Promise<RefreshResult> {
  validateContextName(options.alias);
  if (!revision.test(options.expectHead)) throw new Error('--expect-head requires an exact full lowercase commit ID.');
  const deps: RefreshDependencies = {
    loadConfig: loadContextConfig, saveConfig: saveContextConfig, run: runRefreshSandbox,
    buildIndex: buildRefreshIndex, verifyQuery: verifyRefreshQuery, ...overrides,
  };
  const file = options.configFile ?? DEFAULT_CONTEXT_CONFIG_PATH;
  const config = await deps.loadConfig(file);
  const lockPath = path.join(path.dirname(path.resolve(file)), `.contexts-refresh-${options.alias}.lock`);
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A refresh for this alias is already in progress.');
    throw error;
  }
  const lockStat = await lock.stat();
  try {
    const original = await deps.loadConfig(file);
    if (JSON.stringify(config) !== JSON.stringify(original)) throw new Error('Context policy changed while loading.');
    const repository = config.repositories[options.alias];
    if (!repository || !config.activeContext || !config.contexts[config.activeContext]?.includes(options.alias)) {
      throw new Error('Refresh requires one exact approved alias in the active context.');
    }
    if (!repository.liveRoot) throw new Error('Refresh requires an explicitly approved liveRoot.');
    const parentIdentity = await directoryIdentity(config.parent);
    const oldIdentity = await validateRepositoryRoot(repository.root, config.parent);
    if (!sameIdentity(oldIdentity, repository.identity)) throw new Error('The approved snapshot was replaced; reapprove it.');
    await directoryIdentity(repository.root);
    await directoryIdentity(path.join(repository.root, '.git'));
    const previous = await inspectContextIndex(config.parent, repository.root, repository.identity);
    if (previous.state !== 'ready') throw new Error(`The existing snapshot/index is not valid: ${previous.state}.`);
    if (await liveHead(repository.liveRoot) !== options.expectHead) throw new Error('Live HEAD does not match --expect-head.');
    const workspace = path.join(config.parent, `.gitnexus-refresh-${options.alias}-${randomUUID()}`);
    await fs.mkdir(workspace, { mode: 0o700 });
    const workspaceIdentity = await directoryIdentity(workspace, true);
    const policyBackup = path.join(workspace, 'previous-contexts.yaml');
    const root = path.join(workspace, 'snapshot');
    const home = path.join(workspace, 'home');
    let published = false;
    let switchAttempted = false;
    let keepCandidate = false;
    let policyBytes: Buffer;
    try {
      policyBytes = await readOrdinary(file, 1024 * 1024);
      if (JSON.stringify(parseContextConfig(policyBytes.toString('utf8'))) !== JSON.stringify(original)) {
        throw new Error('Context policy changed before its backup was recorded.');
      }
      await fs.writeFile(policyBackup, policyBytes, { mode: 0o600, flag: 'wx' });
      if (!(await readOrdinary(policyBackup)).equals(policyBytes)) throw new Error('Policy backup verification failed.');
      await fs.mkdir(root, { mode: 0o700 });
      await fs.mkdir(home, { mode: 0o700 });
      for (const directory of ['tmp', 'config', 'cache', 'data']) await fs.mkdir(path.join(home, directory), { mode: 0o700 });
      await materialize(repository.liveRoot, root, home, workspace, options.expectHead, deps.run);
      const identity = await validateRepositoryRoot(root, config.parent);
      const stage: RefreshStage = { root, home, head: options.expectHead, run: deps.run };
      await deps.buildIndex(stage);
      await privateTree(root, true);
      await validateCandidate(stage, config.parent, identity);
      await deps.verifyQuery(stage);
      await validateCandidate(stage, config.parent, identity);
      const beforeWrite = async () => {
        if (!(await readOrdinary(file, 1024 * 1024)).equals(policyBytes)) throw new Error('Context policy changed before publication.');
        if (!sameIdentity(await directoryIdentity(config.parent), parentIdentity) ||
            !sameIdentity(await directoryIdentity(workspace, true), workspaceIdentity) ||
            !sameIdentity(await validateRepositoryRoot(repository.root, config.parent), oldIdentity)) {
          throw new Error('An approved directory changed during refresh.');
        }
        await validateCandidate(stage, config.parent, identity);
        if (await liveHead(repository.liveRoot!) !== options.expectHead) throw new Error('Live HEAD changed during refresh.');
      };
      config.repositories[options.alias] = { ...repository, root, identity };
      switchAttempted = true;
      await deps.saveConfig(config, file, { beforeWrite });
      published = true;
      const saved = await deps.loadConfig(file);
      if (JSON.stringify(saved) !== JSON.stringify(config)) throw new Error('Saved context policy did not match the verified refresh.');
      await validateCandidate(stage, config.parent, identity);
      keepCandidate = true;
      return { alias: options.alias, previousRoot: repository.root, root, head: options.expectHead, policyBackup };
    } catch (error) {
      if (switchAttempted && !published) {
        try {
          const current = await deps.loadConfig(file);
          published = current.repositories[options.alias]?.root === root;
        } catch (inspection) {
          keepCandidate = true;
          throw new Error(`Refresh failed and publication state could not be verified; both snapshots were preserved. ${String(error)}; ${String(inspection)}`);
        }
      }
      if (published) {
        try {
          await deps.saveConfig(config, file, { restore: original });
          if (!(await readOrdinary(file, 1024 * 1024)).equals(policyBytes)) {
            throw new Error('Restored policy bytes could not be verified.');
          }
        }
        catch (rollback) {
          keepCandidate = true;
          throw new Error(`Refresh failed; guarded policy rollback could not complete. Both snapshots were preserved. ${String(error)}; ${String(rollback)}`);
        }
      }
      throw error;
    } finally {
      if (!keepCandidate && sameIdentity(await directoryIdentity(workspace, true), workspaceIdentity)) {
        await fs.rm(workspace, { recursive: true });
      }
    }
  } finally {
    await lock.close();
    const current = await fs.lstat(lockPath);
    if (current.dev !== lockStat.dev || current.ino !== lockStat.ino || !current.isFile() || current.nlink !== 1) {
      throw new Error('Refresh lock was replaced; the replacement was preserved.');
    }
    await fs.unlink(lockPath);
  }
}
