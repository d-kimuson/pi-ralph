import { runCommentFixedCheck } from './commentFixed.service.ts';

export type RalphLoopMergeCondition =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly approved: boolean;
    };

export type RalphLoopParams = {
  readonly staticChecks: readonly string[];
  readonly completion: 'edit-only' | 'draft-pr' | 'pr';
  readonly autofix: 'none' | 'ci' | 'comment';
  readonly mergeCondition: RalphLoopMergeCondition;
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

export type RalphLoopAutofixDetails = {
  readonly kind: 'comment-fixed';
  readonly headSha: string;
  readonly pendingComments: readonly RalphLoopPendingComment[];
};

export type RalphLoopMergeConditionDetails = {
  readonly kind: 'draft-ready-for-review';
};

type PendingAgentCheckState = {
  readonly status: 'pending';
};

type PassedAgentCheckState = {
  readonly status: 'passed';
  readonly message: string;
};

export type RalphLoopPhase = 'idle' | 'autofix-ci' | 'autofix-comment' | 'merge-condition';

export type RalphLoopState = {
  readonly review: PendingAgentCheckState | PassedAgentCheckState;
  readonly acceptanceCriteria: PendingAgentCheckState | PassedAgentCheckState;
  readonly phase: RalphLoopPhase;
};

type RalphLoopBaseResult = {
  readonly completion: RalphLoopParams['completion'];
  readonly autofix: RalphLoopParams['autofix'];
  readonly mergeCondition: RalphLoopParams['mergeCondition'];
  readonly staticChecks: readonly RalphLoopCommandResult[];
  readonly agentChecks: readonly RalphLoopAgentCheckResult[];
  readonly completionChecks: readonly RalphLoopCommandResult[];
  readonly completionAutomation?: readonly RalphLoopCompletionAutomationResult[];
  readonly autofixChecks?: readonly RalphLoopCommandResult[];
  readonly autofixDetails?: RalphLoopAutofixDetails;
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
        | 'autofix-ci-failed'
        | 'autofix-comment-failed'
        | 'merge-approval-failed'
        | 'merge-command-failed';
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
  readonly onAutofixStarted?: (
    autofix: Exclude<RalphLoopParams['autofix'], 'none'>,
  ) => Promise<void> | void;
  readonly onMergeConditionStarted?: (params: RalphLoopParams) => Promise<void> | void;
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
const PR_READY_FOR_REVIEW_COMMAND = 'gh pr ready';
const CI_WATCH_COMMAND = 'gh pr checks --watch --fail-fast || true';
const CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND =
  'blocking="$(gh pr checks --json name,bucket,state,link --jq \'.[] | select(.bucket == "fail" or .bucket == "pending" or .bucket == "cancel") | "\\(.name) [\\(.bucket)] \\(.link // "")"\')"; test -z "$blocking" || { printf "%s\\n" "$blocking"; exit 1; }';
const CI_MERGE_COMMAND = 'gh pr merge --delete-branch --merge';
const APPROVAL_WATCH_COMMAND =
  'while true; do decision="$(gh pr view --json reviewDecision --jq .reviewDecision)"; test "$decision" = "APPROVED" && exit 0; echo "waiting for PR approval: reviewDecision=$decision"; sleep 30; done';

const isSuccessful = (result: RalphLoopCommandResult): boolean => result.code === 0;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

const isMergeAutomationEnabled = (
  mergeCondition: RalphLoopParams['mergeCondition'],
): mergeCondition is Extract<RalphLoopParams['mergeCondition'], { readonly enabled: true }> =>
  mergeCondition.enabled;

const autofixPhaseFor = (autofix: Exclude<RalphLoopParams['autofix'], 'none'>): RalphLoopPhase => {
  switch (autofix) {
    case 'ci': {
      return 'autofix-ci';
    }
    case 'comment': {
      return 'autofix-comment';
    }
    default: {
      return assertNever(autofix);
    }
  }
};

const withPhase = (state: RalphLoopState, phase: RalphLoopPhase): RalphLoopState => ({
  ...state,
  phase,
});

export const createRalphLoopState = (): RalphLoopState => ({
  review: {
    status: 'pending',
  },
  acceptanceCriteria: {
    status: 'pending',
  },
  phase: 'idle',
});

const completionChecksFor = (completion: RalphLoopParams['completion']): readonly string[] => {
  switch (completion) {
    case 'edit-only': {
      return [];
    }
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
    case 'edit-only': {
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
    case 'edit-only': {
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

const autofixChecksFor = (autofix: RalphLoopParams['autofix']): readonly string[] => {
  switch (autofix) {
    case 'none': {
      return [];
    }
    case 'ci':
    case 'comment': {
      return [CI_WATCH_COMMAND, CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND];
    }
    default: {
      return assertNever(autofix);
    }
  }
};

const requiresReadyForReviewBeforeMerge = (params: RalphLoopParams): boolean =>
  params.completion === 'draft-pr' && isMergeAutomationEnabled(params.mergeCondition);

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

type RalphLoopResultAccumulator = {
  readonly staticChecks: readonly RalphLoopCommandResult[];
  readonly agentChecks: readonly RalphLoopAgentCheckResult[];
  readonly completionChecks: readonly RalphLoopCommandResult[];
  readonly completionAutomationResults: readonly RalphLoopCompletionAutomationResult[];
};

const buildBaseResult = (
  params: RalphLoopParams,
  accumulator: RalphLoopResultAccumulator,
  extras?: {
    readonly autofixChecks?: readonly RalphLoopCommandResult[];
    readonly autofixDetails?: RalphLoopAutofixDetails;
    readonly mergeConditionChecks?: readonly RalphLoopCommandResult[];
    readonly mergeConditionDetails?: RalphLoopMergeConditionDetails;
  },
): RalphLoopBaseResult => ({
  completion: params.completion,
  autofix: params.autofix,
  mergeCondition: params.mergeCondition,
  staticChecks: accumulator.staticChecks,
  agentChecks: accumulator.agentChecks,
  completionChecks: accumulator.completionChecks,
  ...(accumulator.completionAutomationResults.length > 0
    ? { completionAutomation: accumulator.completionAutomationResults }
    : {}),
  ...(extras?.autofixChecks !== undefined && extras.autofixChecks.length > 0
    ? { autofixChecks: extras.autofixChecks }
    : {}),
  ...(extras?.autofixDetails === undefined ? {} : { autofixDetails: extras.autofixDetails }),
  ...(extras?.mergeConditionChecks !== undefined && extras.mergeConditionChecks.length > 0
    ? { mergeConditionChecks: extras.mergeConditionChecks }
    : {}),
  ...(extras?.mergeConditionDetails === undefined
    ? {}
    : { mergeConditionDetails: extras.mergeConditionDetails }),
});

const continueOutcome = (
  params: RalphLoopParams,
  state: RalphLoopState,
  reason: Extract<RalphLoopResult, { readonly kind: 'continue' }>['reason'],
  accumulator: RalphLoopResultAccumulator,
  extras?: {
    readonly autofixChecks?: readonly RalphLoopCommandResult[];
    readonly autofixDetails?: RalphLoopAutofixDetails;
    readonly mergeConditionChecks?: readonly RalphLoopCommandResult[];
    readonly mergeConditionDetails?: RalphLoopMergeConditionDetails;
  },
): RalphLoopOutcome => ({
  state,
  result: {
    kind: 'continue',
    reason,
    ...buildBaseResult(params, accumulator, extras),
  },
});

const completedOutcome = (
  params: RalphLoopParams,
  state: RalphLoopState,
  accumulator: RalphLoopResultAccumulator,
  extras?: {
    readonly autofixChecks?: readonly RalphLoopCommandResult[];
    readonly autofixDetails?: RalphLoopAutofixDetails;
    readonly mergeConditionChecks?: readonly RalphLoopCommandResult[];
    readonly mergeConditionDetails?: RalphLoopMergeConditionDetails;
  },
): RalphLoopOutcome => ({
  state,
  result: {
    kind: 'completed',
    ...buildBaseResult(params, accumulator, extras),
  },
});

type AutofixPhaseResult =
  | {
      readonly kind: 'passed';
      readonly state: RalphLoopState;
      readonly checks: readonly RalphLoopCommandResult[];
      readonly details?: RalphLoopAutofixDetails;
    }
  | {
      readonly kind: 'failed';
      readonly state: RalphLoopState;
      readonly reason: 'autofix-ci-failed' | 'autofix-comment-failed';
      readonly checks: readonly RalphLoopCommandResult[];
      readonly details?: RalphLoopAutofixDetails;
    };

const runAutofixPhase = async (
  params: RalphLoopParams,
  state: RalphLoopState,
  execute: RalphLoopExecutor,
  hooks: RalphLoopHooks | undefined,
): Promise<AutofixPhaseResult> => {
  if (params.autofix === 'none') {
    return {
      kind: 'passed',
      state: withPhase(state, 'idle'),
      checks: [],
    };
  }

  const phase = autofixPhaseFor(params.autofix);
  const phaseState = withPhase(state, phase);

  await hooks?.onAutofixStarted?.(params.autofix);

  const checks = [...(await runChecks(autofixChecksFor(params.autofix), execute))];
  const lastCheck = checks.at(-1);

  if (lastCheck !== undefined && !isSuccessful(lastCheck)) {
    return {
      kind: 'failed',
      state: phaseState,
      reason: 'autofix-ci-failed',
      checks,
    };
  }

  let details: RalphLoopAutofixDetails | undefined;

  if (params.autofix === 'comment') {
    const commentFixedOutcome = await runCommentFixedCheck(execute);
    checks.push(...commentFixedOutcome.results);
    details = commentFixedOutcome.details;

    const lastCommentCheck = commentFixedOutcome.results.at(-1);

    if (lastCommentCheck !== undefined && !isSuccessful(lastCommentCheck)) {
      return {
        kind: 'failed',
        state: phaseState,
        reason: 'autofix-comment-failed',
        checks,
        details,
      };
    }
  }

  return {
    kind: 'passed',
    state: withPhase(state, 'idle'),
    checks,
    ...(details === undefined ? {} : { details }),
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
  const initialAccumulator: RalphLoopResultAccumulator = {
    staticChecks,
    agentChecks: [],
    completionChecks: [],
    completionAutomationResults: [],
  };

  if (lastStaticCheck !== undefined && !isSuccessful(lastStaticCheck)) {
    return continueOutcome(
      params,
      withPhase(state, 'idle'),
      'static-check-failed',
      initialAccumulator,
    );
  }

  await hooks?.onStaticChecksPassed?.();

  const agentChecks: RalphLoopAgentCheckResult[] = [];
  let nextState = withPhase(state, 'idle');

  if (params.review) {
    await hooks?.onReviewStarted?.(nextState.review.status === 'passed');

    const reviewCheck = await runReviewCheck(nextState, executeAgentCheck);
    nextState = reviewCheck.state;
    agentChecks.push(reviewCheck.agentCheck);

    if (reviewCheck.agentCheck.outcome.result === 'reject') {
      return continueOutcome(params, withPhase(nextState, 'idle'), 'review-rejected', {
        ...initialAccumulator,
        agentChecks,
      });
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
      return continueOutcome(params, withPhase(nextState, 'idle'), 'acceptance-criteria-rejected', {
        ...initialAccumulator,
        agentChecks,
      });
    }
  }

  const completionCheckCommands = completionChecksFor(params.completion);

  if (completionCheckCommands.length > 0) {
    await hooks?.onCompletionChecksStarted?.();
  }

  const completionChecks = [...(await runChecks(completionCheckCommands, execute))];
  const completionAccumulator: RalphLoopResultAccumulator = {
    ...initialAccumulator,
    agentChecks,
    completionChecks,
    completionAutomationResults: [],
  };
  const lastCompletionCheck = completionChecks.at(-1);

  if (lastCompletionCheck !== undefined && !isSuccessful(lastCompletionCheck)) {
    return continueOutcome(
      params,
      withPhase(nextState, 'idle'),
      'completion-check-failed',
      completionAccumulator,
    );
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

    const automationAccumulator: RalphLoopResultAccumulator = {
      ...completionAccumulator,
      completionAutomationResults,
    };

    if (decision.result === 'reject') {
      return continueOutcome(
        params,
        withPhase(nextState, 'idle'),
        'completion-automation-failed',
        automationAccumulator,
      );
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
      return continueOutcome(
        params,
        withPhase(nextState, 'idle'),
        'completion-check-failed',
        automationAccumulator,
      );
    }
  }

  const accumulator: RalphLoopResultAccumulator = {
    ...completionAccumulator,
    completionAutomationResults,
  };

  const autofixOutcome = await runAutofixPhase(params, nextState, execute, hooks);

  if (autofixOutcome.kind === 'failed') {
    return continueOutcome(params, autofixOutcome.state, autofixOutcome.reason, accumulator, {
      autofixChecks: autofixOutcome.checks,
      ...(autofixOutcome.details === undefined ? {} : { autofixDetails: autofixOutcome.details }),
    });
  }

  if (!isMergeAutomationEnabled(params.mergeCondition)) {
    return completedOutcome(params, withPhase(autofixOutcome.state, 'idle'), accumulator, {
      autofixChecks: autofixOutcome.checks,
      ...(autofixOutcome.details === undefined ? {} : { autofixDetails: autofixOutcome.details }),
    });
  }

  const mergeState = withPhase(autofixOutcome.state, 'merge-condition');
  await hooks?.onMergeConditionStarted?.(params);

  const mergeConditionChecks: RalphLoopCommandResult[] = [];
  let mergeConditionDetails: RalphLoopMergeConditionDetails | undefined;
  let finalAutofixOutcome = autofixOutcome;

  if (requiresReadyForReviewBeforeMerge(params)) {
    const readyForReviewCheck = await execute(PR_READY_FOR_REVIEW_COMMAND);
    mergeConditionChecks.push(readyForReviewCheck);

    if (!isSuccessful(readyForReviewCheck)) {
      return continueOutcome(params, mergeState, 'merge-command-failed', accumulator, {
        autofixChecks: autofixOutcome.checks,
        ...(autofixOutcome.details === undefined ? {} : { autofixDetails: autofixOutcome.details }),
        mergeConditionChecks,
      });
    }

    mergeConditionDetails = {
      kind: 'draft-ready-for-review',
    };
  }

  if (params.mergeCondition.approved) {
    const approvalCheck = await execute(APPROVAL_WATCH_COMMAND);
    mergeConditionChecks.push(approvalCheck);

    if (!isSuccessful(approvalCheck)) {
      return continueOutcome(params, mergeState, 'merge-approval-failed', accumulator, {
        autofixChecks: autofixOutcome.checks,
        ...(autofixOutcome.details === undefined ? {} : { autofixDetails: autofixOutcome.details }),
        mergeConditionChecks,
        ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
      });
    }

    const recheckedAutofixOutcome = await runAutofixPhase(params, mergeState, execute, hooks);

    if (recheckedAutofixOutcome.kind === 'failed') {
      return continueOutcome(
        params,
        recheckedAutofixOutcome.state,
        recheckedAutofixOutcome.reason,
        accumulator,
        {
          autofixChecks: recheckedAutofixOutcome.checks,
          ...(recheckedAutofixOutcome.details === undefined
            ? {}
            : { autofixDetails: recheckedAutofixOutcome.details }),
          mergeConditionChecks,
          ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
        },
      );
    }

    finalAutofixOutcome = recheckedAutofixOutcome;
  }

  const mergeCommandResult = await execute(CI_MERGE_COMMAND);
  mergeConditionChecks.push(mergeCommandResult);

  if (!isSuccessful(mergeCommandResult)) {
    return continueOutcome(params, mergeState, 'merge-command-failed', accumulator, {
      autofixChecks: finalAutofixOutcome.checks,
      ...(finalAutofixOutcome.details === undefined
        ? {}
        : { autofixDetails: finalAutofixOutcome.details }),
      mergeConditionChecks,
      ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
    });
  }

  return completedOutcome(params, withPhase(mergeState, 'idle'), accumulator, {
    autofixChecks: finalAutofixOutcome.checks,
    ...(finalAutofixOutcome.details === undefined
      ? {}
      : { autofixDetails: finalAutofixOutcome.details }),
    mergeConditionChecks,
    ...(mergeConditionDetails === undefined ? {} : { mergeConditionDetails }),
  });
};
