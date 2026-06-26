import { existsSync, cpSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, '..');
const repoRoot = resolve(webDir, '..');
const gitnexusDir = resolve(repoRoot, 'gitnexus');
const gitnexusDistCli = join(gitnexusDir, 'dist/cli/index.js');
const tsxBin = join(gitnexusDir, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const fixtureSrc = join(gitnexusDir, 'test/fixtures/mini-repo/src');
const runRoot = resolve(process.env.GITNEXUS_E2E_ROOT ?? join(tmpdir(), 'gitnexus-edge-e2e'));
const gitnexusHome = join(runRoot, 'home');
const fixtureRepo = join(runRoot, 'repo');

function fail(message) {
  console.error(`[e2e-local-gitnexus] ${message}`);
  process.exit(1);
}

if (!existsSync(join(gitnexusDir, 'package.json'))) {
  fail(`Expected local GitNexus package at ${gitnexusDir}`);
}

if (!existsSync(gitnexusDistCli)) {
  fail(`Expected local built GitNexus CLI at ${gitnexusDistCli}. Run npm run build in ${gitnexusDir}.`);
}

if (!existsSync(tsxBin)) {
  fail(`Expected local tsx binary at ${tsxBin}. Run npm install in ${gitnexusDir}.`);
}

if (!existsSync(fixtureSrc)) {
  fail(`Expected E2E fixture at ${fixtureSrc}`);
}

console.log(`[e2e-local-gitnexus] GitNexus package: ${realpathSync(gitnexusDir)}`);
console.log(`[e2e-local-gitnexus] GitNexus home: ${gitnexusHome}`);

rmSync(runRoot, { recursive: true, force: true });
mkdirSync(fixtureRepo, { recursive: true });
cpSync(fixtureSrc, join(fixtureRepo, 'src'), { recursive: true });
writeFileSync(
  join(fixtureRepo, 'package.json'),
  '{"name":"e2e-mini-repo","version":"0.0.0","private":true}\n',
);

const analyze = spawnSync(
  process.execPath,
  [gitnexusDistCli, 'analyze', fixtureRepo, '--skip-git', '--skip-agents-md', '--name', 'e2e-mini-repo'],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITNEXUS_HOME: gitnexusHome,
    },
    stdio: 'inherit',
  },
);

if (analyze.status !== 0) {
  process.exit(analyze.status ?? 1);
}

const server = spawn(tsxBin, ['src/cli/index.ts', 'serve'], {
  cwd: gitnexusDir,
  env: {
    ...process.env,
    GITNEXUS_HOME: gitnexusHome,
  },
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

server.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }

    stopping = true;
    try {
      if (process.platform === 'win32') {
        server.kill(signal);
      } else {
        process.kill(-server.pid, signal);
      }
    } catch {
      // The server may have already exited after Playwright completed.
    }

    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
