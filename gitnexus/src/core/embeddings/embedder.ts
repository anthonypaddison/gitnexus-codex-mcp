/**
 * Local-safe embedder.
 *
 * Embeddings are disabled in this copy to prevent outbound model downloads and
 * HTTP embedding API calls.
 */

import type { ModelProgress } from './types.js';

type FeatureExtractionPipeline = never;

export type ModelProgressCallback = (progress: ModelProgress) => void;

export const getCurrentDevice = (): 'dml' | 'cuda' | 'cpu' | 'wasm' | null => null;

export const initEmbedder = async (
  _onProgress?: ModelProgressCallback,
  _config?: unknown,
): Promise<FeatureExtractionPipeline> => {
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const isEmbedderReady = (): boolean => false;

export const getEmbeddingDimensions = (): number => 384;

export const getEmbedder = (): FeatureExtractionPipeline => {
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const embedText = async (_text: string): Promise<Float32Array> => {
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];
  throw new Error('[local-safe] Embeddings are disabled to prevent outbound network calls.');
};

export const embeddingToArray = (embedding: Float32Array): number[] => Array.from(embedding);

export const disposeEmbedder = async (): Promise<void> => {};
