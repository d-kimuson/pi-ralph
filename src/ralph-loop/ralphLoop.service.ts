export type RalphLoopParams = {
  readonly staticChecks: readonly string[];
  readonly completion: 'only-edit' | 'commit';
  readonly mergeCondition: 'none';
  readonly review: boolean;
  readonly acceptanceCriteria?: string;
};

export type RalphLoopCommandResult = {
  readonly command: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RalphLoopReviewDecision =
  | {
      readonly result: 'accept';
      readonly message: string;
    }
  | {
      readonly result: 'reject';
      readonly reason: string;
    };

export type RalphLoopAgentRequest =
  | {
      readonly kind: 'review';
    }
  | {
      readonly kind: 'acceptance-criteria';
      readonly acceptanceCriteria: string;
    };

export type RalphLoopAgentCheckResult = {
  readonly kind: RalphLoopAgentRequest['kind'];
  readonly reused: boolean;
  readonly outcome: RalphLoopReviewDecision;
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
};

export type RalphLoopResult =
  | (RalphLoopBaseResult & {
      readonly kind: 'continue';
      readonly reason:
        | 'static-check-failed'
        | 'review-rejected'
        | 'acceptance-criteria-rejected'
        | 'completion-check-failed';
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

export type RalphLoopHooks = {
  readonly onStaticChecksPassed?: () => Promise<void> | void;
  readonly onReviewStarted?: (reused: boolean) => Promise<void> | void;
  readonly onAcceptanceCriteriaStarted?: (reused: boolean) => Promise<void> | void;
  readonly onCompletionChecksStarted?: () => Promise<void> | void;
};

const COMMIT_COMPLETION_CHECKS = [
  'git diff --quiet --exit-code',
  'git diff --cached --quiet --exit-code',
  'test -z "$(git ls-files --others --exclude-standard)"',
] as const satisfies readonly string[];

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
    case 'commit': {
      return COMMIT_COMPLETION_CHECKS;
    }
    default: {
      return assertNever(completion);
    }
  }
};

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

  const completionChecks = await runChecks(completionCheckCommands, execute);
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

  return {
    state: nextState,
    result: {
      kind: 'completed',
      completion: params.completion,
      mergeCondition: params.mergeCondition,
      staticChecks,
      agentChecks,
      completionChecks,
    },
  };
};
