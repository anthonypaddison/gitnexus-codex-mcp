import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRegularFileWithinRoot } from '../../src/core/security/repository-paths.js';
import { readFileContents } from '../../src/core/ingestion/filesystem-walker.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const fixtureRoots: string[] = [];

async function makeFixture(): Promise<{ root: string; outside: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-paths-'));
  fixtureRoots.push(parent);
  const root = path.join(parent, 'repository');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'normal.ts'), 'normal');
  await fs.writeFile(path.join(root, 'nested', 'valid.ts'), 'nested');
  await fs.writeFile(path.join(outside, 'secret.ts'), 'outside');
  await fs.symlink(path.join(outside, 'secret.ts'), path.join(root, 'linked.ts'));
  await fs.symlink(outside, path.join(root, 'linked-directory'));
  await fs.symlink(path.join(outside, 'missing.ts'), path.join(root, 'broken.ts'));
  return { root, outside };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('resolveRegularFileWithinRoot', () => {
  it('allows normal and nested regular files', async () => {
    const { root } = await makeFixture();
    const canonicalRoot = await fs.realpath(root);

    await expect(resolveRegularFileWithinRoot(root, 'normal.ts')).resolves.toBe(
      path.join(canonicalRoot, 'normal.ts'),
    );
    await expect(resolveRegularFileWithinRoot(root, 'nested/valid.ts')).resolves.toBe(
      path.join(canonicalRoot, 'nested', 'valid.ts'),
    );
  });

  it.each([
    ['parent traversal', '../outside/secret.ts'],
    ['absolute path', '/tmp/not-a-repository-file.ts'],
    ['direct file symlink', 'linked.ts'],
    ['nested directory symlink', 'linked-directory/secret.ts'],
    ['broken symlink', 'broken.ts'],
  ])('rejects %s', async (_label, target) => {
    const { root } = await makeFixture();

    await expect(resolveRegularFileWithinRoot(root, target)).rejects.toThrow();
  });

  it('keeps the ingestion content reader inside the same boundary', async () => {
    const { root } = await makeFixture();

    const contents = await readFileContents(root, [
      'normal.ts',
      'nested/valid.ts',
      '../outside/secret.ts',
      '/tmp/not-a-repository-file.ts',
      'linked.ts',
      'linked-directory/secret.ts',
      'broken.ts',
    ]);

    expect([...contents.entries()]).toEqual([
      ['normal.ts', 'normal'],
      ['nested/valid.ts', 'nested'],
    ]);
  });

  it('does not let the legacy rename implementation write through a file symlink', async () => {
    const { root, outside } = await makeFixture();
    const outsideFile = path.join(outside, 'secret.ts');
    const backend = new LocalBackend() as any;
    backend.ensureInitialized = vi.fn().mockResolvedValue(undefined);
    backend.context = vi.fn().mockResolvedValue({
      symbol: { name: 'outside', filePath: 'linked.ts', startLine: 1 },
      incoming: { calls: [], imports: [], extends: [], implements: [] },
    });

    const result = await backend.rename(
      { id: 'fixture', repoPath: root },
      { symbol_name: 'outside', new_name: 'renamed', dry_run: false },
    );

    expect(result).toMatchObject({ applied: true, files_affected: 0, changes: [] });
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });
});
