import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RefreshRunner } from './refresh.js';

type Candidate = { root: string; home: string; run: RefreshRunner };

const entry = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('../../cli/index.js', import.meta.url));

async function copyLocalFts(home: string): Promise<void> {
  const platform = process.platform === 'darwin' ? 'osx' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const cache = path.join(os.homedir(), '.lbdb', 'extension');
  const versions = await fs.readdir(cache).catch(() => [] as string[]);
  let copied = false;
  for (const version of versions) {
    if (!/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(version)) continue;
    const leaf = path.join(version, `${platform}_${arch}`, 'fts', 'libfts.lbug_extension');
    const source = path.join(cache, leaf);
    const stat = await fs.lstat(source).catch(() => undefined);
    if (!stat) continue;
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 ||
        await fs.realpath(source) !== source) {
      throw new Error('The cached LadybugDB FTS extension is not an owner-controlled regular file.');
    }
    const target = path.join(home, '.lbdb', 'extension', leaf);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
    copied = true;
  }
  if (!copied) throw new Error('No local LadybugDB FTS extension is available for offline refresh.');
}

function engineOptions({ root, home }: Candidate) {
  return {
    cwd: root,
    home,
    writableRoots: [root, home],
    env: { GITNEXUS_HOME: path.join(home, '.gitnexus'), GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only' },
  };
}

export async function buildRefreshIndex(candidate: Candidate): Promise<void> {
  await copyLocalFts(candidate.home);
  await candidate.run(process.execPath, [entry, 'index', candidate.root], engineOptions(candidate));
}

export async function verifyRefreshQuery(candidate: Candidate): Promise<void> {
  await candidate.run(process.execPath, [entry, 'query', candidate.root], {
    ...engineOptions(candidate), writableRoots: [candidate.home],
  });
}

// Run the existing CLI and the read-only probe in separate offline child processes.
if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  process.umask(0o077);
  const [, , action, root] = process.argv;
  if (action === 'index') {
    process.argv = [process.execPath, cli, 'analyze', '--index-only', root];
    await import('../../cli/index.js');
  } else if (action === 'query') {
    const { LocalBackend } = await import('../../mcp/local/local-backend.js');
    const backend = new LocalBackend({ repositoryRoot: root, strictReadOnly: true });
    try {
      await backend.init();
      const result = await backend.callTool('query', { query: 'gitnexus', limit: 1, max_symbols: 1 });
      if (result?.error || result?.warning || !Array.isArray(result?.definitions)) {
        throw new Error('Candidate index failed its read-only FTS query.');
      }
    } finally {
      await backend.disconnect();
    }
  } else {
    throw new Error('Unknown internal refresh action.');
  }
}
