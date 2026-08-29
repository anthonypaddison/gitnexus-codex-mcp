import { createFTSIndex } from '../lbug/lbug-adapter.js';
import { FTS_INDEXES } from './fts-schema.js';

let ftsUnavailable = false;

export interface CreateSearchFTSIndexesOptions {
  onIndexStart?: (table: string, indexName: string) => void;
  onIndexReady?: (table: string, indexName: string) => void;
}

export async function createSearchFTSIndexes(
  options?: CreateSearchFTSIndexesOptions,
): Promise<void> {
  for (const { table, indexName, properties } of FTS_INDEXES) {
    options?.onIndexStart?.(table, indexName);
    try {
      await createFTSIndex(table, indexName, [...properties]);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('FTS extension unavailable')) {
        ftsUnavailable = true;
        console.warn('[local-safe] FTS search indexes skipped because the FTS extension is unavailable.');
        return;
      }
      throw error;
    }
    options?.onIndexReady?.(table, indexName);
  }
}

export async function verifySearchFTSIndexes(
  executeQuery: (cypher: string) => Promise<unknown[]>,
): Promise<string[]> {
  if (ftsUnavailable) return [];

  const safeIdentifier = (value: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`Invalid FTS identifier: ${value}`);
    }
    return value;
  };

  const missing: string[] = [];
  for (const { table, indexName } of FTS_INDEXES) {
    const safeTable = safeIdentifier(table);
    const safeIndex = safeIdentifier(indexName);
    const probe = `
      CALL QUERY_FTS_INDEX('${safeTable}', '${safeIndex}', '__gitnexus_fts_probe__', conjunctive := false)
      RETURN score
      LIMIT 1
    `;
    try {
      await executeQuery(probe);
    } catch {
      missing.push(`${table}.${indexName}`);
    }
  }
  return missing;
}
