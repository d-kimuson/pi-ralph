export type RalphLoopParams = {
  readonly staticChecks: readonly string[];
  readonly completion: 'only-edit' | 'commit';
  readonly mergeCondition: 'none';
};

export type RalphLoopCommandResult = {
  readonly command: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RalphLoopResult =
  | {
      readonly kind: 'continue';
      readonly reason: 'static-check-failed';
      readonly completion: RalphLoopParams['completion'];
      readonly mergeCondition: RalphLoopParams['mergeCondition'];
      readonly staticChecks: readonly RalphLoopCommandResult[];
    }
  | {
      readonly kind: 'continue';
      readonly reason: 'completion-check-failed';
      readonly completion: 'commit';
      readonly mergeCondition: RalphLoopParams['mergeCondition'];
      readonly staticChecks: readonly RalphLoopCommandResult[];
      readonly completionChecks: readonly RalphLoopCommandResult[];
    }
  | {
      readonly kind: 'completed';
      readonly completion: RalphLoopParams['completion'];
      readonly mergeCondition: RalphLoopParams['mergeCondition'];
      readonly staticChecks: readonly RalphLoopCommandResult[];
      readonly completionChecks: readonly RalphLoopCommandResult[];
    };

export type RalphLoopExecutor = (command: string) => Promise<RalphLoopCommandResult>;

const COMMIT_COMPLETION_CHECKS = [
  'git diff --quiet --exit-code',
  'git diff --cached --quiet --exit-code',
  'test -z "$(git ls-files --others --exclude-standard)"',
] as const satisfies readonly string[];

const isSuccessful = (result: RalphLoopCommandResult): boolean => result.code === 0;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

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

export const runRalphLoop = async (
  params: RalphLoopParams,
  execute: RalphLoopExecutor,
): Promise<RalphLoopResult> => {
  const staticChecks = await runChecks(params.staticChecks, execute);
  const lastStaticCheck = staticChecks.at(-1);

  if (lastStaticCheck !== undefined && !isSuccessful(lastStaticCheck)) {
    return {
      kind: 'continue',
      reason: 'static-check-failed',
      completion: params.completion,
      mergeCondition: params.mergeCondition,
      staticChecks,
    };
  }

  const completionCheckCommands = completionChecksFor(params.completion);
  const completionChecks = await runChecks(completionCheckCommands, execute);
  const lastCompletionCheck = completionChecks.at(-1);

  if (lastCompletionCheck !== undefined && !isSuccessful(lastCompletionCheck)) {
    return {
      kind: 'continue',
      reason: 'completion-check-failed',
      completion: 'commit',
      mergeCondition: params.mergeCondition,
      staticChecks,
      completionChecks,
    };
  }

  return {
    kind: 'completed',
    completion: params.completion,
    mergeCondition: params.mergeCondition,
    staticChecks,
    completionChecks,
  };
};
