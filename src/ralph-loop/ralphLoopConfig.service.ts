import type { RalphLoopParams } from './ralphLoop.service.ts';

export const isPullRequestCompletion = (
  completion: RalphLoopParams['completion'],
): completion is 'pr' | 'draft-pr' => completion === 'pr' || completion === 'draft-pr';

export const requiresGitHubCli = (params: RalphLoopParams): boolean =>
  isPullRequestCompletion(params.completion) ||
  params.autofix !== 'none' ||
  params.mergeCondition !== 'none';

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
    if (params.autofix !== 'none') {
      return {
        kind: 'invalid',
        message: 'autofix requires completion=pr or completion=draft-pr.',
      };
    }

    if (params.mergeCondition !== 'none') {
      return {
        kind: 'invalid',
        message: 'mergeCondition requires completion=pr or completion=draft-pr.',
      };
    }
  }

  if (params.mergeCondition !== 'none' && params.autofix === 'none') {
    return {
      kind: 'invalid',
      message: 'mergeCondition requires autofix=ci or autofix=comment.',
    };
  }

  return {
    kind: 'valid',
  };
};

export const buildConfigurationGuidance = (params: RalphLoopParams): readonly string[] => {
  const guidance: string[] = [];

  if (params.completion === 'edit-only') {
    guidance.push(
      'completion: edit-only is set, so set-ralph-loop is only a lightweight verification gate. Do not commit, create a PR, or merge unless the user separately asks for it.',
    );
  }

  if (params.completion === 'pr') {
    guidance.push(
      'completion: pr is set, so set-ralph-loop will create or update a ready PR after commit cleanliness checks pass. You must create and switch to a non-default working branch yourself before starting; ralph-package does not create branches for you.',
    );
  }

  if (params.completion === 'draft-pr') {
    guidance.push(
      'completion: draft-pr is set, so set-ralph-loop will create or update a draft PR after commit cleanliness checks pass. You must create and switch to a non-default working branch yourself before starting; ralph-package does not create branches for you.',
    );
  }

  if (params.autofix === 'ci') {
    guidance.push(
      'autofix: ci is set, so set-ralph-loop will wait for PR CI and keep the task open for the agent to fix failed or pending checks. It will not merge by itself unless mergeCondition requests it.',
    );
  }

  if (params.autofix === 'comment') {
    guidance.push(
      'autofix: comment is set, so set-ralph-loop will wait for PR CI, then check unresolved PR comments and keep the task open for the agent to address them. It will not merge by itself unless mergeCondition requests it.',
    );
  }

  if (params.mergeCondition === 'fix-completed') {
    guidance.push(
      'mergeCondition: fix-completed is set, so set-ralph-loop will merge after the configured autofix checks pass.',
    );
  }

  if (params.mergeCondition === 'approved') {
    guidance.push(
      'mergeCondition: approved is set, so set-ralph-loop will wait until GitHub reports the PR review decision as APPROVED after the configured autofix checks pass, then merge.',
    );
  }

  return guidance;
};
