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
      'completion: pr を設定したので、完了後は set-ralph-loop が自動で PR を作成します。あなたが PR を手動で作成する必要はありませんが、コミットは自身で行ってください。PR を作成するためのブランチは自身で切ってください。',
    );
  }

  if (params.completion === 'draft-pr') {
    guidance.push(
      'completion: draft-pr を設定したので、完了後は set-ralph-loop が自動で Draft PR を作成します。あなたが Draft PR を手動で作成する必要はありませんが、コミットは自身で行ってください。PR を作成するためのブランチは自身で切ってください。',
    );
  }

  if (params.mergeCondition === 'ci-passed') {
    guidance.push(
      'mergeCondition: ci-passed を設定したので、PR 作成後は set-ralph-loop が gh で CI 完了を待ち、失敗がなければ自動でマージします。CI が失敗した場合はタスクを開いたまま自動で作業ループに戻します。',
    );
  }

  if (params.mergeCondition === 'comment-fixed') {
    guidance.push(
      'mergeCondition: comment-fixed を設定したので、PR 作成後はまず ci-passed と同様に CI 完了を待ちます。その後、未返信の PR コメントが残っていればマージせずに止まり、返信用コマンドを案内します。コメント返信が解消されたら自動でマージします。',
    );
  }

  return guidance;
};
