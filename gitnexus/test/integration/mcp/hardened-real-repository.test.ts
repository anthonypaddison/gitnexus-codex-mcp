import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const realRepository = process.env.GITNEXUS_REAL_MCP_REPO;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITNEXUS_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAUNCHER = path.join(GITNEXUS_ROOT, 'scripts', 'gitnexus-codex-mcp.mjs');
const itIfRealRepository = realRepository ? it : it.skip;

const processHasInternetSocket = (pid: number): boolean => {
  try {
    const output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-i'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return false;
  }
};

const processArgs = (pid: number): string => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const serverChildPids = (launcherPid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(launcherPid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => {
        const args = processArgs(pid);
        return (
          Number.isInteger(pid) &&
          pid > 0 &&
          args.includes(path.join(GITNEXUS_ROOT, 'dist', 'cli', 'index.js')) &&
          args.includes('mcp-safe')
        );
      });
  } catch {
    return [];
  }
};

const isGitNexusServer = (pid: number): boolean => {
  const args = processArgs(pid);
  return (
    isRunning(pid) &&
    args.includes(path.join(GITNEXUS_ROOT, 'dist', 'cli', 'index.js')) &&
    args.includes('mcp-safe')
  );
};

const isLauncher = (pid: number): boolean => isRunning(pid) && processArgs(pid).includes(LAUNCHER);

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isRunning(pid);
};

const stopOwnedProcess = async (pid: number, isOwned: (pid: number) => boolean): Promise<boolean> => {
  if (!isOwned(pid)) return true;
  process.kill(pid, 'SIGTERM');
  if (await waitForExit(pid, 2_000)) return true;
  if (isOwned(pid)) process.kill(pid, 'SIGKILL');
  await waitForExit(pid, 2_000);
  return !isOwned(pid);
};

