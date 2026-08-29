import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { performance } from 'node:perf_hooks';
import {
  buildUqDispatchPayload,
  isValidOwnerRepo,
  parseOwnerRepoFromRemote,
  stripGitSuffix,
  UNDERSTAND_QUICKLY_TOKEN_ENV,
} from 'gitnexus-shared';

describe('understand-quickly helpers (gitnexus-shared)', () => {
  describe('isValidOwnerRepo', () => {
    it.each([
      ['looptech-ai/understand-quickly', true],
      ['abhigyanpatwari/GitNexus', true],
      // LOW 8: GitHub user/org slugs are alnum/hyphen only — no underscore.
      ['Some_Org/Some.Repo-2', false],
      ['', false],
      ['just-a-name', false],
      ['/Users/me/code/repo', false],
      ['org/with spaces', false],
      ['org//double', false],
      // LOW 8 additions:
      ['some_org/repo', false], // underscore in owner — invalid
      ['-org/repo', false], // leading hyphen — invalid
      ['org-/repo', false], // trailing hyphen — GitHub rejects at account creation; we mirror that here
      ['org/repo_with_underscore', true],
      ['org/.dotfile', true], // repos may start with dot
    ])('returns %s for %j', (id, expected) => {
      expect(isValidOwnerRepo(id as string)).toBe(expected);
    });
  });

  describe('stripGitSuffix (BLOCKER 1 — ReDoS-safe)', () => {
    it.each([
      ['https://github.com/o/r.git', 'https://github.com/o/r'],
      ['https://github.com/o/r.git/', 'https://github.com/o/r'],
      ['https://github.com/o/r/', 'https://github.com/o/r'],
      ['https://github.com/o/r', 'https://github.com/o/r'],
      ['https://github.com/o/r.GIT', 'https://github.com/o/r'],
      ['https://github.com/o/r//', 'https://github.com/o/r'],
      ['', ''],
      ['/', ''],
    ])('strips %j -> %j', (input, expected) => {
      expect(stripGitSuffix(input)).toBe(expected);
    });

    test('linear time on adversarial trailing slashes (regression for ReDoS)', () => {
      const adversarial = 'https://github.com/o/r' + '/'.repeat(10_000);
      const start = performance.now();
      const result = stripGitSuffix(adversarial);
      const elapsed = performance.now() - start;
      expect(result).toBe('https://github.com/o/r');
      expect(elapsed).toBeLessThan(50); // generous; should be sub-millisecond
    });

    test('parseOwnerRepoFromRemote terminates quickly on adversarial input', () => {
      const adversarial = 'https://github.com/o/r.git' + '/'.repeat(10_000);
      const start = performance.now();
      const result = parseOwnerRepoFromRemote(adversarial);
      const elapsed = performance.now() - start;
      expect(result).toBe('o/r');
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('parseOwnerRepoFromRemote', () => {
    it.each([
      ['git@github.com:looptech-ai/understand-quickly.git', 'looptech-ai/understand-quickly'],
      ['https://github.com/looptech-ai/understand-quickly', 'looptech-ai/understand-quickly'],
      ['https://github.com/looptech-ai/understand-quickly.git', 'looptech-ai/understand-quickly'],
      ['ssh://git@github.com/abhigyanpatwari/GitNexus.git', 'abhigyanpatwari/GitNexus'],
    ])('parses %s -> %s', (url, expected) => {
      expect(parseOwnerRepoFromRemote(url)).toBe(expected);
    });

    // LOW 9: non-GitHub remotes must be rejected — a wrong id is worse
    // than no id, since the user can always pass --id explicitly.
    it.each([
      ['https://gitlab.example.com/group/sub/project.git'],
      ['git@gitlab.example.com:group/sub/project.git'],
      ['https://bitbucket.org/team/repo.git'],
    ])('returns null for non-GitHub host %j', (input) => {
      expect(parseOwnerRepoFromRemote(input)).toBeNull();
    });

    it.each([null, undefined, '', '   ', 'not-a-url', 'https://github.com/'])(
      'returns null for %j',
      (input) => {
        expect(parseOwnerRepoFromRemote(input as string | null | undefined)).toBeNull();
      },
    );
  });

  describe('buildUqDispatchPayload', () => {
    it('wraps the id in the registry-expected event shape', () => {
      expect(buildUqDispatchPayload('looptech-ai/understand-quickly')).toEqual({
        event_type: 'sync-entry',
        client_payload: { id: 'looptech-ai/understand-quickly' },
      });
    });

    it('throws on a malformed id rather than building an invalid payload', () => {
      expect(() => buildUqDispatchPayload('just-a-name')).toThrow(/owner\/repo/);
      expect(() => buildUqDispatchPayload('/Users/me/repo')).toThrow(/owner\/repo/);
    });
  });
});

describe('publishCommand (no-token no-op)', () => {
  let tempDir: string;
  let originalToken: string | undefined;
  let exitCodeBefore: number | undefined;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publish-test-'));
    // Simulate an existing index so hasIndex() returns true.
    await fs.mkdir(path.join(tempDir, '.gitnexus'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.gitnexus', 'meta.json'),
      JSON.stringify({ repoPath: tempDir, lastCommit: '', indexedAt: '' }),
      'utf-8',
    );
    originalToken = process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    delete process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    exitCodeBefore = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(async () => {
    if (originalToken !== undefined) {
      process.env[UNDERSTAND_QUICKLY_TOKEN_ENV] = originalToken;
    } else {
      delete process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    }
    process.exitCode = exitCodeBefore;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exits 0 without firing a network call when the token is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('publishCommand should NOT call fetch when the token is missing');
    });

    const { publishCommand } = await import('../../src/cli/publish.js');
    await publishCommand(tempDir, { id: 'looptech-ai/understand-quickly', skipGit: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    fetchSpy.mockRestore();
  });

  it('exits 0 with no token even when no index/repo exists (BLOCKER 2)', async () => {
    // Per the README, CLI --help, and PR body: without a token, the
    // command must be a no-op even if the repo lacks `.gitnexus/`.
    const noIndexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publish-noidx-'));
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('publishCommand should NOT call fetch when the token is missing');
      });
      const { publishCommand } = await import('../../src/cli/publish.js');
      await publishCommand(noIndexDir, {
        id: 'looptech-ai/understand-quickly',
        skipGit: true,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
      fetchSpy.mockRestore();
    } finally {
      await fs.rm(noIndexDir, { recursive: true, force: true });
    }
  });
});

describe('publishCommand local-safe boundary', () => {
  let tempDir: string;
  let originalToken: string | undefined;
  let exitCodeBefore: number | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publish-resp-'));
    await fs.mkdir(path.join(tempDir, '.gitnexus'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.gitnexus', 'meta.json'),
      JSON.stringify({ repoPath: tempDir, lastCommit: '', indexedAt: '' }),
      'utf-8',
    );
    originalToken = process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    process.env[UNDERSTAND_QUICKLY_TOKEN_ENV] = 'pat_test';
    exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    if (originalToken !== undefined) {
      process.env[UNDERSTAND_QUICKLY_TOKEN_ENV] = originalToken;
    } else {
      delete process.env[UNDERSTAND_QUICKLY_TOKEN_ENV];
    }
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not publish or expose a configured token', async () => {
    process.env[UNDERSTAND_QUICKLY_TOKEN_ENV] = 'not-a-secret';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { publishCommand } = await import('../../src/cli/publish.js');
    await publishCommand(tempDir, {
      id: 'looptech-ai/understand-quickly',
      skipGit: true,
    });
    const written = errSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(written).not.toContain('not-a-secret');
    expect(process.exitCode ?? 0).toBe(0);
    errSpy.mockRestore();
  });
});
