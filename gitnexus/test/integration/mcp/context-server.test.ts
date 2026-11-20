import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { saveContextConfig, validateRepositoryRoot, type ContextConfig } from '../../../src/core/contexts/config.js';

const app = process.env.GITNEXUS_CONTEXT_TEST_APP;
const acceptance = app ? it : it.skip;
const tools = ['query', 'context', 'detect_changes', 'impact', 'route_map', 'tool_map', 'shape_check', 'api_impact'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trim();

function children(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  } catch {
    return [];
  }
}

async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function snapshot(root: string) {
  const index = path.join(root, '.gitnexus');
  const files = (await fs.readdir(index, { recursive: true })).sort();
  return Promise.all(files.map(async (file) => {
    const name = path.join(index, file);
    const stat = await fs.lstat(name);
    return [file, stat.mode, stat.isFile() ? createHash('sha256').update(await fs.readFile(name)).digest('hex') : 'directory'];
  }));
}

acceptance('isolates independent real indexes and preserves the hardened launcher lifecycle', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-context-test-')));
  const parent = path.join(temp, 'repositories');
  const policy = path.join(temp, 'contexts.yaml');
  const launcher = path.join(app!, 'scripts/gitnexus-codex-mcp.mjs');
  const cli = path.join(app!, 'dist/cli/index.js');
  const active = new Set<Client>();
  let raw: ReturnType<typeof spawn> | undefined;
  let rawServer: number | undefined;
  const analysisEnv = {
    ...process.env,
    GITNEXUS_HOME: path.join(temp, 'registry'),
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
  };
  const root = (folder: string) => path.join(parent, folder, 'same-name');
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
    const content = reply.content as Array<{text: string}>;
    return { error: reply.isError, text: content[0].text };
  };
  async function connect(env: Record<string, string>) {
    const client = new Client({ name: 'context-acceptance', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [launcher],
      env: { HOME: process.env.HOME!, PATH: analysisEnv.PATH, ...env },
      stderr: 'pipe',
    });
    active.add(client);
    await client.connect(transport);
    expect(transport.pid).toBeTruthy();
    const [server] = children(transport.pid!);
    expect(server).toBeTruthy();
    return { client, launcherPid: transport.pid!, server };
  }
  async function close(connection: Awaited<ReturnType<typeof connect>>) {
    await connection.client.close();
    active.delete(connection.client);
    expect(await exited(connection.launcherPid)).toBe(true);
    expect(await exited(connection.server)).toBe(true);
  }

  try {
    for (const [folder, file] of [['left', 'left.ts'], ['right', 'right.ts'], ['unapproved', 'excluded.ts']]) {
      const repo = root(folder);
      await fs.mkdir(repo, { recursive: true, mode: 0o700 });
      git(repo, 'init', '-q');
      await fs.writeFile(path.join(repo, file), 'export function ContextNeedle() { return 42; }\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
      if (folder === 'unapproved') continue;
      execFileSync(process.execPath, [cli, 'analyze', '--index-only', repo], {
        cwd: repo, env: analysisEnv, timeout: 25_000, stdio: 'pipe',
      });
      await fs.chmod(path.join(repo, '.gitnexus'), 0o700);
      for (const file of ['meta.json', 'lbug']) await fs.chmod(path.join(repo, '.gitnexus', file), 0o600);
    }
    const before = await Promise.all(['left', 'right'].map((repo) => snapshot(root(repo))));
    const config: ContextConfig = {
      version: 1, parent, activeContext: 'both',
      repositories: {
        left: { root: root('left'), identity: await validateRepositoryRoot(root('left'), parent) },
        right: { root: root('right'), identity: await validateRepositoryRoot(root('right'), parent) },
      },
      contexts: { both: ['left', 'right'], one: ['right'] },
    };
    await saveContextConfig(config, policy);
    const env = { GITNEXUS_SAFE_CONTEXT_CONFIG: policy };
    const first = await connect(env);
    expect((await first.client.listTools()).tools.map((tool) => tool.name)).toEqual(tools);
    const start = performance.now();
    const reply = await call(first.client, 'query', { query: 'ContextNeedle' });
    const duration = performance.now() - start;
    expect(reply.error).not.toBe(true);
    const report = JSON.parse(reply.text.split('\n\n---')[0]);
    expect(report.repositories.map((item: { repository: string; state: string }) => [item.repository, item.state]))
      .toEqual([['left', 'ready'], ['right', 'ready']]);
    expect(JSON.stringify(report.repositories[0].result)).toContain('left.ts');
    expect(JSON.stringify(report.repositories[0].result)).not.toContain('right.ts');
    expect(JSON.stringify(report.repositories[1].result)).toContain('right.ts');
    expect(JSON.stringify(report.repositories[1].result)).not.toContain('left.ts');
    const rss = execFileSync('ps', ['-o', 'rss=', '-p', String(first.server)], { encoding: 'utf8' }).trim();
    console.log(`Context query: ${Math.round(duration)} ms, ${Buffer.byteLength(reply.text)} bytes, sampled server RSS ${rss} KiB`);
    if (process.platform === 'darwin') {
      for (const pid of [first.launcherPid, first.server]) {
        const network = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-i'], { encoding: 'utf8' });
        expect(network.status).toBe(1);
        expect(network.stderr).toBe('');
      }
    }

    for (const args of [
      { context: 'one' }, { repository: 'unapproved' }, { repository: '../unapproved' },
      { repo: root('unapproved') }, { worktree: root('unapproved') }, { limit: '5' },
    ]) expect((await call(first.client, 'query', { query: 'ContextNeedle', ...args })).error).toBe(true);
    expect((await call(first.client, 'context', { name: 'ContextNeedle' })).error).toBe(true);
    expect((await call(first.client, 'context', { name: 'ContextNeedle', repository: 'right' })).text).toContain('right.ts');
    expect((await call(first.client, 'context', { name: 'ContextNeedle', repository: 'right', file_path: '../excluded.ts' })).error).toBe(true);

    config.activeContext = 'one';
    await saveContextConfig(config, policy);
    expect((await call(first.client, 'query', { query: 'ContextNeedle', context: 'one' })).error).toBe(true);
    await close(first);
    const second = await connect(env);
    expect((await call(second.client, 'query', { query: 'ContextNeedle', repository: 'left' })).error).toBe(true);
    const index = path.join(root('right'), '.gitnexus');
    const db = path.join(index, 'lbug');
    const spare = path.join(temp, 'spare-index');
    await fs.rename(db, spare);
    expect((await call(second.client, 'query', { query: 'ContextNeedle' })).text).toContain('"state": "missing"');
    await fs.symlink(spare, db);
    expect((await call(second.client, 'query', { query: 'ContextNeedle' })).text).toContain('"state": "unsafe"');
    await fs.unlink(db);
    await fs.rename(spare, db);
    await fs.writeFile(db + '.wal', 'synthetic recovery marker', { mode: 0o600 });
    expect((await call(second.client, 'query', { query: 'ContextNeedle' })).text).toContain('"state": "recovery_required"');
    expect(await fs.readFile(db + '.wal', 'utf8')).toBe('synthetic recovery marker');
    await fs.unlink(db + '.wal');
    git(root('right'), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'stale');
    const stale = await call(second.client, 'query', { query: 'ContextNeedle' });
    expect(stale.text).toContain('"state": "stale"');
    expect(stale.text).toContain('"commitsBehind": 1');
    await close(second);

    const single = await connect({ GITNEXUS_SAFE_REPOSITORY: root('left') });
    expect((await single.client.listTools()).tools.map((tool) => tool.name)).toEqual(tools);
    expect((await call(single.client, 'query', { query: 'ContextNeedle' })).text).toContain('left.ts');
    await close(single);

    raw = spawn(process.execPath, [launcher], { env: { ...analysisEnv, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    const initialized = new Promise<void>((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error('No initialize response')), 8000);
      raw!.stdout!.on('data', (chunk) => {
        stdout += chunk.toString();
        if (!stdout.includes('\n')) return;
        clearTimeout(timeout);
        try {
          if (!JSON.parse(stdout.split('\n')[0]).result) throw new Error('Initialize failed');
          resolve();
        } catch (err) { reject(err); }
      });
    });
    raw.stdin!.on('error', () => {});
    raw.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } }) + '\n');
    await initialized;
    [rawServer] = children(raw.pid!);
    expect(rawServer).toBeTruthy();
    raw.kill('SIGKILL');
    expect(await exited(rawServer!)).toBe(true);
    rawServer = undefined;
    expect(await Promise.all(['left', 'right'].map((repo) => snapshot(root(repo))))).toEqual(before);
  } finally {
    raw?.stdin?.destroy();
    if (raw?.exitCode === null && raw.signalCode === null) raw.kill('SIGKILL');
    if (rawServer && !(await exited(rawServer))) {
      // Kill only the test's own server, identified by the unique policy path.
      const command = execFileSync('ps', ['-p', String(rawServer), '-o', 'command='], { encoding: 'utf8' });
      if (command.includes(policy)) process.kill(rawServer, 'SIGKILL');
    }
    await Promise.allSettled([...active].map((client) => client.close()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 120_000);
