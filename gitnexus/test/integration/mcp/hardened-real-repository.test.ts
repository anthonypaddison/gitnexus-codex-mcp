import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const realRepository = process.env.GITNEXUS_REAL_MCP_REPO;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITNEXUS_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAUNCHER = path.join(GITNEXUS_ROOT, 'scripts', 'gitnexus-local-safe-mcp.mjs');
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
    return true;
  } catch {
    return false;
  }
};

describe('hardened MCP real repository acceptance', () => {
  itIfRealRepository('serves the configured local index twice without network sockets', async () => {
    expect(fs.existsSync(path.join(realRepository!, '.gitnexus', 'meta.json'))).toBe(true);

    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new Client({ name: 'gitnexus-real-acceptance', version: '0.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [LAUNCHER],
        cwd: GITNEXUS_ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          GITNEXUS_SAFE_REPOSITORY: realRepository!,
          GITNEXUS_LBUG_EXTENSION_INSTALL: 'auto',
        },
        stderr: 'pipe',
      });

      await client.connect(transport);
      const pid = transport.pid;
      expect(pid).not.toBeNull();
      const childPids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(childPids).toHaveLength(1);
      expect(processHasInternetSocket(pid!)).toBe(false);
      expect(processHasInternetSocket(childPids[0])).toBe(false);

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

        const query = await client.callTool({
          name: 'query',
          arguments: { query: 'hardened MCP launcher', limit: 3 },
        });
        expect(query.isError).not.toBe(true);
        expect(query.content[0]?.text).toContain('processes');

        const switched = await client.callTool({
          name: 'query',
          arguments: { query: 'hardened MCP launcher', repo: '/tmp/other-repository' },
        });
        expect(switched).toMatchObject({
          isError: true,
          content: [{ text: expect.stringMatching(/fixed.*repository/i) }],
        });
      } finally {
        await client.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isRunning(pid!)).toBe(false);
      expect(isRunning(childPids[0])).toBe(false);
    }
  }, 60_000);
});
