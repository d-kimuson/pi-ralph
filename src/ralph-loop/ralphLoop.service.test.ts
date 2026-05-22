import { describe, expect, test } from 'vitest';

import { createRalphLoopState, runRalphLoop } from './ralphLoop.service.ts';

const PR_VERIFY_URL_COMMAND = 'gh pr view --json url --jq .url';
const PR_VERIFY_READY_COMMAND = 'test "$(gh pr view --json isDraft --jq .isDraft)" = "false"';
const CI_WATCH_COMMAND = 'gh pr checks --watch --fail-fast || true';
const CI_ASSERT_HAS_CHECKS_COMMAND =
  'checks="$(gh pr checks --json name --jq \'.[0].name // empty\')"; test -n "$checks" || { echo "no CI checks reported on this PR"; exit 1; }';
const CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND =
  'blocking="$(gh pr checks --json name,bucket,state,link --jq \'.[] | select(.bucket == "fail" or .bucket == "pending" or .bucket == "cancel") | "\\(.name) [\\(.bucket)] \\(.link // "")"\')"; test -z "$blocking" || { printf "%s\\n" "$blocking"; exit 1; }';
const CI_MERGE_COMMAND = 'gh pr merge --delete-branch --merge';
const APPROVAL_WATCH_COMMAND =
  'while true; do decision="$(gh pr view --json reviewDecision --jq .reviewDecision)"; test "$decision" = "APPROVED" && exit 0; echo "waiting for PR approval: reviewDecision=$decision"; sleep 30; done';
