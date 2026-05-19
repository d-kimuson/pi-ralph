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
      'completion: pr を設定したので、完了後は set-ralph-loop が自動で PR を作成します。あなたが PR を手動で作成する必要はありませんが、コミットは自身で行ってください。PR を作成するためのブランチは自身で切ってください。',
      'mergeCondition: comment-fixed を設定したので、PR 作成後はまず ci-passed と同様に CI 完了を待ちます。その後、未返信の PR コメントが残っていればマージせずに止まり、返信用コマンドを案内します。コメント返信が解消されたら自動でマージします。',
    ]);
  });
});
