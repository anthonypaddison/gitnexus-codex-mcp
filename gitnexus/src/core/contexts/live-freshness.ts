import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);
const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface LiveFreshness {
  status: 'current' | 'behind' | 'ahead/diverged' | 'unknown';
  liveHead?: string;
  commitsBehind?: number;
}

/** Read only local Git data, without inherited repository redirects or object downloads. */
export async function readCheckoutGit(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  const { stdout } = await git('git', ['--no-replace-objects', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_GRAFT_FILE: os.devNull,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '',
    },
  });
  return stdout.trim();
}

/** Compare an indexed commit against an explicitly mapped, canonical live checkout. */
export async function compareLiveFreshness(
  indexedRevision: string | undefined,
  liveRoot: string | undefined,
): Promise<LiveFreshness> {
  if (!liveRoot || !path.isAbsolute(liveRoot) || path.resolve(liveRoot) !== liveRoot) {
    return { status: 'unknown' };
  }

  let liveHead: string | undefined;
  try {
    if (await fs.realpath(liveRoot) !== liveRoot) return { status: 'unknown' };
    const topLevel = await readCheckoutGit(liveRoot, ['rev-parse', '--show-toplevel']);
    if (path.resolve(topLevel) !== liveRoot) return { status: 'unknown' };
    liveHead = await readCheckoutGit(liveRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!revision.test(liveHead)) return { status: 'unknown' };
    if (!indexedRevision || !revision.test(indexedRevision)) return { status: 'unknown', liveHead };
    if (liveHead === indexedRevision) return { status: 'current', liveHead };

    if (await readCheckoutGit(liveRoot, ['cat-file', '-t', indexedRevision]) !== 'commit' ||
        await readCheckoutGit(liveRoot, ['rev-parse', '--is-shallow-repository']) !== 'false') {
      return { status: 'unknown', liveHead };
    }
    const counts = await readCheckoutGit(liveRoot, [
      'rev-list', '--left-right', '--count', `${indexedRevision}...${liveHead}`, '--',
    ]);
    const match = /^(\d+)\s+(\d+)$/.exec(counts);
    if (!match) return { status: 'unknown', liveHead };
    const [, indexedOnly, liveOnly] = match.map(Number);
    if (!Number.isSafeInteger(indexedOnly) || !Number.isSafeInteger(liveOnly)) {
      return { status: 'unknown', liveHead };
    }
    if (indexedOnly === 0 && liveOnly > 0) {
      return { status: 'behind', liveHead, commitsBehind: liveOnly };
    }
    return { status: indexedOnly > 0 ? 'ahead/diverged' : 'unknown', liveHead };
  } catch {
    return { status: 'unknown', ...(liveHead ? { liveHead } : {}) };
  }
}
