import { describe, expect, it } from 'vitest';
import { logQueryTiming, queryTimingFields } from '../../src/mcp/local/local-backend.js';

describe('query timing logging', () => {
  it('builds timing fields without accepting the MCP query content', () => {
    const phases = { bm25: 2, vector: 3, wall: 7 };

    expect(queryTimingFields(phases)).toEqual({ totalMs: 7, phases });
    expect(() => logQueryTiming(phases)).not.toThrow();
  });
});
