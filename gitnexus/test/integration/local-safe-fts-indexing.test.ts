import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { closeLbug, executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('local-safe FTS indexing', () => {
  it('builds queryable FTS indexes from a synthetic repository without honoring inherited auto', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fts-indexing-'));
    temporaryRoots.push(root);
    const isolatedHome = path.join(root, 'gitnexus-home');
    const previousHome = process.env.GITNEXUS_HOME;
    const previousInstallPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    const repoId = `local-safe-fts-${Date.now()}`;

    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src', 'local-safe.ts'),
        'export function localSafeKnownSymbol(): string { return "local FTS proof"; }\n',
      );
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'fixture'], {
        cwd: root,
      });

      process.env.GITNEXUS_HOME = isolatedHome;
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'auto';

      await runFullAnalysis(
        root,
        { force: true, skipAgentsMd: true, skipSkills: true, workerPoolSize: 0 },
        { onProgress: () => {} },
      );

      const { lbugPath } = getStoragePaths(root);
      await initLbug(repoId, lbugPath);

      for (const { table, indexName } of FTS_INDEXES) {
        await expect(
          executeParameterized(
            repoId,
            `CALL QUERY_FTS_INDEX('${table}', '${indexName}', $query, conjunctive := false) RETURN node.id AS id LIMIT 1`,
            { query: 'localSafeKnownSymbol' },
          ),
        ).resolves.toBeInstanceOf(Array);
      }

      const response = await searchFTSFromLbug('localSafeKnownSymbol', 5, repoId);
      expect(response.ftsAvailable).toBe(true);
      expect(response.results.map((result) => result.filePath)).toContain('src/local-safe.ts');
    } finally {
      await closeLbug(repoId);
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      if (previousInstallPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = previousInstallPolicy;
    }
  }, 120_000);
});
