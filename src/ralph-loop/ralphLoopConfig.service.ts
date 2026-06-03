import { type RalphLoopMergeCondition, type RalphLoopParams } from './ralphLoop.service.ts';

export const isPullRequestCompletion = (
  completion: RalphLoopParams['completion'],
): completion is 'pr' | 'draft-pr' => completion === 'pr' || completion === 'draft-pr';

const isMergeAutomationEnabled = (
  mergeCondition: RalphLoopMergeCondition,
): mergeCondition is Extract<RalphLoopMergeCondition, { readonly enabled: true }> =>
  mergeCondition.enabled;

export const requiresGitHubCli = (params: RalphLoopParams): boolean =>
  isPullRequestCompletion(params.completion) ||
  params.autofix !== 'none' ||
  isMergeAutomationEnabled(params.mergeCondition);

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

    if (isMergeAutomationEnabled(params.mergeCondition)) {
      return {
        kind: 'invalid',
        message: 'mergeCondition.enabled=true requires completion=pr or completion=draft-pr.',
      };
    }
  }

  if (
    params.completion === 'draft-pr' &&
    isMergeAutomationEnabled(params.mergeCondition) &&
    params.autofix === 'none'
  ) {
    return {
      kind: 'invalid',
      message:
        'completion=draft-pr with mergeCondition.enabled=true requires autofix=ci or autofix=comment.',
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
      'autofix: ci is set, so set-ralph-loop will keep the task open for the agent to fix unresolved PR CI when needed. If no CI checks exist, this mode becomes a no-op.',
    );
  }

  if (params.autofix === 'comment') {
    guidance.push(
      'autofix: comment is set, so set-ralph-loop will handle PR CI first when present, then keep the task open for the agent to address unresolved PR comments before merge can continue.',
    );
  }

  if (isMergeAutomationEnabled(params.mergeCondition) && !params.mergeCondition.approved) {
    guidance.push(
      'mergeCondition: enabled=true, approved=false is set, so set-ralph-loop will merge automatically after the configured autofix flow completes.',
    );
  }

  if (isMergeAutomationEnabled(params.mergeCondition) && params.mergeCondition.approved) {
    guidance.push(
      'mergeCondition: enabled=true, approved=true is set, so set-ralph-loop will wait until GitHub reports the PR review decision as APPROVED after the configured autofix flow completes, then merge.',
    );
  }

  if (params.completion === 'draft-pr' && isMergeAutomationEnabled(params.mergeCondition)) {
    guidance.push(
      'completion: draft-pr is combined with merge automation, so set-ralph-loop will automatically mark the draft PR as ready for review before waiting for approval or merging.',
    );
  }

  return guidance;
};
