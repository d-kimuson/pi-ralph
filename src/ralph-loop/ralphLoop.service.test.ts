import { describe, expect, test } from 'vitest';

import { createRalphLoopState, runRalphLoop } from './ralphLoop.service.ts';

const PR_VERIFY_URL_COMMAND = 'gh pr view --json url --jq .url';
const PR_VERIFY_READY_COMMAND = 'test "$(gh pr view --json isDraft --jq .isDraft)" = "false"';
const CI_WATCH_COMMAND = 'gh pr checks --watch --fail-fast --required || true';
const CI_LIST_FAILED_COMMAND =
  'gh pr checks --required --json name,bucket,state,link --jq \'.[] | select(.bucket == "fail") | "\\(.name) (\\(.state)) \\(.link // "")"\'';
const CI_ASSERT_NONE_FAILED_COMMAND =
  'test -z "$(gh pr checks --required --json name,bucket --jq \'.[] | select(.bucket == \\"fail\\") | .name\')"';
const CI_MERGE_COMMAND =
  'gh pr merge --delete-branch --merge || gh pr merge --delete-branch --auto';

const createCommandExecutor = (
  sequence: string[],
  results: ReadonlyArray<{
    readonly code: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }>,
) => {
  const commands: string[] = [];
  let index = 0;

  const execute = (command: string) => {
    const nextResult = results[index];

    if (nextResult === undefined) {
      throw new Error(`Unexpected command: ${command}`);
    }

    sequence.push(`command:${command}`);
    commands.push(command);
    index += 1;

    return Promise.resolve({
      command,
      code: nextResult.code,
      stdout: nextResult.stdout ?? '',
      stderr: nextResult.stderr ?? '',
    });
  };

  return {
    commands,
    execute,
  };
};

const createAgentExecutor = (
  sequence: string[],
  results: ReadonlyArray<
    | {
        readonly result: 'accept';
        readonly message: string;
      }
    | {
        readonly result: 'reject';
        readonly reason: string;
      }
  >,
) => {
  const calls: Array<
    { kind: 'review' } | { kind: 'acceptance-criteria'; acceptanceCriteria: string }
  > = [];
  let index = 0;

  const execute = (
    request: { kind: 'review' } | { kind: 'acceptance-criteria'; acceptanceCriteria: string },
  ) => {
    const nextResult = results[index];

    if (nextResult === undefined) {
      throw new Error(`Unexpected agent request: ${request.kind}`);
    }

    sequence.push(`agent:${request.kind}`);
    calls.push(request);
    index += 1;

    return Promise.resolve(nextResult);
  };

  return {
    calls,
    execute,
  };
};

const createCompletionAutomationExecutor = (
  sequence: string[],
  results: ReadonlyArray<
    | {
        readonly result: 'accept';
        readonly message: string;
      }
    | {
        readonly result: 'reject';
        readonly reason: string;
      }
  >,
) => {
  const calls: Array<{
    kind: 'pull-request';
    mode: 'pr' | 'draft-pr';
    pullRequestTemplate?: {
      path: string;
      content: string;
    };
  }> = [];
  let index = 0;

  const execute = (request: {
    kind: 'pull-request';
    mode: 'pr' | 'draft-pr';
    pullRequestTemplate?: {
      path: string;
      content: string;
    };
  }) => {
    const nextResult = results[index];

    if (nextResult === undefined) {
      throw new Error(`Unexpected completion automation request: ${request.kind}`);
    }

    sequence.push(`automation:${request.mode}`);
    calls.push(request);
    index += 1;

    return Promise.resolve(nextResult);
  };

  return {
    calls,
    execute,
  };
};

