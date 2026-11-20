import { LocalBackend } from './local/local-backend.js';
import { HARDENED_MCP_TOOLS } from './tools.js';
import type { ContextConfig } from '../core/contexts/config.js';
import { ContextDatabaseOpenError } from '../core/lbug/pool-adapter.js';
import { inspectContextIndex } from '../core/contexts/index-safety.js';

const MAX_RESPONSE_BYTES = 28 * 1024;
const MAX_PENDING = 4;
export const CONTEXT_MCP_TOOLS = HARDENED_MCP_TOOLS.map((tool) => {
  const { include_content: _includeContent, ...properties } = tool.inputSchema.properties;
  if (tool.name === 'detect_changes') {
    properties.scope = { type: 'string', enum: ['staged', 'compare'], default: 'staged' };
  }
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      additionalProperties: false,
      properties: {
        ...properties,
        context: { type: 'string', description: 'Exact alias of the context authorized for this connection.' },
        repository: { type: 'string', description: 'Exact approved repository alias in this context.' },
      },
    },
  };
});

function validateArguments(name: string, input: unknown): Record<string, unknown> {
  const tool = CONTEXT_MCP_TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error('Tool is not available in context mode.');
  const args = input ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected tool arguments.');
  const { properties, required } = tool.inputSchema;
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error('Required tool argument missing.');
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) throw new Error('Unsupported tool argument.');
    const rule = properties[key] as (typeof HARDENED_MCP_TOOLS)[number]['inputSchema']['properties'][string];
    const valid = rule.type === 'array'
      ? Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === 'string' && item.length <= 256)
      : typeof value === rule.type;
    if (!valid ||
      (typeof value === 'string' &&
        (value.length > 1024 || value.length < (rule.minLength ?? 1) ||
          (rule.enum && !rule.enum.includes(value)))) ||
      (typeof value === 'number' &&
        (!Number.isFinite(value) || value < (rule.minimum ?? 0) || value > (rule.maximum ?? 100)))) {
      throw new Error('Invalid tool argument.');
    }
    if (['file', 'file_path', 'target_uid', 'uid'].includes(key) && typeof value === 'string' && value.includes('\0')) {
      throw new Error('Invalid tool argument.');
    }
    if (['file', 'file_path'].includes(key) && typeof value === 'string' &&
        (/^[~/\\]|^[a-z]:/i.test(value) || value.split(/[/\\]/).includes('..') || value.includes('\0'))) {
      throw new Error('File selectors must be repository-relative.');
    }
  }
  if (Object.hasOwn(args, 'base_ref') && !/^[a-zA-Z0-9][a-zA-Z0-9._/~^@{}-]{0,127}$/.test(String(args['base_ref']))) {
    throw new Error('Invalid Git revision.');
  }
  return { ...args };
}

export class ContextRouter {
  private readonly context: string;
  private readonly members: string[];
  private tail = Promise.resolve();
  private pending = 0;
  private stopping = false;

  constructor(private readonly config: ContextConfig) {
    this.context = config.activeContext ?? '';
    const scoped = Object.hasOwn(config.contexts, this.context) ? config.contexts[this.context] : [];
    this.members = [...scoped];
    if (!this.members.length) throw new Error('Select a context with approved repositories before starting MCP.');
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    const { context, repository, ...args } = validateArguments(name, input);
    if (context !== undefined && context !== this.context) throw new Error('Context is not authorized for this connection.');
    if (repository !== undefined && !this.members.includes(String(repository))) {
      throw new Error('Repository is not authorized for this connection.');
    }
    if (repository === undefined && name !== 'query' && this.members.length !== 1) {
      throw new Error('An approved repository alias is required for this tool.');
    }
    if (this.stopping || this.pending >= MAX_PENDING) throw new Error('Context server busy.');
    this.pending++;
    const selected = repository === undefined ? this.members : [String(repository)];
    const work = this.tail.then(() => this.run(name, args, selected));
    this.tail = work.then(() => {}, () => {});
    try {
      return await work;
    } finally {
      this.pending--;
    }
  }

  private async run(name: string, args: Record<string, unknown>, selected: string[]) {
    const result = { context: this.context, repositories: [] as unknown[] };
    for (const alias of selected) {
      if (this.stopping) throw new Error('Context server is shutting down.');
      const entry = this.config.repositories[alias];
      const status = await inspectContextIndex(this.config.parent, entry.root, entry.identity);
      const item = { repository: alias, ...status };
      result.repositories.push(item);
      if (status.state !== 'ready') continue;

      const backend = new LocalBackend({ repositoryRoot: entry.root, strictReadOnly: true });
      try {
        await backend.init();
        const data = await backend.callTool(name, name === 'query'
          ? { ...args, limit: Math.min(Number(args.limit ?? 3), 5), max_symbols: Math.min(Number(args.max_symbols ?? 5), 10) }
          : name === 'detect_changes' ? { scope: 'staged', ...args } : args);
        if (data?.error) {
          Object.assign(item, { state: 'unavailable' });
        } else {
          Object.assign(item, { result: data });
          if (Buffer.byteLength(JSON.stringify(result, null, 2)) > MAX_RESPONSE_BYTES) {
            Reflect.deleteProperty(item, 'result');
            Object.assign(item, { truncated: true });
          }
        }
      } catch (error) {
        Object.assign(item, { state: error instanceof ContextDatabaseOpenError ? error.state : 'unavailable' });
      } finally {
        await backend.disconnect();
      }
    }
    return result;
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    await this.tail;
  }
}
