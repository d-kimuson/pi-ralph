import { runCommentFixedCheck } from './commentFixed.service.ts';

export type RalphLoopParams = {
  readonly staticChecks: readonly string[];
  readonly completion: 'only-edit' | 'commit' | 'pr' | 'draft-pr';
  readonly mergeCondition: 'none' | 'ci-passed' | 'comment-fixed';
  readonly review: boolean;
  readonly acceptanceCriteria?: string;
};

export type RalphLoopCommandResult = {
  readonly command: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RalphLoopDecision =
  | {
      readonly result: 'accept';
      readonly message: string;
    }
  | {
      readonly result: 'reject';
      readonly reason: string;
    };

export type RalphLoopReviewDecision = RalphLoopDecision;

export type RalphLoopPullRequestTemplate = {
  readonly path: string;
  readonly content: string;
};

export type RalphLoopAgentRequest =
  | {
      readonly kind: 'review';
    }
  | {
      readonly kind: 'acceptance-criteria';
      readonly acceptanceCriteria: string;
    };

export type RalphLoopCompletionAutomationRequest = {
  readonly kind: 'pull-request';
  readonly mode: 'pr' | 'draft-pr';
  readonly pullRequestTemplate?: RalphLoopPullRequestTemplate;
};

export type RalphLoopAgentCheckResult = {
  readonly kind: RalphLoopAgentRequest['kind'];
  readonly reused: boolean;
  readonly outcome: RalphLoopDecision;
};

export type RalphLoopCompletionAutomationResult = {
  readonly kind: RalphLoopCompletionAutomationRequest['kind'];
  readonly mode: RalphLoopCompletionAutomationRequest['mode'];
  readonly outcome: RalphLoopDecision;
};

export type RalphLoopPendingComment = {
  readonly kind: 'issue-comment' | 'review' | 'review-thread';
  readonly authorLogin: string;
  readonly url: string;
  readonly body: string;
  readonly replyCommand: string;
};

export type RalphLoopMergeConditionDetails = {
  readonly kind: 'comment-fixed';
  readonly headSha: string;
  readonly pendingComments: readonly RalphLoopPendingComment[];
};

type PendingAgentCheckState = {
  readonly status: 'pending';
};

type PassedAgentCheckState = {
  readonly status: 'passed';
  readonly message: string;
};

export type RalphLoopState = {
  readonly review: PendingAgentCheckState | PassedAgentCheckState;
  readonly acceptanceCriteria: PendingAgentCheckState | PassedAgentCheckState;
};

type RalphLoopBaseResult = {
  readonly completion: RalphLoopParams['completion'];
  readonly mergeCondition: RalphLoopParams['mergeCondition'];
  readonly staticChecks: readonly RalphLoopCommandResult[];
  readonly agentChecks: readonly RalphLoopAgentCheckResult[];
  readonly completionChecks: readonly RalphLoopCommandResult[];
  readonly completionAutomation?: readonly RalphLoopCompletionAutomationResult[];
  readonly mergeConditionChecks?: readonly RalphLoopCommandResult[];
  readonly mergeConditionDetails?: RalphLoopMergeConditionDetails;
};

export type RalphLoopResult =
  | (RalphLoopBaseResult & {
      readonly kind: 'continue';
      readonly reason:
        | 'static-check-failed'
        | 'review-rejected'
        | 'acceptance-criteria-rejected'
        | 'completion-check-failed'
        | 'completion-automation-failed'
        | 'merge-condition-failed';
    })
  | (RalphLoopBaseResult & {
      readonly kind: 'completed';
    });

export type RalphLoopOutcome = {
  readonly state: RalphLoopState;
  readonly result: RalphLoopResult;
};

export type RalphLoopExecutor = (command: string) => Promise<RalphLoopCommandResult>;
export type RalphLoopAgentExecutor = (
  request: RalphLoopAgentRequest,
) => Promise<RalphLoopReviewDecision>;
export type RalphLoopCompletionAutomationExecutor = (
  request: RalphLoopCompletionAutomationRequest,
) => Promise<RalphLoopDecision>;

export type RalphLoopHooks = {
  readonly onStaticChecksPassed?: () => Promise<void> | void;
  readonly onReviewStarted?: (reused: boolean) => Promise<void> | void;
  readonly onAcceptanceCriteriaStarted?: (reused: boolean) => Promise<void> | void;
  readonly onCompletionChecksStarted?: () => Promise<void> | void;
  readonly onCompletionAutomationStarted?: (
    mode: RalphLoopCompletionAutomationRequest['mode'],
  ) => Promise<void> | void;
  readonly onMergeConditionStarted?: (
    mergeCondition: Exclude<RalphLoopParams['mergeCondition'], 'none'>,
  ) => Promise<void> | void;
};

export type RalphLoopRunOptions = {
  readonly executeCompletionAutomation?: RalphLoopCompletionAutomationExecutor;
  readonly pullRequestTemplate?: RalphLoopPullRequestTemplate;
};

const COMMIT_COMPLETION_CHECKS = [
  'git diff --quiet --exit-code',
  'git diff --cached --quiet --exit-code',
  'test -z "$(git ls-files --others --exclude-standard)"',
] as const satisfies readonly string[];

const PR_VERIFY_URL_COMMAND = 'gh pr view --json url --jq .url';
const PR_VERIFY_READY_COMMAND = 'test "$(gh pr view --json isDraft --jq .isDraft)" = "false"';
const DRAFT_PR_VERIFY_COMMAND = 'test "$(gh pr view --json isDraft --jq .isDraft)" = "true"';
const CI_WATCH_COMMAND = 'gh pr checks --watch --fail-fast || true';
const CI_ASSERT_HAS_CHECKS_COMMAND =
  'checks="$(gh pr checks --json name --jq \'.[0].name // empty\')"; test -n "$checks" || { echo "no CI checks reported on this PR"; exit 1; }';
const CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND =
  'blocking="$(gh pr checks --json name,bucket,state,link --jq \'.[] | select(.bucket == "fail" or .bucket == "pending" or .bucket == "cancel") | "\\(.name) [\\(.bucket)] \\(.link // "")"\')"; test -z "$blocking" || { printf "%s\\n" "$blocking"; exit 1; }';
const CI_MERGE_COMMAND = 'gh pr merge --delete-branch --merge';

const isSuccessful = (result: RalphLoopCommandResult): boolean => result.code === 0;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

export const createRalphLoopState = (): RalphLoopState => ({
  review: {
    status: 'pending',
  },
  acceptanceCriteria: {
    status: 'pending',
  },
});

const completionChecksFor = (completion: RalphLoopParams['completion']): readonly string[] => {
  switch (completion) {
    case 'only-edit': {
      return [];
    }
    case 'commit':
    case 'pr':
    case 'draft-pr': {
      return COMMIT_COMPLETION_CHECKS;
    }
    default: {
      return assertNever(completion);
    }
  }
};

const completionAutomationRequestFor = (
  completion: RalphLoopParams['completion'],
  pullRequestTemplate: RalphLoopPullRequestTemplate | undefined,
): RalphLoopCompletionAutomationRequest | undefined => {
  switch (completion) {
    case 'only-edit':
    case 'commit': {
      return undefined;
    }
    case 'pr':
    case 'draft-pr': {
      return {
        kind: 'pull-request',
        mode: completion,
        pullRequestTemplate,
      };
    }
    default: {
      return assertNever(completion);
    }
  }
};

const completionVerificationChecksFor = (
  completion: RalphLoopParams['completion'],
): readonly string[] => {
  switch (completion) {
    case 'only-edit':
    case 'commit': {
      return [];
    }
    case 'pr': {
      return [PR_VERIFY_URL_COMMAND, PR_VERIFY_READY_COMMAND];
    }
    case 'draft-pr': {
      return [PR_VERIFY_URL_COMMAND, DRAFT_PR_VERIFY_COMMAND];
    }
    default: {
      return assertNever(completion);
    }
  }
};

const mergeConditionChecksFor = (
  mergeCondition: RalphLoopParams['mergeCondition'],
): readonly string[] => {
  switch (mergeCondition) {
    case 'none': {
      return [];
    }
    case 'ci-passed':
    case 'comment-fixed': {
      return [CI_WATCH_COMMAND, CI_ASSERT_HAS_CHECKS_COMMAND, CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND];
    }
    default: {
      return assertNever(mergeCondition);
    }
  }
};

const shouldMergeAfterChecks = (mergeCondition: RalphLoopParams['mergeCondition']): boolean =>
  mergeCondition !== 'none';

const runChecks = async (
  commands: readonly string[],
  execute: RalphLoopExecutor,
): Promise<readonly RalphLoopCommandResult[]> => {
  const results: RalphLoopCommandResult[] = [];

  for (const command of commands) {
    const result = await execute(command);
    results.push(result);

    if (!isSuccessful(result)) {
      return results;
    }
  }

  return results;
};

const createAcceptedCheckResult = (
  kind: RalphLoopAgentRequest['kind'],
  message: string,
  reused: boolean,
): RalphLoopAgentCheckResult => ({
  kind,
  reused,
  outcome: {
    result: 'accept',
    message,
  },
});

const runReviewCheck = async (
  state: RalphLoopState,
  executeAgentCheck: RalphLoopAgentExecutor,
): Promise<{
  readonly state: RalphLoopState;
  readonly agentCheck: RalphLoopAgentCheckResult;
}> => {
  if (state.review.status === 'passed') {
    return {
      state,
      agentCheck: createAcceptedCheckResult('review', state.review.message, true),
    };
  }

  const decision = await executeAgentCheck({ kind: 'review' });

  if (decision.result === 'accept') {
    return {
      state: {
        ...state,
        review: {
          status: 'passed',
          message: decision.message,
        },
      },
      agentCheck: {
        kind: 'review',
        reused: false,
        outcome: decision,
      },
    };
  }

  return {
    state,
    agentCheck: {
      kind: 'review',
      reused: false,
      outcome: decision,
    },
  };
};

const runAcceptanceCriteriaCheck = async (
  params: RalphLoopParams,
  state: RalphLoopState,
  executeAgentCheck: RalphLoopAgentExecutor,
): Promise<{
  readonly state: RalphLoopState;
  readonly agentCheck: RalphLoopAgentCheckResult;
}> => {
  if (params.acceptanceCriteria === undefined) {
    throw new Error('acceptanceCriteria is required for acceptance criteria checks');
  }

  if (state.acceptanceCriteria.status === 'passed') {
    return {
      state,
      agentCheck: createAcceptedCheckResult(
        'acceptance-criteria',
        state.acceptanceCriteria.message,
        true,
      ),
    };
  }

  const decision = await executeAgentCheck({
    kind: 'acceptance-criteria',
    acceptanceCriteria: params.acceptanceCriteria,
  });

  if (decision.result === 'accept') {
    return {
      state: {
        ...state,
        acceptanceCriteria: {
          status: 'passed',
          message: decision.message,
        },
      },
      agentCheck: {
        kind: 'acceptance-criteria',
        reused: false,
        outcome: decision,
      },
    };
  }

  return {
    state,
    agentCheck: {
      kind: 'acceptance-criteria',
      reused: false,
      outcome: decision,
    },
  };
};

export const runRalphLoop = async (
  params: RalphLoopParams,
  state: RalphLoopState,
  execute: RalphLoopExecutor,
  executeAgentCheck: RalphLoopAgentExecutor,
  hooks?: RalphLoopHooks,
  options?: RalphLoopRunOptions,
): Promise<RalphLoopOutcome> => {
  const staticChecks = await runChecks(params.staticChecks, execute);
  const lastStaticCheck = staticChecks.at(-1);

  if (lastStaticCheck !== undefined && !isSuccessful(lastStaticCheck)) {
    return {
      state,
      result: {
        kind: 'continue',
        reason: 'static-check-failed',
        completion: params.completion,
        mergeCondition: params.mergeCondition,
        staticChecks,
        agentChecks: [],
        completionChecks: [],
      },
    };
  }

  await hooks?.onStaticChecksPassed?.();

  const agentChecks: RalphLoopAgentCheckResult[] = [];
  let nextState = state;

  if (params.review) {
    await hooks?.onReviewStarted?.(nextState.review.status === 'passed');

    const reviewCheck = await runReviewCheck(nextState, executeAgentCheck);
    nextState = reviewCheck.state;
    agentChecks.push(reviewCheck.agentCheck);

    if (reviewCheck.agentCheck.outcome.result === 'reject') {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'review-rejected',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks: [],
        },
      };
    }
  }

  if (params.acceptanceCriteria !== undefined) {
    await hooks?.onAcceptanceCriteriaStarted?.(nextState.acceptanceCriteria.status === 'passed');

    const acceptanceCriteriaCheck = await runAcceptanceCriteriaCheck(
      params,
      nextState,
      executeAgentCheck,
    );
    nextState = acceptanceCriteriaCheck.state;
    agentChecks.push(acceptanceCriteriaCheck.agentCheck);

    if (acceptanceCriteriaCheck.agentCheck.outcome.result === 'reject') {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'acceptance-criteria-rejected',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks: [],
        },
      };
    }
  }

  const completionCheckCommands = completionChecksFor(params.completion);

  if (completionCheckCommands.length > 0) {
    await hooks?.onCompletionChecksStarted?.();
  }

  const completionChecks = [...(await runChecks(completionCheckCommands, execute))];
  const lastCompletionCheck = completionChecks.at(-1);

  if (lastCompletionCheck !== undefined && !isSuccessful(lastCompletionCheck)) {
    return {
      state: nextState,
      result: {
        kind: 'continue',
        reason: 'completion-check-failed',
        completion: params.completion,
        mergeCondition: params.mergeCondition,
        staticChecks,
        agentChecks,
        completionChecks,
      },
    };
  }

  const completionAutomationRequest = completionAutomationRequestFor(
    params.completion,
    options?.pullRequestTemplate,
  );
  const completionAutomationResults: RalphLoopCompletionAutomationResult[] = [];

  if (completionAutomationRequest !== undefined) {
    if (options?.executeCompletionAutomation === undefined) {
      throw new Error(
        `completion automation executor is required for completion=${params.completion}.`,
      );
    }

    await hooks?.onCompletionAutomationStarted?.(completionAutomationRequest.mode);

    const decision = await options.executeCompletionAutomation(completionAutomationRequest);

    completionAutomationResults.push({
      kind: completionAutomationRequest.kind,
      mode: completionAutomationRequest.mode,
      outcome: decision,
    });

    if (decision.result === 'reject') {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'completion-automation-failed',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks,
          completionAutomation: completionAutomationResults,
        },
      };
    }

    const completionVerificationChecks = await runChecks(
      completionVerificationChecksFor(params.completion),
      execute,
    );

    completionChecks.push(...completionVerificationChecks);

    const lastCompletionVerificationCheck = completionVerificationChecks.at(-1);

    if (
      lastCompletionVerificationCheck !== undefined &&
      !isSuccessful(lastCompletionVerificationCheck)
    ) {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'completion-check-failed',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks,
          completionAutomation: completionAutomationResults,
        },
      };
    }
  }

  const mergeConditionCheckCommands = mergeConditionChecksFor(params.mergeCondition);

  if (mergeConditionCheckCommands.length > 0 && params.mergeCondition !== 'none') {
    await hooks?.onMergeConditionStarted?.(params.mergeCondition);
  }

  const mergeConditionChecks = [...(await runChecks(mergeConditionCheckCommands, execute))];
  const lastMergeConditionCheck = mergeConditionChecks.at(-1);

  if (lastMergeConditionCheck !== undefined && !isSuccessful(lastMergeConditionCheck)) {
    return {
      state: nextState,
      result: {
        kind: 'continue',
        reason: 'merge-condition-failed',
        completion: params.completion,
        mergeCondition: params.mergeCondition,
        staticChecks,
        agentChecks,
        completionChecks,
        ...(completionAutomationResults.length > 0
          ? { completionAutomation: completionAutomationResults }
          : {}),
        mergeConditionChecks,
      },
    };
  }

  let mergeConditionDetails: RalphLoopMergeConditionDetails | undefined;

  if (params.mergeCondition === 'comment-fixed') {
    const commentFixedOutcome = await runCommentFixedCheck(execute);
    mergeConditionChecks.push(...commentFixedOutcome.results);
    mergeConditionDetails = commentFixedOutcome.details;

    const lastCommentFixedCheck = commentFixedOutcome.results.at(-1);

    if (lastCommentFixedCheck !== undefined && !isSuccessful(lastCommentFixedCheck)) {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'merge-condition-failed',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks,
          ...(completionAutomationResults.length > 0
            ? { completionAutomation: completionAutomationResults }
            : {}),
          mergeConditionChecks,
          mergeConditionDetails,
        },
      };
    }
  }

  if (shouldMergeAfterChecks(params.mergeCondition)) {
    const mergeCommandResult = await execute(CI_MERGE_COMMAND);
    mergeConditionChecks.push(mergeCommandResult);

    if (!isSuccessful(mergeCommandResult)) {
      return {
        state: nextState,
        result: {
          kind: 'continue',
          reason: 'merge-condition-failed',
          completion: params.completion,
          mergeCondition: params.mergeCondition,
          staticChecks,
          agentChecks,
          completionChecks,
          ...(completionAutomationResults.length > 0
            ? { completionAutomation: completionAutomationResults }
            : {}),
          mergeConditionChecks,
          ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
        },
      };
    }
  }

  return {
    state: nextState,
    result: {
      kind: 'completed',
      completion: params.completion,
      mergeCondition: params.mergeCondition,
      staticChecks,
      agentChecks,
      completionChecks,
      ...(completionAutomationResults.length > 0
        ? { completionAutomation: completionAutomationResults }
        : {}),
      ...(mergeConditionCheckCommands.length > 0 ? { mergeConditionChecks } : {}),
      ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
    },
  };
};