describe('hardened MCP real repository acceptance', () => {
  itIfRealRepository('exits the launcher and server after SIGTERM', async () => {
    const client = new Client({ name: 'gitnexus-signal-acceptance', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      cwd: GITNEXUS_ROOT,
      env: {
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        GITNEXUS_SAFE_REPOSITORY: realRepository!,
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
      },
      stderr: 'pipe',
    });

    let launcherPid: number | null = null;
    let serverPid: number | null = null;
    try {
      const connecting = client.connect(transport);
      launcherPid = transport.pid;
      await connecting;
      launcherPid = transport.pid ?? launcherPid;
      expect(launcherPid).toBeTypeOf('number');
      expect(launcherPid).toBeGreaterThan(0);
      const childPids = serverChildPids(launcherPid!);
      expect(childPids).toHaveLength(1);
      const childPid = childPids[0];
      serverPid = childPid;

      process.kill(launcherPid!, 'SIGTERM');
      expect(await waitForExit(launcherPid!, 5_000)).toBe(true);
      expect(await waitForExit(childPid, 5_000)).toBe(true);
    } finally {
      const childPids = serverPid
        ? [serverPid]
        : launcherPid && isLauncher(launcherPid)
          ? serverChildPids(launcherPid)
          : [];
      let cleaned = true;
      for (const pid of childPids) cleaned = (await stopOwnedProcess(pid, isGitNexusServer)) && cleaned;
      if (launcherPid) cleaned = (await stopOwnedProcess(launcherPid, isLauncher)) && cleaned;
      await client.close().catch(() => {});
      if (!cleaned) throw new Error('A test-owned MCP process remained after bounded cleanup');
    }
  }, 15_000);

  itIfRealRepository('exits after the launcher is killed while client stdin stays open', async () => {
    const pipeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-parent-loss-'));
    const pipePath = path.join(pipeDir, 'client-stdin');
    let clientStdin: number | null = null;
    let launcherPid: number | null = null;
    let serverPid: number | null = null;

    try {
      execFileSync('mkfifo', [pipePath]);
      clientStdin = fs.openSync(pipePath, fs.constants.O_RDWR);
      const launcher = spawn(process.execPath, [LAUNCHER], {
        cwd: GITNEXUS_ROOT,
        env: {
          HOME: process.env.HOME ?? '',
          PATH: process.env.PATH ?? '',
          GITNEXUS_SAFE_REPOSITORY: realRepository!,
        },
        stdio: [clientStdin, 'pipe', 'pipe'],
      });
      launcherPid = launcher.pid ?? null;
      let launcherError: Error | null = null;
      launcher.on('error', (error) => {
        launcherError = error;
      });
      expect(launcherPid).toBeTypeOf('number');
      expect(launcherPid).toBeGreaterThan(0);

      const childDeadline = Date.now() + 3_000;
      while (serverChildPids(launcherPid!).length === 0 && Date.now() < childDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const childPids = serverChildPids(launcherPid!);
      expect(childPids).toHaveLength(1);
      serverPid = childPids[0];

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MCP initialize timed out')), 5_000);
        let response = '';
        launcher.stdout.on('data', (chunk: Buffer) => {
          response += chunk.toString();
          if (
            !response.split('\n').some((line) => line.includes('"id":1') && line.includes('"result"'))
          ) return;
          clearTimeout(timeout);
          resolve();
        });
        launcher.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        if (launcherError) {
          clearTimeout(timeout);
          reject(launcherError);
          return;
        }
        fs.writeSync(
          clientStdin,
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'gitnexus-parent-loss-test', version: '0.0.0' },
            },
          }) + '\n',
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isLauncher(launcherPid!)).toBe(true);
      expect(isGitNexusServer(serverPid)).toBe(true);
      process.kill(launcherPid!, 'SIGKILL');

      expect(await waitForExit(serverPid, 5_000)).toBe(true);
    } finally {
      const childPids = serverPid
        ? [serverPid]
        : launcherPid && isLauncher(launcherPid)
          ? serverChildPids(launcherPid)
          : [];
      let cleaned = true;
      for (const pid of childPids) cleaned = (await stopOwnedProcess(pid, isGitNexusServer)) && cleaned;
      if (launcherPid) cleaned = (await stopOwnedProcess(launcherPid, isLauncher)) && cleaned;
      if (clientStdin !== null) fs.closeSync(clientStdin);
      fs.rmSync(pipeDir, { recursive: true, force: true });
      if (!cleaned) throw new Error('A test-owned MCP process remained after bounded cleanup');
    }
  }, 15_000);

  itIfRealRepository('serves the configured local index twice without network sockets', async () => {
    expect(fs.existsSync(path.join(realRepository!, '.gitnexus', 'meta.json'))).toBe(true);

    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new Client({ name: 'gitnexus-real-acceptance', version: '0.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [LAUNCHER],
        cwd: GITNEXUS_ROOT,
        env: {
          HOME: process.env.HOME ?? '',
          PATH: process.env.PATH ?? '',
          GITNEXUS_SAFE_REPOSITORY: realRepository!,
          GITNEXUS_LBUG_EXTENSION_INSTALL: 'auto',
        },
        stderr: 'pipe',
      });

      let pid: number | null = null;
      let childPids: number[] = [];
      let closeRequested = false;
      try {
        const connecting = client.connect(transport);
        pid = transport.pid;
        await connecting;
        pid = transport.pid ?? pid;
        expect(pid).not.toBeNull();
        childPids = serverChildPids(pid!);
        expect(childPids).toHaveLength(1);
        expect(processHasInternetSocket(pid!)).toBe(false);
        expect(processHasInternetSocket(childPids[0])).toBe(false);

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

        const query = await client.callTool({
          name: 'query',
          arguments: { query: 'mcpSafeCommand', limit: 3 },
        });
        expect(query.isError).not.toBe(true);
        expect(query.content[0]?.text).toContain('mcpSafeCommand');
        expect(query.content[0]?.text).not.toContain('FTS indexes missing');

        const switched = await client.callTool({
          name: 'query',
          arguments: { query: 'mcpSafeCommand', repo: '/tmp/other-repository' },
        });
        expect(switched).toMatchObject({
          isError: true,
          content: [{ text: expect.stringMatching(/fixed.*repository/i) }],
        });

        closeRequested = true;
        const closedInTime = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 5_000);
          void client.close().then(
            () => {
              clearTimeout(timeout);
              resolve(true);
            },
            () => {
              clearTimeout(timeout);
              resolve(false);
            },
          );
        });
        expect(closedInTime).toBe(true);
        expect(await waitForExit(pid!, 5_000)).toBe(true);
        expect(await waitForExit(childPids[0], 5_000)).toBe(true);
      } finally {
        let cleaned = true;
        for (const childPid of childPids) {
          cleaned = (await stopOwnedProcess(childPid, isGitNexusServer)) && cleaned;
        }
        if (pid) cleaned = (await stopOwnedProcess(pid, isLauncher)) && cleaned;
        if (!closeRequested) await client.close().catch(() => {});
        if (!cleaned) throw new Error('A test-owned MCP process remained after bounded cleanup');
      }
      expect(pid && isRunning(pid)).toBe(false);
      expect(childPids.every((childPid) => !isGitNexusServer(childPid))).toBe(true);
    }
  }, 60_000);
});
