import * as fs from 'node:fs/promises';
import path from 'node:path';
import { rejectMacAcl, validateRepositoryRoot, type ContextRepository } from './config.js';
import { compareLiveFreshness, readCheckoutGit } from './live-freshness.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../storage/repo-manager.js';

const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ContextIndexStatus {
  state: 'ready' | 'missing' | 'moved' | 'unsafe' | 'incompatible' | 'stale' | 'unknown' | 'recovery_required';
  indexedRevision?: string;
  head?: string;
  commitsBehind?: number;
}

export async function inspectContextIndex(
  parent: string,
  root: string,
  identity?: { device: string; inode: string },
): Promise<ContextIndexStatus> {
  try {
    const stat = await fs.lstat(root, { bigint: true });
    if (identity && (String(stat.dev) !== identity.device || String(stat.ino) !== identity.inode)) {
      return { state: 'moved' };
    }
    await validateRepositoryRoot(root, parent);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe' };
  }

  const index = path.join(root, '.gitnexus');
  const metadata = path.join(index, 'meta.json');
  const database = path.join(index, 'lbug');
  try {
    for (const [file, directory] of [[index, true], [metadata, false], [database, false]] as const) {
      const stat = await fs.lstat(file);
      if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
          stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
          (await fs.realpath(file)) !== file) return { state: 'unsafe' };
      try {
        await rejectMacAcl(file);
      } catch {
        return { state: 'unsafe' };
      }
    }
    for (const suffix of ['.wal', '.shadow']) {
      try {
        await fs.lstat(database + suffix);
        return { state: 'recovery_required' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unsafe' };
      }
    }
    const info = await fs.lstat(metadata);
    if (info.size > 4 * 1024 * 1024) return { state: 'incompatible' };
    const meta = JSON.parse(await fs.readFile(metadata, 'utf8'));
    if (meta.repoPath !== root || typeof meta.lastCommit !== 'string' ||
        !revision.test(meta.lastCommit) || meta.incrementalInProgress ||
        (meta.schemaVersion !== undefined && meta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION)) {
      return { state: 'incompatible' };
    }

    const indexedRevision: string = meta.lastCommit;
    try {
      const head = await readCheckoutGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (head === indexedRevision) return { state: 'ready', indexedRevision, head };
      const [ahead, behind] = (await readCheckoutGit(root, [
        'rev-list', '--left-right', '--count', `${indexedRevision}...${head}`, '--',
      ])).split(/\s+/).map(Number);
      return { state: 'stale', indexedRevision, head, ...(ahead === 0 ? { commitsBehind: behind } : {}) };
    } catch {
      return { state: 'unknown', indexedRevision };
    }
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'incompatible' };
  }
}

// Index safety is checked against the indexed checkout itself. Live freshness is
// independent, so an older but intact snapshot can still answer with a label.
export async function inspectContextRepository(parent: string, repository: ContextRepository) {
  const index = await inspectContextIndex(parent, repository.root, repository.identity);
  const freshness = await compareLiveFreshness(index.indexedRevision, repository.liveRoot);
  return { ...index, freshness };
}
