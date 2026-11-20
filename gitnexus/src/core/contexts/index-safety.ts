import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rejectMacAcl, validateRepositoryRoot } from './config.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../storage/repo-manager.js';

const git = promisify(execFile);
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
      const run = async (args: string[]) =>
        (await git('git', args, { cwd: root, encoding: 'utf8', timeout: 3000 })).stdout.trim();
      const head = await run(['rev-parse', '--verify', 'HEAD']);
      if (head === indexedRevision) return { state: 'ready', indexedRevision, head };
      const [ahead, behind] = (await run(['rev-list', '--left-right', '--count', indexedRevision + '...HEAD']))
        .split(/\s+/).map(Number);
      return { state: 'stale', indexedRevision, head, ...(ahead === 0 ? { commitsBehind: behind } : {}) };
    } catch {
      return { state: 'unknown', indexedRevision };
    }
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'incompatible' };
  }
}
