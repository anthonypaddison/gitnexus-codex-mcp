/**
 * Local-safe embedding client.
 *
 * HTTP embedding backends are disabled in this copy to prevent outbound
 * network calls, even when GITNEXUS_EMBEDDING_* env vars are present.
 */

export const isHttpMode = (): boolean => false;

export const getHttpDimensions = (): number | undefined => undefined;

export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];
  throw new Error('[local-safe] HTTP embeddings are disabled to prevent outbound network calls.');
};

export const httpEmbedQuery = async (_text: string): Promise<number[]> => {
  throw new Error('[local-safe] HTTP embeddings are disabled to prevent outbound network calls.');
};
