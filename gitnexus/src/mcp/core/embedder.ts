/**
 * Local-safe MCP embedder.
 *
 * Embeddings are disabled in this copy to prevent outbound model downloads and
 * HTTP embedding API calls.
 */

type FeatureExtractionPipeline = never;

export const initEmbedder = async (): Promise<FeatureExtractionPipeline> => {
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const isEmbedderReady = (): boolean => false;

export const embedQuery = async (_query: string): Promise<number[]> => {
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const getEmbeddingDims = (): number => 384;

export const disposeEmbedder = async (): Promise<void> => {};
