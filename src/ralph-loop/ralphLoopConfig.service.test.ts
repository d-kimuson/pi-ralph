import { describe, expect, test } from 'vitest';

import {
  buildConfigurationGuidance,
  requiresGitHubCli,
  validateRalphLoopParams,
} from './ralphLoopConfig.service.ts';

describe('ralphLoopConfig.service', () => {
  test('requires gh when PR completion, autofix, or merge automation is configured', () => {
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'pr',
        autofix: 'none',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(true);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'none',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(false);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'draft-pr',
        autofix: 'comment',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(true);
  });

  test('rejects autofix and merge automation without PR completion', () => {
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'ci',
        mergeCondition: 'none',
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'autofix requires completion=pr or completion=draft-pr.',
    });
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'none',
        mergeCondition: 'fix-completed',
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'mergeCondition requires completion=pr or completion=draft-pr.',
    });
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'pr',
        autofix: 'none',
        mergeCondition: 'approved',
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'mergeCondition requires autofix=ci or autofix=comment.',
    });
  });

  test('returns configuration guidance for PR automation, autofix, and merge automation', () => {
    expect(
      buildConfigurationGuidance({
        staticChecks: [],
        completion: 'pr',
        autofix: 'comment',
        mergeCondition: 'fix-completed',
        review: false,
      }),
    ).toEqual([
      'completion: pr is set, so set-ralph-loop will create or update a ready PR after commit cleanliness checks pass. You must create and switch to a non-default working branch yourself before starting; ralph-package does not create branches for you.',
      'autofix: comment is set, so set-ralph-loop will wait for PR CI, then check unresolved PR comments and keep the task open for the agent to address them. It will not merge by itself unless mergeCondition requests it.',
      'mergeCondition: fix-completed is set, so set-ralph-loop will merge after the configured autofix checks pass.',
    ]);
  });
});
