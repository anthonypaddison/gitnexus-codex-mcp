#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configuredRoot = process.env.GITNEXUS_SAFE_REPOSITORY;
const contextConfig = process.env.GITNEXUS_SAFE_CONTEXT_CONFIG;
const configuredPath = contextConfig ?? configuredRoot;
if (Boolean(configuredRoot) === Boolean(contextConfig) || !configuredPath || !path.isAbsolute(configuredPath)) {
  process.stderr.write('Set exactly one absolute path in GITNEXUS_SAFE_REPOSITORY or GITNEXUS_SAFE_CONTEXT_CONFIG.\n');
  process.exit(2);
}

const root = configuredRoot ? await realpath(configuredRoot) : undefined;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(scriptDir, '..', 'dist', 'cli', 'index.js');
const localExtensionCacheEnvironment = {};
for (const name of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_DATA_HOME']) {
  const value = process.env[name];
  if (value) localExtensionCacheEnvironment[name] = value;
}
const selection = contextConfig ? ['--contexts', contextConfig] : ['--repo', root];
const child = spawn(process.execPath, [cliEntry, 'mcp-safe', ...selection], {
  cwd: root ?? process.cwd(),
  env: {
    PATH: process.env.PATH,
    ...localExtensionCacheEnvironment,
    ...(root ? { GITNEXUS_SAFE_REPOSITORY: root } : {}),
    GITNEXUS_PARENT_LIVENESS_FD: '3',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
    GITNEXUS_LOG_LEVEL: 'warn',
  },
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
child.on('error', (error) => {
  process.stderr.write(`Unable to start hardened GitNexus MCP: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
