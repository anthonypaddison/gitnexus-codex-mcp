import fs from 'node:fs/promises';
import path from 'node:path';

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/**
 * Resolve a repository-relative path to a regular file without allowing a
 * traversal or symlink to escape the repository root.
 *
 * This is intentionally an asynchronous, filesystem-aware boundary rather
 * than a string-prefix check: symbolic links and platform-specific path
 * aliases can make a lexically-in-root path resolve outside its repository.
 */
export const resolveRegularFileWithinRoot = async (
  repositoryRoot: string,
  relativePath: string,
): Promise<string> => {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Repository file path must be a non-empty relative path.');
  }

  const root = await fs.realpath(repositoryRoot);
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw new Error(`Repository path escapes configured root: ${relativePath}`);
  }

  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not permitted in repository file access: ${relativePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Repository path is not a regular file: ${relativePath}`);
  }

  const resolved = await fs.realpath(candidate);
  if (!isWithin(root, resolved)) {
    throw new Error(`Repository path resolves outside configured root: ${relativePath}`);
  }
  return resolved;
};
