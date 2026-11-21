import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const registryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return { ...actual, listRegisteredRepos: registryMock };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const fixtures: string[] = [];

async function makeIndexedRepository(name: string): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-hardened-backend-'));
  const root = path.join(parent, name);
  await fs.mkdir(root);
  fixtures.push(parent);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await fs.mkdir(path.join(root, '.gitnexus', 'lbug'), { recursive: true });
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

afterEach(async () => {
  registryMock.mockReset();
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('LocalBackend hardened mode', () => {
  it('loads only the configured local index and never reads the global registry', async () => {
    const root = await makeIndexedRepository('repository-a');
    registryMock.mockRejectedValue(new Error('global registry must not be consulted'));
    const backend = new LocalBackend({ repositoryRoot: root });

    await expect(backend.init()).resolves.toBe(true);
    expect(registryMock).not.toHaveBeenCalled();
    expect(backend.getContext()?.projectName).toBe(path.basename(root));
  });

  it('cannot enumerate or select a second indexed repository', async () => {
    const root = await makeIndexedRepository('repository-a');
    const otherRoot = await makeIndexedRepository('repository-b');
    const backend = new LocalBackend({ repositoryRoot: root });
    await backend.init();

    expect(backend.getContext()?.projectName).toBe('repository-a');
    await expect(backend.resolveRepo(otherRoot)).rejects.toThrow(/fixed/i);
    await expect(backend.callTool('query', { query: 'anything', repo: otherRoot })).rejects.toThrow(
      /fixed/i,
    );
    await expect(backend.callTool('detect_changes', { worktree: otherRoot })).rejects.toThrow(/fixed/i);
    await expect(backend.callTool('list_repos', {})).rejects.toThrow(/not available/i);
    await expect(backend.callTool('rename', { new_name: 'replacement' })).rejects.toThrow(
      /not available/i,
    );
  });
});
