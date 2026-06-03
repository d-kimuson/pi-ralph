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
        mergeCondition: { enabled: false },
        review: false,
      }),
    ).toBe(true);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'none',
        mergeCondition: { enabled: false },
        review: false,
      }),
    ).toBe(false);
    expect(
      requiresGitHubCli({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'none',
        mergeCondition: { enabled: true, approved: false },
        review: false,
      }),
    ).toBe(true);
  });

  test('rejects invalid completion and merge automation combinations', () => {
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'edit-only',
        autofix: 'ci',
        mergeCondition: { enabled: false },
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
        mergeCondition: { enabled: true, approved: false },
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message: 'mergeCondition.enabled=true requires completion=pr or completion=draft-pr.',
    });
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'draft-pr',
        autofix: 'none',
        mergeCondition: { enabled: true, approved: true },
        review: false,
      }),
    ).toEqual({
      kind: 'invalid',
      message:
        'completion=draft-pr with mergeCondition.enabled=true requires autofix=ci or autofix=comment.',
    });
    expect(
      validateRalphLoopParams({
        staticChecks: [],
        completion: 'pr',
        autofix: 'none',
        mergeCondition: { enabled: true, approved: false },
        review: false,
      }),
    ).toEqual({
      kind: 'valid',
    });
  });

  test('returns configuration guidance for PR automation, autofix, and merge automation', () => {
    expect(
      buildConfigurationGuidance({
        staticChecks: [],
        completion: 'draft-pr',
        autofix: 'comment',
        mergeCondition: { enabled: true, approved: true },
        review: false,
      }),
    ).toEqual([
      'completion: draft-pr is set, so set-ralph-loop will create or update a draft PR after commit cleanliness checks pass. You must create and switch to a non-default working branch yourself before starting; ralph-package does not create branches for you.',
      'autofix: comment is set, so set-ralph-loop will handle PR CI first when present, then keep the task open for the agent to address unresolved PR comments before merge can continue.',
      'mergeCondition: enabled=true, approved=true is set, so set-ralph-loop will wait until GitHub reports the PR review decision as APPROVED after the configured autofix flow completes, then merge.',
      'completion: draft-pr is combined with merge automation, so set-ralph-loop will automatically mark the draft PR as ready for review before waiting for approval or merging.',
    ]);
  });
});
