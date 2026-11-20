/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Loads all indexed repos from the global registry.
 * No longer depends on cwd — works from any directory.
 *
 * IMPORTANT: this module's static-import closure is intentionally tiny
 * (one chain: `mcp/stdio-context.js` → `mcp/stdio-capture.js`, which is a
 * leaf with zero non-`node:` imports). All heavy backend modules
 * (`startMCPServer`, `LocalBackend`, `warnMissingOptionalGrammars`) load
 * via `await import(...)` AFTER `installGlobalStdoutSentinel()` runs.
 *
 * This closes the ESM-evaluation-order window where native init banners
 * from `@ladybugdb/core` (or any future heavy import) could reach raw
 * stdout before the sentinel exists. Codex's adversarial review on
 * PR #1383 found that even with the sentinel-install call as the first
 * statement of `mcpCommand`, ESM evaluates static imports of THIS module
 * before the function body runs — so any native side effects during
 * those imports happen before the sentinel can intercept them.
 *
 * If you find yourself adding a static `import` to this file, ask
 * whether the imported module (or anything it transitively imports)
 * touches `process.stdout` or loads a native binding at module init. If
 * either is true, switch it to a dynamic `await import(...)` inside
 * `mcpCommand` after the sentinel install. The regression test at
 * `gitnexus/test/integration/mcp/import-closure.test.ts` enforces this.
 */

import { installGlobalStdoutSentinel } from '../mcp/stdio-context.js';

export interface McpSafeOptions {
  repo?: string;
  contexts?: string;
}

export const mcpCommand = async () => {
  // Install the global stdout sentinel as the very first thing — before
  // ANY other module loads. The static-import closure above is leaf-only
  // (stdio-context → stdio-capture, zero non-`node:` deps), so this is
  // also the first chance any code in this process has to write to stdout.
  installGlobalStdoutSentinel();

  // uncaughtException/unhandledRejection handlers are owned by
  // startMCPServer (gitnexus/src/mcp/server.ts) so the server's shutdown
  // path runs cleanly with full stack traces. Registering duplicates here
  // would only produce noisy double-logging on the same exception.

  // Dynamically import heavy backend modules AND the pino logger AFTER
  // the sentinel installs. The logger is dynamic-imported (rather than
  // static) to preserve the leaf-only static-import closure documented at
  // the top of this file — `core/logger.js` itself doesn't write to
  // stdout at module init, but transitive deps (pino, pino-pretty, the
  // worker-thread transport) could in theory, and the import-closure
  // regression test enforces the leaf invariant.
  const [{ startMCPServer }, { LocalBackend }, { logger }] = await Promise.all([
    import('../mcp/server.js'),
    import('../mcp/local/local-backend.js'),
    import('../core/logger.js'),
  ]);

  // Missing-optional-grammar warnings are intentionally NOT emitted here.
  // `gitnexus analyze` already warns at index time, filtered by the repo's
  // actual extensions, and a repo can only be served by MCP after analyze
  // has run. Repeating an unconditional warning at every MCP startup is
  // pure noise for users whose indexed repos don't use Dart/Proto.

  // Initialize multi-repo backend from registry.
  // The server starts even with 0 repos — tools call refreshRepos() lazily,
  // so repos indexed after the server starts are discovered automatically.
  const backend = new LocalBackend();
  await backend.init();

  const repos = await backend.listRepos();
  if (repos.length === 0) {
    // Operator-actionable but the server still starts and serves; warn-level,
    // not error. Tools will discover newly-analyzed repos via lazy refresh.
    logger.warn(
      'GitNexus: No indexed repos yet. Run `gitnexus analyze` in a git repo — the server will pick it up automatically.',
    );
  } else {
    logger.info(
      { repoCount: repos.length, repos: repos.map((r) => r.name) },
      'GitNexus: MCP server starting',
    );
  }

  // Start MCP server (serves all repos, discovers new ones lazily)
  await startMCPServer(backend);
};

/**
 * Start a single-repository MCP process. It validates the configured git root
 * and its colocated .gitnexus metadata before opening the backend, never reads
 * the global registry, and forces optional extension installation off.
 */
export const mcpSafeCommand = async (options: McpSafeOptions) => {
  installGlobalStdoutSentinel();

  if (Boolean(options?.repo) === Boolean(options?.contexts)) {
    throw new Error('mcp-safe requires exactly one of --repo or --contexts.');
  }

  if (options.contexts) {
    // Git environment overrides can redirect metadata and worktree reads.
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    process.env.GIT_OPTIONAL_LOCKS = '0';
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'load-only';
    const [{ loadContextConfig }, { ContextRouter, CONTEXT_MCP_TOOLS }, { startMCPServer }] =
      await Promise.all([
        import('../core/contexts/config.js'),
        import('../mcp/context-router.js'),
        import('../mcp/server.js'),
      ]);
    if (!(await import('node:path')).isAbsolute(options.contexts)) {
      throw new Error('mcp-safe --contexts requires an absolute policy path.');
    }
    const config = await loadContextConfig(options.contexts);
    await startMCPServer(new ContextRouter(config), { hardened: true, tools: CONTEXT_MCP_TOOLS });
    return;
  }

  const [{ realpath, lstat }, pathModule, { getGitRoot }, { startMCPServer }, { LocalBackend }] =
    await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
      import('../storage/git.js'),
      import('../mcp/server.js'),
      import('../mcp/local/local-backend.js'),
    ]);

  if (!pathModule.isAbsolute(options.repo)) {
    throw new Error('mcp-safe --repo must be an absolute path.');
  }
  const repoPath = await realpath(options.repo);
  if (!(await lstat(repoPath)).isDirectory()) {
    throw new Error(`mcp-safe --repo is not a directory: ${repoPath}`);
  }
  const gitRoot = getGitRoot(repoPath);
  if (!gitRoot || (await realpath(gitRoot)) !== repoPath) {
    throw new Error(`mcp-safe --repo must be a git repository root: ${repoPath}`);
  }

  // This is a process-level guard for all runtime extension callers. The
  // hardened backend has no indexing path and no MCP tool can override it.
  process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'load-only';

  const backend = new LocalBackend({ repositoryRoot: repoPath });
  await backend.init();
  await startMCPServer(backend, { hardened: true });
};
