import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  DEFAULT_CONTEXT_CONFIG_PATH,
  discoverRepositories,
  loadContextConfig,
  saveContextConfig,
  validateContextName,
  validateRepositoryRoot,
  type ContextConfig,
} from '../core/contexts/config.js';
import { inspectContextRepository } from '../core/contexts/index-safety.js';

export function registerContextCommands(program: Command): void {
  const contexts = program
    .command('contexts')
    .description('Manage explicitly approved local repository contexts')
    .option('--config <file>', 'Owner-only context policy file', DEFAULT_CONTEXT_CONFIG_PATH);
  const configFile = (): string => path.resolve(contexts.opts<{ config: string }>().config);
  const load = (): Promise<ContextConfig> => loadContextConfig(configFile());
  const save = (config: ContextConfig): Promise<void> => saveContextConfig(config, configFile());

  contexts
    .command('setup')
    .description('Select a parent and discover candidates; does not approve or index repositories')
    .option('--parent <directory>', 'Parent directory to discover beneath')
    .action(async (options: { parent?: string }) => {
      try {
        await fs.lstat(configFile());
        throw new Error('A context policy already exists. Use approve, add, remove or use to change it.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      let selected = options.parent;
      if (!selected) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error('Select a parent explicitly with --parent <directory>.');
        }
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          selected = await prompt.question('Parent directory to discover beneath: ');
        } finally {
          prompt.close();
        }
        if (!selected.trim()) throw new Error('No parent selected; no policy created.');
      }
      const parent = await fs.realpath(path.resolve(selected));
      const candidates = await discoverRepositories(parent);
      const config: ContextConfig = { version: 1, parent, repositories: {}, contexts: {} };
      await save(config);
      console.log(`Created owner-only policy: ${configFile()}`);
      console.log(`Parent: ${parent}`);
      console.log(`Discovered ${candidates.length} candidate repositories; none approved.`);
      for (const root of candidates) console.log(`  ${path.relative(parent, root)}  ${root}`);
      console.log('Approve each chosen repository with: gitnexus contexts approve <name> <root>');
      console.log('Then add approved names with: gitnexus contexts add <context> <name>');
    });

  contexts
    .command('approve <name> <root>')
    .description('Explicitly approve or reapprove one repository root and its directory identity')
    .action(async (name: string, root: string) => {
      validateContextName(name);
      const config = await load();
      const resolved = path.resolve(root);
      const identity = await validateRepositoryRoot(resolved, config.parent);
      if (Object.entries(config.repositories).some(([other, repo]) => other !== name && repo.root === resolved)) {
        throw new Error('This root is already approved under another name.');
      }
      const previous = config.repositories[name];
      const liveRoot = previous?.root === resolved ? previous.liveRoot : undefined;
      config.repositories[name] = { root: resolved, identity, ...(liveRoot ? { liveRoot } : {}) };
      await save(config);
      console.log(`Approved ${name}: ${resolved}`);
      console.log('No index was created or changed.');
    });

  contexts
    .command('add <context> <repository>')
    .description('Add an already-approved repository to a named context')
    .action(async (name: string, repository: string) => {
      validateContextName(name);
      const config = await load();
      if (!Object.hasOwn(config.repositories, repository)) {
        throw new Error(`Repository ${repository} is not approved. Run contexts approve first.`);
      }
      const approved = config.repositories[repository];
      const identity = await validateRepositoryRoot(approved.root, config.parent);
      if (identity.device !== approved.identity.device || identity.inode !== approved.identity.inode) {
        throw new Error(`Repository ${repository} was replaced; explicitly reapprove it first.`);
      }
      const members = config.contexts[name] ?? [];
      if (!members.includes(repository) && members.length >= 16) {
        throw new Error('A context can contain at most 16 repositories.');
      }
      if (!members.includes(repository)) members.push(repository);
      config.contexts[name] = members;
      await save(config);
      console.log(`Added ${repository} to ${name}.`);
    });

  contexts
    .command('remove <context> <repository>')
    .description('Remove repository membership without deleting repository files or indexes')
    .action(async (name: string, repository: string) => {
      const config = await load();
      if (!Object.hasOwn(config.contexts, name) || !config.contexts[name].includes(repository)) {
        throw new Error(`${repository} is not a member of ${name}.`);
      }
      config.contexts[name] = config.contexts[name].filter((member) => member !== repository);
      await save(config);
      console.log(`Removed ${repository} from ${name}.`);
    });

  contexts
    .command('revoke <repository>')
    .description('Revoke approval and all context memberships without deleting files or indexes')
    .action(async (repository: string) => {
      const config = await load();
      if (!Object.hasOwn(config.repositories, repository)) throw new Error(`Unknown repository: ${repository}`);
      delete config.repositories[repository];
      for (const name of Object.keys(config.contexts)) {
        config.contexts[name] = config.contexts[name].filter((member) => member !== repository);
      }
      await save(config);
      console.log(`Revoked approval for ${repository} and removed its context memberships.`);
    });

  contexts
    .command('use <context>')
    .description('Select the active context for future scoped calls')
    .action(async (name: string) => {
      const config = await load();
      if (!Object.hasOwn(config.contexts, name)) throw new Error(`Unknown context: ${name}`);
      config.activeContext = name;
      await save(config);
      console.log(`Active context: ${name}`);
    });

  contexts
    .command('list')
    .description('List configured contexts and approved repository names')
    .action(async () => {
      const config = await load();
      console.log(`Parent: ${config.parent}`);
      console.log(`Active context: ${config.activeContext ?? '(none)'}`);
      for (const [name, members] of Object.entries(config.contexts)) {
        console.log(`${name === config.activeContext ? '*' : ' '} ${name}: ${members.join(', ') || '(empty)'}`);
      }
      console.log('Approved repositories:');
      for (const [name, repository] of Object.entries(config.repositories)) console.log(`  ${name}: ${repository.root}`);
    });

  contexts
    .command('refresh <repository>')
    .description('Build and activate a private snapshot for one approved repository')
    .requiredOption('--expect-head <commit>', 'Exact full commit ID of the live checkout')
    .action(async (alias: string, options: { expectHead: string }) => {
      const { refreshContextRepository } = await import('../core/contexts/refresh.js');
      const result = await refreshContextRepository({ alias, expectHead: options.expectHead, configFile: configFile() });
      console.log(`Refreshed ${result.alias} at ${result.head}: ${result.root}`);
      console.log(`Previous snapshot retained: ${result.previousRoot}`);
      console.log(`Previous policy backup: ${result.policyBackup}`);
      console.log('Start a new MCP connection to use the refreshed snapshot.');
    });

  contexts
    .command('status')
    .description('Report policy and index freshness without opening or creating indexes')
    .action(async () => {
      const config = await load();
      console.log(`Policy: ${configFile()}`);
      console.log(`Parent: ${config.parent}`);
      console.log(`Active context: ${config.activeContext ?? '(none)'}`);
      for (const [name, repository] of Object.entries(config.repositories)) {
        try {
          const status = await inspectContextRepository(config.parent, repository);
          const { freshness } = status;
          const indexDrift = status.commitsBehind === undefined ? '' : ` (${status.commitsBehind} commits behind indexed checkout)`;
          const liveDrift = freshness.commitsBehind === undefined ? '' : ` (by ${freshness.commitsBehind})`;
          console.log(
            `${name}: ${status.state}${indexDrift} | freshness ${freshness.status}${liveDrift} | ` +
              `indexed=${status.indexedRevision ?? 'unknown'} live=${freshness.liveHead ?? 'unknown'}`,
          );
        } catch (error) {
          console.log(`${name}: unavailable (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    });
}
