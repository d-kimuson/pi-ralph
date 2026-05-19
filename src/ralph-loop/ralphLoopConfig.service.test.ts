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
        completion: 'commit',
        mergeCondition: 'none',
        review: false,
      }),
    ).toBe(false);
  });

  test('rejects ci-passed without PR automation', () => {
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
  });

  test('returns configuration guidance for PR automation and CI auto-merge', () => {
    expect(
      buildConfigurationGuidance({
        staticChecks: [],
        completion: 'pr',
        mergeCondition: 'ci-passed',
        review: false,
      }),
    ).toEqual([
      'completion: pr を設定したので、完了後は set-ralph-loop が自動で PR を作成します。あなたが PR を手動で作成する必要はありませんが、コミットは自身で行ってください。PR を作成するためのブランチは自身で切ってください。',
      'mergeCondition: ci-passed を設定したので、PR 作成後は set-ralph-loop が gh で CI 完了を待ち、失敗がなければ自動でマージします。CI が失敗した場合はタスクを開いたまま自動で作業ループに戻します。',
    ]);
  });
});
