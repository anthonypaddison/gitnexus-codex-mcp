#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configuredRoot = process.env.GITNEXUS_SAFE_REPOSITORY;
if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
  process.stderr.write('GITNEXUS_SAFE_REPOSITORY must be an absolute repository path.\n');
  process.exit(2);
}

const root = await realpath(configuredRoot);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(scriptDir, '..', 'dist', 'cli', 'index.js');
const localExtensionCacheEnvironment = {};
for (const name of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_DATA_HOME']) {
  const value = process.env[name];
  if (value) localExtensionCacheEnvironment[name] = value;
}
const child = spawn(process.execPath, [cliEntry, 'mcp-safe', '--repo', root], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    ...localExtensionCacheEnvironment,
    GITNEXUS_SAFE_REPOSITORY: root,
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
