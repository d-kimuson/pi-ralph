import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RalphLoopPullRequestTemplate } from './ralphLoop.service.ts';

const GIT_TOP_LEVEL_TIMEOUT_MS = 30_000;

export type PullRequestTemplateExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PullRequestTemplateExec = (
  command: string,
  args: string[],
  options: {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly timeout: number;
  },
) => Promise<PullRequestTemplateExecResult>;

export const loadPullRequestTemplate = async (
  execCommand: PullRequestTemplateExec,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RalphLoopPullRequestTemplate | undefined> => {
  const gitTopLevel = await execCommand('bash', ['-lc', 'git rev-parse --show-toplevel'], {
    cwd,
    signal,
    timeout: GIT_TOP_LEVEL_TIMEOUT_MS,
  });

  if (gitTopLevel.code !== 0) {
    throw new Error(`Failed to resolve git top level: ${gitTopLevel.stderr || gitTopLevel.stdout}`);
  }

  const root = gitTopLevel.stdout.trim();

  if (root === '') {
    return undefined;
  }

  const templatePath = path.join(root, '.github', 'pull_request_template.md');

  try {
    const content = await readFile(templatePath, 'utf8');

    return {
      path: templatePath,
      content,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
};
