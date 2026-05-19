import { describe, expect, test } from 'vitest';

import {
  extractCompletionAutomationDecision,
  runCompletionAutomation,
} from './completionAutomationRunner.service.ts';

describe('extractCompletionAutomationDecision', () => {
  test('returns the accepted decision from a completion-automation tool result', () => {
    const stdout = JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'completion-automation',
      result: {
        details: {
          result: 'accept',
          message: 'Created PR https://github.com/example/repo/pull/123',
        },
      },
    });

    expect(extractCompletionAutomationDecision(stdout)).toEqual({
      result: 'accept',
      message: 'Created PR https://github.com/example/repo/pull/123',
    });
  });

  test('ignores events for different tools', () => {
    const stdout = JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'review',
      result: {
        details: {
          result: 'accept',
          message: 'wrong tool',
        },
      },
    });

    expect(extractCompletionAutomationDecision(stdout)).toBeUndefined();
  });
});

describe('runCompletionAutomation', () => {
  test('retries with --continue when the child agent omits the completion tool once', async () => {
    const calls: string[][] = [];
    let attempt = 0;

    const decision = await runCompletionAutomation(
      (_command, args) => {
        calls.push(args);
        attempt += 1;

        if (attempt === 1) {
          return Promise.resolve({
            code: 0,
            killed: false,
            stdout: JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
            stderr: '',
          });
        }

        return Promise.resolve({
          code: 0,
          killed: false,
          stdout: JSON.stringify({
            type: 'tool_execution_end',
            toolName: 'completion-automation',
            result: {
              details: {
                result: 'accept',
                message: 'Created PR https://github.com/example/repo/pull/123',
              },
            },
          }),
          stderr: '',
        });
      },
      process.cwd(),
      undefined,
      {
        kind: 'pull-request',
        mode: 'draft-pr',
        pullRequestTemplate: {
          path: '/repo/.github/pull_request_template.md',
          content: '## Summary',
        },
      },
      {
        maxContinuationAttempts: 2,
      },
    );

    expect(decision).toEqual({
      result: 'accept',
      message: 'Created PR https://github.com/example/repo/pull/123',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('--continue');
    expect(calls[1]).toContain('--continue');
  });
});
