import { describe, expect, test } from 'vitest';

import {
  buildConfigurationGuidance,
  requiresGitHubCli,
  validateRalphLoopParams,
} from './ralphLoopConfig.service.ts';

describe('ralphLoopConfig.service', () => {
  test('requires gh when PR automation is configured', () => {
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'pr',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(true);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'only-edit',
        mergeCondition: 'ci-passed',
        review: false,
      }),
    ).toBe(true);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'draft-pr',
        mergeCondition: 'comment-fixed',
        review: false,
      }),
    ).toBe(true);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'commit',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(false);
  });

  test('rejects merge automation without PR automation', () => {
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'commit',
        mergeCondition: 'ci-passed',
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'mergeCondition=ci-passed requires completion=pr or completion=draft-pr.',
    });
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'commit',
        mergeCondition: 'comment-fixed',
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'mergeCondition=comment-fixed requires completion=pr or completion=draft-pr.',
    });
  });

  test('returns configuration guidance for PR automation and merge automation', () => {
    expect(
      buildConfigurationGuidance({
        staticChecks: [],
        completion: 'pr',
        mergeCondition: 'comment-fixed',
        review: false,
      }),
    ).toEqual([
      'completion: pr is set, so set-ralph-loop will create the PR automatically upon completion. You do not need to create the PR manually, but you must commit your changes yourself and create the working branch yourself.',
      'mergeCondition: comment-fixed is set, so set-ralph-loop will first wait for CI to complete (same as ci-passed), then block merge if any PR comments remain unanswered, providing reply guidance. Once all comments are resolved, it merges automatically.',
    ]);
  });
});