describe('runRalphLoop', () => {
  test('static check failure stops before review, acceptance criteria, and completion checks', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 1,
        stderr: 'typecheck failed',
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'accept',
        message: 'review passed',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm typecheck'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'ship it',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
    );

    expect(sequence).toEqual(['command:pnpm typecheck']);
    expect(agent.calls).toEqual([]);
    expect(outcome).toEqual({
      state: createRalphLoopState(),
      result: {
        kind: 'continue',
        reason: 'static-check-failed',
        completion: 'commit',
        mergeCondition: 'none',
        staticChecks: [
          {
            command: 'pnpm typecheck',
            code: 1,
            stdout: '',
            stderr: 'typecheck failed',
          },
        ],
        agentChecks: [],
        completionChecks: [],
      },
    });
  });

  test('emits phase transitions after static checks pass', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'accept',
        message: 'review passed',
      },
      {
        result: 'accept',
        message: 'acceptance criteria passed',
      },
    ]);

    await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
      {
        onStaticChecksPassed: () => {
          sequence.push('phase:static-checks-passed');
        },
        onReviewStarted: () => {
          sequence.push('phase:review');
        },
        onAcceptanceCriteriaStarted: () => {
          sequence.push('phase:acceptance-criteria');
        },
        onCompletionChecksStarted: () => {
          sequence.push('phase:completion');
        },
      },
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'phase:static-checks-passed',
      'phase:review',
      'agent:review',
      'phase:acceptance-criteria',
      'agent:acceptance-criteria',
      'phase:completion',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
    ]);
  });

  test('review and acceptance criteria run before commit completion checks', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'accept',
        message: 'review passed',
      },
      {
        result: 'accept',
        message: 'acceptance criteria passed',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'agent:review',
      'agent:acceptance-criteria',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
    ]);
    expect(outcome).toEqual({
      state: {
        review: {
          status: 'passed',
          message: 'review passed',
        },
        acceptanceCriteria: {
          status: 'passed',
          message: 'acceptance criteria passed',
        },
      },
      result: {
        kind: 'completed',
        completion: 'commit',
        mergeCondition: 'none',
        staticChecks: [
          {
            command: 'pnpm gatecheck check',
            code: 0,
            stdout: '',
            stderr: '',
          },
        ],
        agentChecks: [
          {
            kind: 'review',
            reused: false,
            outcome: {
              result: 'accept',
              message: 'review passed',
            },
          },
          {
            kind: 'acceptance-criteria',
            reused: false,
            outcome: {
              result: 'accept',
              message: 'acceptance criteria passed',
            },
          },
        ],
        completionChecks: [
          {
            command: 'git diff --quiet --exit-code',
            code: 0,
            stdout: '',
            stderr: '',
          },
          {
            command: 'git diff --cached --quiet --exit-code',
            code: 0,
            stdout: '',
            stderr: '',
          },
          {
            command: 'test -z "$(git ls-files --others --exclude-standard)"',
            code: 0,
            stdout: '',
            stderr: '',
          },
        ],
      },
    });
  });

  test('review rejection stops before acceptance criteria and completion checks', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 0,
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'reject',
        reason: 'missing regression coverage',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
    );

    expect(sequence).toEqual(['command:pnpm gatecheck check', 'agent:review']);
    expect(outcome).toEqual({
      state: createRalphLoopState(),
      result: {
        kind: 'continue',
        reason: 'review-rejected',
        completion: 'commit',
        mergeCondition: 'none',
        staticChecks: [
          {
            command: 'pnpm gatecheck check',
            code: 0,
            stdout: '',
            stderr: '',
          },
        ],
        agentChecks: [
          {
            kind: 'review',
            reused: false,
            outcome: {
              result: 'reject',
              reason: 'missing regression coverage',
            },
          },
        ],
        completionChecks: [],
      },
    });
  });

  test('acceptance criteria rejection preserves a passed review for later retries', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'accept',
        message: 'review passed',
      },
      {
        result: 'reject',
        reason: 'acceptance criterion 2 is not met',
      },
      {
        result: 'accept',
        message: 'acceptance criteria passed',
      },
    ]);

    const firstAttempt = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'only-edit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'criterion 1 and criterion 2 pass',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
    );

    const secondAttempt = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'only-edit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'criterion 1 and criterion 2 pass',
      },
      firstAttempt.state,
      commands.execute,
      agent.execute,
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'agent:review',
      'agent:acceptance-criteria',
      'command:pnpm gatecheck check',
      'agent:acceptance-criteria',
    ]);
    expect(secondAttempt).toEqual({
      state: {
        review: {
          status: 'passed',
          message: 'review passed',
        },
        acceptanceCriteria: {
          status: 'passed',
          message: 'acceptance criteria passed',
        },
      },
      result: {
        kind: 'completed',
        completion: 'only-edit',
        mergeCondition: 'none',
        staticChecks: [
          {
            command: 'pnpm gatecheck check',
            code: 0,
            stdout: '',
            stderr: '',
          },
        ],
        agentChecks: [
          {
            kind: 'review',
            reused: true,
            outcome: {
              result: 'accept',
              message: 'review passed',
            },
          },
          {
            kind: 'acceptance-criteria',
            reused: false,
            outcome: {
              result: 'accept',
              message: 'acceptance criteria passed',
            },
          },
        ],
        completionChecks: [],
      },
    });
  });

  test('runs PR automation after commit checks and verifies the ready PR state', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    const agent = createAgentExecutor(sequence, []);
    const automation = createCompletionAutomationExecutor(sequence, [
      {
        result: 'accept',
        message: 'Created PR https://github.com/example/repo/pull/123',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'pr',
        mergeCondition: 'none',
        review: false,
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
      undefined,
      {
        executeCompletionAutomation: automation.execute,
        pullRequestTemplate: {
          path: '/repo/.github/pull_request_template.md',
          content: '## Summary',
        },
      },
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
      'automation:pr',
      `command:${PR_VERIFY_URL_COMMAND}`,
      `command:${PR_VERIFY_READY_COMMAND}`,
    ]);
    expect(automation.calls).toEqual([
      {
        kind: 'pull-request',
        mode: 'pr',
        pullRequestTemplate: {
          path: '/repo/.github/pull_request_template.md',
          content: '## Summary',
        },
      },
    ]);
    expect(outcome.result).toEqual({
      kind: 'completed',
      completion: 'pr',
      mergeCondition: 'none',
      staticChecks: [
        {
          command: 'pnpm gatecheck check',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      agentChecks: [],
      completionChecks: [
        {
          command: 'git diff --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'git diff --cached --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'test -z "$(git ls-files --others --exclude-standard)"',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: PR_VERIFY_URL_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: PR_VERIFY_READY_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      completionAutomation: [
        {
          kind: 'pull-request',
          mode: 'pr',
          outcome: {
            result: 'accept',
            message: 'Created PR https://github.com/example/repo/pull/123',
          },
        },
      ],
    });
  });

  test('returns continue when PR automation rejects after commit checks', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    const agent = createAgentExecutor(sequence, []);
    const automation = createCompletionAutomationExecutor(sequence, [
      {
        result: 'reject',
        reason: 'current branch is main',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'draft-pr',
        mergeCondition: 'none',
        review: false,
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
      undefined,
      {
        executeCompletionAutomation: automation.execute,
      },
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
      'automation:draft-pr',
    ]);
    expect(outcome.result).toEqual({
      kind: 'continue',
      reason: 'completion-automation-failed',
      completion: 'draft-pr',
      mergeCondition: 'none',
      staticChecks: [
        {
          command: 'pnpm gatecheck check',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      agentChecks: [],
      completionChecks: [
        {
          command: 'git diff --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'git diff --cached --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'test -z "$(git ls-files --others --exclude-standard)"',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      completionAutomation: [
        {
          kind: 'pull-request',
          mode: 'draft-pr',
          outcome: {
            result: 'reject',
            reason: 'current branch is main',
          },
        },
      ],
    });
  });

  test('waits for CI and merges automatically after PR automation passes', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    const agent = createAgentExecutor(sequence, []);
    const automation = createCompletionAutomationExecutor(sequence, [
      {
        result: 'accept',
        message: 'Created PR https://github.com/example/repo/pull/123',
      },
    ]);

    await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'pr',
        mergeCondition: 'ci-passed',
        review: false,
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
      {
        onCompletionAutomationStarted: () => {
          sequence.push('phase:completion-automation');
        },
        onMergeConditionStarted: () => {
          sequence.push('phase:merge-condition');
        },
      },
      {
        executeCompletionAutomation: automation.execute,
      },
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
      'phase:completion-automation',
      'automation:pr',
      `command:${PR_VERIFY_URL_COMMAND}`,
      `command:${PR_VERIFY_READY_COMMAND}`,
      'phase:merge-condition',
      `command:${CI_WATCH_COMMAND}`,
      `command:${CI_LIST_FAILED_COMMAND}`,
      `command:${CI_ASSERT_NONE_FAILED_COMMAND}`,
      `command:${CI_MERGE_COMMAND}`,
    ]);
  });

  test('returns continue when CI fails after PR automation succeeds', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: 'build (FAIL) https://github.com/example/repo/actions/runs/1' },
      { code: 1 },
    ]);
    const agent = createAgentExecutor(sequence, []);
    const automation = createCompletionAutomationExecutor(sequence, [
      {
        result: 'accept',
        message: 'Created PR https://github.com/example/repo/pull/123',
      },
    ]);

    const outcome = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'pr',
        mergeCondition: 'ci-passed',
        review: false,
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
      undefined,
      {
        executeCompletionAutomation: automation.execute,
      },
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
      'automation:pr',
      `command:${PR_VERIFY_URL_COMMAND}`,
      `command:${PR_VERIFY_READY_COMMAND}`,
      `command:${CI_WATCH_COMMAND}`,
      `command:${CI_LIST_FAILED_COMMAND}`,
      `command:${CI_ASSERT_NONE_FAILED_COMMAND}`,
    ]);
    expect(outcome.result).toEqual({
      kind: 'continue',
      reason: 'merge-condition-failed',
      completion: 'pr',
      mergeCondition: 'ci-passed',
      staticChecks: [
        {
          command: 'pnpm gatecheck check',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      agentChecks: [],
      completionChecks: [
        {
          command: 'git diff --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'git diff --cached --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'test -z "$(git ls-files --others --exclude-standard)"',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: PR_VERIFY_URL_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: PR_VERIFY_READY_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      completionAutomation: [
        {
          kind: 'pull-request',
          mode: 'pr',
          outcome: {
            result: 'accept',
            message: 'Created PR https://github.com/example/repo/pull/123',
          },
        },
      ],
      mergeConditionChecks: [
        {
          command: CI_WATCH_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: CI_LIST_FAILED_COMMAND,
          code: 0,
          stdout: 'build (FAIL) https://github.com/example/repo/actions/runs/1',
          stderr: '',
        },
        {
          command: CI_ASSERT_NONE_FAILED_COMMAND,
          code: 1,
          stdout: '',
          stderr: '',
        },
      ],
    });
  });

  test('passed review and acceptance criteria are reused after a completion failure', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      {
        code: 0,
      },
      {
        code: 1,
        stdout: 'worktree is dirty',
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 0,
      },
    ]);
    const agent = createAgentExecutor(sequence, [
      {
        result: 'accept',
        message: 'review passed',
      },
      {
        result: 'accept',
        message: 'acceptance criteria passed',
      },
    ]);

    const firstAttempt = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      createRalphLoopState(),
      commands.execute,
      agent.execute,
    );

    const secondAttempt = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      firstAttempt.state,
      commands.execute,
      agent.execute,
    );

    expect(sequence).toEqual([
      'command:pnpm gatecheck check',
      'agent:review',
      'agent:acceptance-criteria',
      'command:git diff --quiet --exit-code',
      'command:pnpm gatecheck check',
      'command:git diff --quiet --exit-code',
      'command:git diff --cached --quiet --exit-code',
      'command:test -z "$(git ls-files --others --exclude-standard)"',
    ]);
    expect(secondAttempt.result).toEqual({
      kind: 'completed',
      completion: 'commit',
      mergeCondition: 'none',
      staticChecks: [
        {
          command: 'pnpm gatecheck check',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      agentChecks: [
        {
          kind: 'review',
          reused: true,
          outcome: {
            result: 'accept',
            message: 'review passed',
          },
        },
        {
          kind: 'acceptance-criteria',
          reused: true,
          outcome: {
            result: 'accept',
            message: 'acceptance criteria passed',
          },
        },
      ],
      completionChecks: [
        {
          command: 'git diff --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'git diff --cached --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'test -z "$(git ls-files --others --exclude-standard)"',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
    });
  });
});
