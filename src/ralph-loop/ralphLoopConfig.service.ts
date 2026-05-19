import type { RalphLoopParams } from './ralphLoop.service.ts';

export const isPullRequestCompletion = (
  completion: RalphLoopParams['completion'],
): completion is 'pr' | 'draft-pr' => completion === 'pr' || completion === 'draft-pr';

export const requiresGitHubCli = (params: RalphLoopParams): boolean =>
  isPullRequestCompletion(params.completion) ||
  params.mergeCondition === 'ci-passed' ||
  params.mergeCondition === 'comment-fixed';

export const validateRalphLoopParams = (
  params: RalphLoopParams,
):
  | {
      readonly kind: 'valid';
    }
  | {
      readonly kind: 'invalid';
      readonly message: string;
    } => {
  if (!isPullRequestCompletion(params.completion)) {
    if (params.mergeCondition === 'ci-passed') {
      return {
        kind: 'invalid',
        message: 'mergeCondition=ci-passed requires completion=pr or completion=draft-pr.',
      };
    }

    if (params.mergeCondition === 'comment-fixed') {
      return {
        kind: 'invalid',
        message: 'mergeCondition=comment-fixed requires completion=pr or completion=draft-pr.',
      };
    }
  }

  return {
    kind: 'valid',
  };
};

export const buildConfigurationGuidance = (params: RalphLoopParams): readonly string[] => {
  const guidance: string[] = [];

  if (params.completion === 'pr') {
    guidance.push(
      'completion: pr is set, so set-ralph-loop will create the PR automatically upon completion. You do not need to create the PR manually, but you must commit your changes yourself and create the working branch yourself.',
    );
  }

  if (params.completion === 'draft-pr') {
    guidance.push(
      'completion: draft-pr is set, so set-ralph-loop will create the Draft PR automatically upon completion. You do not need to create the Draft PR manually, but you must commit your changes yourself and create the working branch yourself.',
    );
  }

  if (params.mergeCondition === 'ci-passed') {
    guidance.push(
      'mergeCondition: ci-passed is set, so set-ralph-loop will wait for CI to complete using gh after PR creation and merge automatically if no checks fail. If CI fails, the task stays open and the work loop resumes automatically.',
    );
  }

  if (params.mergeCondition === 'comment-fixed') {
    guidance.push(
      'mergeCondition: comment-fixed is set, so set-ralph-loop will first wait for CI to complete (same as ci-passed), then block merge if any PR comments remain unanswered, providing reply guidance. Once all comments are resolved, it merges automatically.',
    );
  }

  return guidance;
};
