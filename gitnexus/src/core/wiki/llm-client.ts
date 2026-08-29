/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 *
 * Config priority: CLI flags > env vars > defaults
 */

export type LLMProvider =
  | 'openai'
  | 'openrouter'
  | 'azure'
  | 'custom'
  | 'cursor'
  | 'claude'
  | 'codex';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Provider type — controls auth header behaviour */
  provider?: LLMProvider;
  /** Azure api-version query param (e.g. '2024-10-21'). Appended to URL when set. */
  apiVersion?: string;
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
  /** Per-attempt fetch timeout in ms. Omit to disable request timeouts. */
  requestTimeoutMs?: number;
  /** Max fetch attempts before giving up (default: 3). */
  maxAttempts?: number;
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Resolve LLM configuration from env vars, saved config, and optional overrides.
 * Priority: overrides (CLI flags) > env vars > ~/.gitnexus/config.json > error
 *
 * If no API key is found, returns config with empty apiKey (caller should handle).
 */
export async function resolveLLMConfig(overrides?: Partial<LLMConfig>): Promise<LLMConfig> {
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const savedConfig = await loadCLIConfig();
  const savedProvider = overrides?.provider ?? savedConfig.provider;
  const savedLocalModel =
    savedProvider === 'cursor'
      ? savedConfig.cursorModel
      : savedProvider === 'claude'
        ? savedConfig.claudeModel
        : savedProvider === 'codex'
          ? savedConfig.codexModel
          : undefined;
  const localProvider =
    savedProvider === 'cursor' || savedProvider === 'claude' || savedProvider === 'codex';

  const apiKey = overrides?.apiKey || savedConfig.apiKey || '';

  return {
    apiKey,
    baseUrl:
      overrides?.baseUrl ||
      savedConfig.baseUrl ||
      '',
    model:
      overrides?.model ||
      (localProvider ? undefined : process.env.GITNEXUS_MODEL) ||
      savedLocalModel ||
      (localProvider ? '' : savedConfig.model || 'minimax/minimax-m2.5'),
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    provider: savedProvider ?? 'openai',
    apiVersion:
      overrides?.apiVersion || process.env.GITNEXUS_AZURE_API_VERSION || savedConfig.apiVersion,
    isReasoningModel: overrides?.isReasoningModel ?? savedConfig.isReasoningModel,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Validate that a base URL supplied for LLM API calls is a safe HTTP/HTTPS
 * endpoint (CWE-918 / CodeQL js/http-to-file-access).
 *
 * Allowed:
 *  - https:// with any hostname (public LLM APIs, Azure, OpenRouter, …)
 *  - http:// restricted to localhost / 127.0.0.1 (local servers: Ollama, LiteLLM, …)
 *
 * Rejected:
 *  - file://, data:, javascript:, and any other non-HTTP scheme
 *  - http:// aimed at non-loopback hosts (avoids SSRF against internal networks)
 *
 * Throws with a descriptive message on validation failure so callers surface a
 * clear error rather than an opaque network error.
 */
export function validateLLMBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Do not include the raw input in the message — it may contain credentials.
    throw new Error('Invalid LLM base URL: must be a well-formed http:// or https:// URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    // Use parsed.protocol only (scheme), not the full URL, to avoid leaking credentials.
    throw new Error(`LLM base URL must use http:// or https:// (got ${parsed.protocol})`);
  }

  if (parsed.protocol === 'http:') {
    // Node's URL parser preserves IPv6 brackets in hostname (e.g. "[::1]"),
    // so strip them before comparing to bare address literals.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      // Use parsed.origin (scheme+host+port, no credentials) instead of the full URL.
      throw new Error(
        `Insecure http:// LLM base URLs are only allowed for localhost/127.0.0.1. ` +
          `Use https:// for remote endpoints (got ${parsed.origin})`,
      );
    }
  }
}

/**
 * Returns true if the given base URL is an Azure OpenAI endpoint.
 * Uses proper hostname matching to avoid spoofed URLs like
 * "https://myresource.openai.azure.com.evil.com/v1".
 */
export function isAzureProvider(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
  } catch {
    // Malformed URL — refuse to call this Azure rather than fall back to a
    // substring check, which is bypassable by `https://evil.com/?u=.openai.azure.com`
    // (CodeQL js/incomplete-url-substring-sanitization).
    return false;
  }
}

/**
 * Returns true if the model name matches a known reasoning model pattern,
 * or if the explicit override is true.
 * Pass override=false to force non-reasoning even for o-series names.
 */
export function isReasoningModel(model: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  // Match known bare reasoning models (o1, o3) and any o-series with -mini/-preview suffix
  return /^o[1-9]\d*(-mini|-preview)$|^o1$|^o3$/i.test(model);
}

/**
 * Build the full chat completions URL, appending ?api-version when provided.
 */
export function buildRequestUrl(baseUrl: string, apiVersion: string | undefined): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return apiVersion ? `${base}?api-version=${encodeURIComponent(apiVersion)}` : base;
}

export interface CallLLMOptions {
  onChunk?: (charsReceived: number) => void;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  _prompt: string,
  _config: LLMConfig,
  _systemPrompt?: string,
  _options?: CallLLMOptions,
): Promise<LLMResponse> {
  throw new Error('[local-safe] Wiki LLM calls are disabled to prevent outbound network calls.');
}
