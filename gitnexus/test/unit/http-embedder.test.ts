import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('local-safe embedding boundary', () => {
  it('keeps the local vector dimensions while reporting no ready embedder', () => {
    expect(getEmbeddingDims()).toBe(384);
    expect(isEmbedderReady()).toBe(false);
  });

  it('ignores HTTP embedding configuration and never invokes fetch', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'https://example.invalid/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'remote-model';
    process.env.GITNEXUS_EMBEDDING_API_KEY = 'not-a-secret';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const mcp = await import('../../src/mcp/core/embedder.js');
    const core = await import('../../src/core/embeddings/embedder.js');
    const http = await import('../../src/core/embeddings/http-client.js');

    expect(mcp.isEmbedderReady()).toBe(false);
    expect(http.isHttpMode()).toBe(false);
    await expect(mcp.embedQuery('query')).rejects.toThrow(/Embeddings are disabled/);
    await expect(core.embedText('text')).rejects.toThrow(/Embeddings are disabled/);
    await expect(http.httpEmbedQuery('query')).rejects.toThrow(/HTTP embeddings are disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows empty local batches without initialising a model or HTTP client', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const core = await import('../../src/core/embeddings/embedder.js');
    const http = await import('../../src/core/embeddings/http-client.js');

    await expect(core.embedBatch([])).resolves.toEqual([]);
    await expect(http.httpEmbed([])).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
