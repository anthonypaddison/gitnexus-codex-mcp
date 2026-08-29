import { cliInfo } from './cli-message.js';

export interface PublishOptions {
  /** Override the auto-derived `owner/repo` id. */
  id?: string;
  /** Treat the cwd as the repo root (skip git-root walk). */
  skipGit?: boolean;
}

export const publishCommand = async (
  _inputPath?: string,
  _options: PublishOptions = {},
): Promise<void> => {
  cliInfo('[local-safe] gitnexus publish is disabled to prevent outbound network calls.', {
    skipped: 'local-safe-network-disabled',
  });
};
