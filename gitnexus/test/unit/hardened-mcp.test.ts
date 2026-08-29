import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHardenedMCPServer } from '../../src/mcp/server.js';
import { HARDENED_MCP_TOOLS } from '../../src/mcp/tools.js';

const EXPECTED_TOOLS = [
  'query',
  'context',
  'detect_changes',
  'impact',
  'route_map',
  'tool_map',
  'shape_check',
  'api_impact',
];

function backend(): any {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('hardened MCP surface', () => {
  it('exposes only fixed-repository, read-only tools without repo selectors', async () => {
    const localBackend = backend();
    const server = createHardenedMCPServer(localBackend);
    const client = new Client({ name: 'hardened-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
      expect(HARDENED_MCP_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
      for (const tool of response.tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(tool.inputSchema.properties.repo).toBeUndefined();
      }

      await expect(client.listResources()).resolves.toEqual({ resources: [] });
      await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
      await expect(client.listPrompts()).resolves.toEqual({ prompts: [] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects an explicitly requested removed tool before it reaches the backend', async () => {
    const localBackend = backend();
    const server = createHardenedMCPServer(localBackend);
    const client = new Client({ name: 'hardened-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await expect(client.callTool({ name: 'cypher', arguments: { query: 'CREATE ()' } })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/not available/i) }],
      });
      expect(localBackend.callTool).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
