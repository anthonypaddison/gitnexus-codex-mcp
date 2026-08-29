import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRequestUrl,
  isAzureProvider,
  isReasoningModel,
  validateLLMBaseUrl,
} from '../../src/core/wiki/llm-client.js';

describe('local wiki LLM helpers', () => {
  it('retains hostname-aware Azure detection', () => {
    expect(isAzureProvider('https://myresource.openai.azure.com/openai/v1')).toBe(true);
    expect(isAzureProvider('https://myresource.openai.azure.com.evil.com/openai/v1')).toBe(false);
  });

  it('retains reasoning model identification without invoking an LLM', () => {
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('o1', false)).toBe(false);
  });

  it('builds API-compatible request URLs as a pure helper', () => {
    expect(buildRequestUrl('https://api.openai.com/v1/', undefined)).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('continues to reject unsafe LLM base URL schemes without exposing credentials', () => {
    expect(() => validateLLMBaseUrl('file:///etc/passwd')).toThrow(/must use http/);
    expect(() => validateLLMBaseUrl('http://192.168.1.1/v1?apikey=not-a-secret')).toThrow(
      /Insecure http/,
    );
  });
});

describe('local-safe wiki LLM boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects remote LLM configuration before any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { callLLM } = await import('../../src/core/wiki/llm-client.js');

    await expect(
      callLLM('write a wiki page', {
        apiKey: 'not-a-secret',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow(/Wiki LLM calls are disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
