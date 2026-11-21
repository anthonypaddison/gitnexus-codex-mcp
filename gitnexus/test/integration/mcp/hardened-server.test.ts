import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAUNCHER = path.join(REPOSITORY_ROOT, 'scripts', 'gitnexus-codex-mcp.mjs');
const fixtureRoots: string[] = [];

async function makeIndexedRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-hardened-mcp-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await fs.mkdir(path.join(root, '.gitnexus'));
  await fs.writeFile(path.join(root, '.gitnexus', 'lbug'), 'handshake fixture');
  await fs.writeFile(
    path.join(root, '.gitnexus', 'meta.json'),
    JSON.stringify({
      repoPath: root,
      indexedAt: '2026-08-28T00:00:00.000Z',
      lastCommit: '0123456789abcdef',
      stats: { files: 1, nodes: 1, processes: 0, communities: 0 },
    }),
  );
  return root;
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('hardened MCP launcher', () => {
  it('preserves recovery sidecars and refuses to open their index', async () => {
    const root = await makeIndexedRepository();
    const sidecar = path.join(root, '.gitnexus', 'lbug.wal');
    await fs.writeFile(sidecar, 'recovery fixture');
    expect(() => execFileSync(process.execPath, [LAUNCHER], {
      env: { HOME: root, PATH: process.env.PATH ?? '', GITNEXUS_SAFE_REPOSITORY: root },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 8000,
    })).toThrow(/requires operator recovery/);
    expect(await fs.readFile(sidecar, 'utf8')).toBe('recovery fixture');
  });

  it('uses a fixed local index, exposes the reduced protocol, and exits with its child', async () => {
    const root = await makeIndexedRepository();
    const client = new Client({ name: 'hardened-launcher-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      cwd: REPOSITORY_ROOT,
      env: {
        HOME: path.join(root, 'home-without-registry'),
        PATH: process.env.PATH ?? '',
        GITNEXUS_SAFE_REPOSITORY: root,
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'auto',
      },
      stderr: 'pipe',
    });

    await client.connect(transport);
    const launcherPid = transport.pid;
    expect(launcherPid).not.toBeNull();
    const childPids = execFileSync('pgrep', ['-P', String(launcherPid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    expect(childPids).toHaveLength(1);
    const childCommand = execFileSync('ps', ['-p', String(childPids[0]), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    expect(childCommand).toContain('mcp-safe --repo');

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'query',
        'context',
        'detect_changes',
        'impact',
        'route_map',
        'tool_map',
        'shape_check',
        'api_impact',
      ]);
      expect(await client.listResources()).toEqual({ resources: [] });
      expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] });
      expect(await client.listPrompts()).toEqual({ prompts: [] });

      await expect(client.callTool({ name: 'cypher', arguments: { query: 'CREATE ()' } })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/not available/i) }],
      });
    } finally {
      await client.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isRunning(launcherPid!)).toBe(false);
    for (const childPid of childPids) {
      expect(isRunning(childPid)).toBe(false);
    }
  }, 30_000);

  it('uses the compiled local CLI directly, without npx or a runtime build step', async () => {
    const source = await fs.readFile(LAUNCHER, 'utf8');
    expect(source).toMatch(/path\.resolve\(scriptDir, '\.\.', 'dist', 'cli', 'index\.js'\)/);
    expect(source).not.toMatch(/\bnpx\b|npm\s+(?:run|exec)|tsx\b/);
  });
});
