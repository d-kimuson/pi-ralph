import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RalphLoopPullRequestTemplate } from './ralphLoop.service.ts';

export type PullRequestTemplateExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PullRequestTemplateExec = () => Promise<PullRequestTemplateExecResult>;

export const loadPullRequestTemplate = async (
  execCommand: PullRequestTemplateExec,
): Promise<RalphLoopPullRequestTemplate | undefined> => {
  const gitTopLevel = await execCommand();

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