const COMMENT_FIXED_INSPECT_COMMAND = 'comment-fixed: inspect unresolved comments';

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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
    ]);
  });

  test('review and acceptance criteria run before edit-only completion', async () => {
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        completionChecks: [],
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        completion: 'edit-only',
        autofix: 'none',
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
        autofix: 'none',
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
      autofix: 'none',
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
        autofix: 'none',
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
      autofix: 'none',
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
        autofix: 'ci',
        mergeCondition: 'fix-completed',
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
      `command:${CI_WATCH_COMMAND}`,
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
      'phase:merge-condition',
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
      { code: 0 },
      { code: 1, stdout: 'build [fail] https://github.com/example/repo/actions/runs/1' },
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
        autofix: 'ci',
        mergeCondition: 'fix-completed',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
    ]);
    expect(outcome.result).toEqual({
      kind: 'continue',
      reason: 'merge-condition-failed',
      completion: 'pr',
      autofix: 'ci',
      mergeCondition: 'fix-completed',
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
          command: CI_ASSERT_HAS_CHECKS_COMMAND,
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND,
          code: 1,
          stdout: 'build [fail] https://github.com/example/repo/actions/runs/1',
          stderr: '',
        },
      ],
    });
  });

  test('returns continue when CI is still pending after the watch step', async () => {
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
      { code: 1, stdout: 'build [pending] https://github.com/example/repo/actions/runs/2' },
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
        autofix: 'ci',
        mergeCondition: 'fix-completed',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
    ]);
    expect(outcome.result.kind).toBe('continue');
    if (outcome.result.kind !== 'continue') {
      throw new Error('expected continue');
    }
    expect(outcome.result.reason).toBe('merge-condition-failed');
  });

  test('returns continue when comment-fixed finds unresolved comments after CI passes', async () => {
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
      { code: 0, stdout: '{"nameWithOwner":"example/repo"}' },
      { code: 0, stdout: '{"number":123,"author":{"login":"author"}}' },
      { code: 0, stdout: 'abcdef1234567890\n' },
      {
        code: 0,
        stdout:
          '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[{"comments":{"nodes":[{"databaseId":10,"url":"https://github.com/example/repo/pull/123#discussion_r10","body":"Please rename this helper.","createdAt":"2026-05-20T10:00:00Z","author":{"login":"reviewer-a"}}]}}]}}}}}',
      },
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
        autofix: 'comment',
        mergeCondition: 'fix-completed',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
      'command:gh repo view --json nameWithOwner',
      'command:gh pr view --json number,author',
      'command:git rev-parse HEAD',
      "command:gh api graphql -F owner=example -F name=repo -F number=123 -f query=$'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } reviews(first: 100) { nodes { url body submittedAt author { login } } } reviewThreads(first: 100) { nodes { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } } } } } }'",
    ]);
    expect(outcome.result.kind).toBe('continue');
    if (outcome.result.kind !== 'continue') {
      throw new Error('expected continue');
    }
    expect(outcome.result.reason).toBe('merge-condition-failed');
    expect(outcome.result.mergeConditionDetails).toEqual({
      kind: 'comment-fixed',
      headSha: 'abcdef1234567890',
      pendingComments: [
        {
          kind: 'review-thread',
          authorLogin: 'reviewer-a',
          url: 'https://github.com/example/repo/pull/123#discussion_r10',
          body: 'Please rename this helper.',
          replyCommand:
            "gh api repos/example/repo/pulls/123/comments/10/replies -X POST -f body=$'Fixed in commit abcdef1234567890.\\n\\n<describe-the-fix>'",
        },
      ],
    });
    expect(outcome.result.mergeConditionChecks?.at(-1)).toEqual({
      command: COMMENT_FIXED_INSPECT_COMMAND,
      code: 1,
      stdout:
        '1 pending PR comment thread(s) still need a reply before merge. Latest commit: abcdef1234567890.',
      stderr: '',
    });
  });

  test('merges after comment-fixed finds no unresolved comments', async () => {
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
      { code: 0, stdout: '{"nameWithOwner":"example/repo"}' },
      { code: 0, stdout: '{"number":123,"author":{"login":"author"}}' },
      { code: 0, stdout: 'abcdef1234567890\n' },
      {
        code: 0,
        stdout:
          '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[{"comments":{"nodes":[{"databaseId":10,"url":"https://github.com/example/repo/pull/123#discussion_r10","body":"Please add a test.","createdAt":"2026-05-20T10:00:00Z","author":{"login":"reviewer-a"}},{"databaseId":11,"url":"https://github.com/example/repo/pull/123#discussion_r11","body":"Added in the latest commit.","createdAt":"2026-05-20T10:05:00Z","author":{"login":"author"}}]}}]}}}}}',
      },
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
        autofix: 'comment',
        mergeCondition: 'fix-completed',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
      'command:gh repo view --json nameWithOwner',
      'command:gh pr view --json number,author',
      'command:git rev-parse HEAD',
      "command:gh api graphql -F owner=example -F name=repo -F number=123 -f query=$'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } reviews(first: 100) { nodes { url body submittedAt author { login } } } reviewThreads(first: 100) { nodes { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } } } } } }'",
      `command:${CI_MERGE_COMMAND}`,
    ]);
    expect(outcome.result.kind).toBe('completed');
  });

  test('approved merge condition waits for approval before merging', async () => {
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
        autofix: 'ci',
        mergeCondition: 'approved',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
      `command:${CI_ASSERT_NO_BLOCKING_CHECKS_COMMAND}`,
      `command:${APPROVAL_WATCH_COMMAND}`,
      `command:${CI_MERGE_COMMAND}`,
    ]);
    expect(outcome.result.kind).toBe('completed');
  });

  test('returns continue when no CI checks are reported', async () => {
    const sequence: string[] = [];
    const commands = createCommandExecutor(sequence, [
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 1, stdout: 'no CI checks reported on this PR' },
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
        autofix: 'ci',
        mergeCondition: 'fix-completed',
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
      `command:${CI_ASSERT_HAS_CHECKS_COMMAND}`,
    ]);
    expect(outcome.result.kind).toBe('continue');
    if (outcome.result.kind !== 'continue') {
      throw new Error('expected continue');
    }
    expect(outcome.result.reason).toBe('merge-condition-failed');
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
    const automation = createCompletionAutomationExecutor(sequence, [
      {
        result: 'accept',
        message: 'Created PR https://github.com/example/repo/pull/123',
      },
    ]);

    const firstAttempt = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'pr',
        autofix: 'none',
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
        completion: 'pr',
        autofix: 'none',
        mergeCondition: 'none',
        review: true,
        acceptanceCriteria: 'all requirements are met',
      },
      firstAttempt.state,
      commands.execute,
      agent.execute,
      undefined,
      {
        executeCompletionAutomation: automation.execute,
      },
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
      'automation:pr',
      `command:${PR_VERIFY_URL_COMMAND}`,
      `command:${PR_VERIFY_READY_COMMAND}`,
    ]);
    expect(secondAttempt.result).toEqual({
      kind: 'completed',
      completion: 'pr',
      autofix: 'none',
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
});
