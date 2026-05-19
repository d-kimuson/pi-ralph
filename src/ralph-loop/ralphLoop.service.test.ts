import { describe, expect, test } from 'vitest';

import { runRalphLoop } from './ralphLoop.service.ts';

const createExecutor = (
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

describe('runRalphLoop', () => {
  test('static check failure stops before completion checks', async () => {
    const executor = createExecutor([
      {
        code: 1,
        stderr: 'typecheck failed',
      },
    ]);

    const result = await runRalphLoop(
      {
        staticChecks: ['pnpm typecheck'],
        completion: 'only-edit',
        mergeCondition: 'none',
      },
      executor.execute,
    );

    expect(executor.commands).toEqual(['pnpm typecheck']);
    expect(result).toEqual({
      kind: 'continue',
      reason: 'static-check-failed',
      completion: 'only-edit',
      mergeCondition: 'none',
      staticChecks: [
        {
          command: 'pnpm typecheck',
          code: 1,
          stdout: '',
          stderr: 'typecheck failed',
        },
      ],
    });
  });

  test('only-edit completes when all static checks pass', async () => {
    const executor = createExecutor([
      {
        code: 0,
      },
      {
        code: 0,
      },
    ]);

    const result = await runRalphLoop(
      {
        staticChecks: ['pnpm typecheck', 'pnpm test'],
        completion: 'only-edit',
        mergeCondition: 'none',
      },
      executor.execute,
    );

    expect(executor.commands).toEqual(['pnpm typecheck', 'pnpm test']);
    expect(result).toEqual({
      kind: 'completed',
      completion: 'only-edit',
      mergeCondition: 'none',
      staticChecks: [
        {
          command: 'pnpm typecheck',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'pnpm test',
          code: 0,
          stdout: '',
          stderr: '',
        },
      ],
      completionChecks: [],
    });
  });

  test('commit completes only when worktree, index, and untracked files are clean', async () => {
    const executor = createExecutor([
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

    const result = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
      },
      executor.execute,
    );

    expect(executor.commands).toEqual([
      'pnpm gatecheck check',
      'git diff --quiet --exit-code',
      'git diff --cached --quiet --exit-code',
      'test -z "$(git ls-files --others --exclude-standard)"',
    ]);
    expect(result).toEqual({
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

  test('commit returns continue when staged diff remains', async () => {
    const executor = createExecutor([
      {
        code: 0,
      },
      {
        code: 0,
      },
      {
        code: 1,
        stdout: 'staged diff remains',
      },
    ]);

    const result = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
      },
      executor.execute,
    );

    expect(executor.commands).toEqual([
      'pnpm gatecheck check',
      'git diff --quiet --exit-code',
      'git diff --cached --quiet --exit-code',
    ]);
    expect(result).toEqual({
      kind: 'continue',
      reason: 'completion-check-failed',
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
      completionChecks: [
        {
          command: 'git diff --quiet --exit-code',
          code: 0,
          stdout: '',
          stderr: '',
        },
        {
          command: 'git diff --cached --quiet --exit-code',
          code: 1,
          stdout: 'staged diff remains',
          stderr: '',
        },
      ],
    });
  });

  test('commit returns continue when untracked files remain', async () => {
    const executor = createExecutor([
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
        code: 1,
        stdout: 'extensions/ralph-loop.ts',
      },
    ]);

    const result = await runRalphLoop(
      {
        staticChecks: ['pnpm gatecheck check'],
        completion: 'commit',
        mergeCondition: 'none',
      },
      executor.execute,
    );

    expect(executor.commands).toEqual([
      'pnpm gatecheck check',
      'git diff --quiet --exit-code',
      'git diff --cached --quiet --exit-code',
      'test -z "$(git ls-files --others --exclude-standard)"',
    ]);
    expect(result).toEqual({
      kind: 'continue',
      reason: 'completion-check-failed',
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
          code: 1,
          stdout: 'extensions/ralph-loop.ts',
          stderr: '',
        },
      ],
    });
  });
});
