import { describe, expect, test } from 'vitest';

import { extractReviewDecision, runAgentCheck } from './agentCheckRunner.service.ts';

describe('extractReviewDecision', () => {
  test('returns the accepted decision from a review tool result', () => {
    const stdout = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'review',
        result: {
          details: {
            result: 'accept',
            message: 'looks good',
          },
        },
      }),
    ].join('\n');

    expect(extractReviewDecision(stdout)).toEqual({
      result: 'accept',
      message: 'looks good',
    });
  });

  test('returns the rejected decision from a review tool result', () => {
    const stdout = JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'review',
      result: {
        details: {
          result: 'reject',
          reason: 'criterion 2 failed',
        },
      },
    });

    expect(extractReviewDecision(stdout)).toEqual({
      result: 'reject',
      reason: 'criterion 2 failed',
    });
  });

  test('returns the decision from a toolResult message as a fallback', () => {
    const stdout = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolName: 'review',
        details: {
          result: 'accept',
          message: 'fallback worked',
        },
      },
    });

    expect(extractReviewDecision(stdout)).toEqual({
      result: 'accept',
      message: 'fallback worked',
    });
  });

  test('ignores malformed lines and non-review tool events', () => {
    const stdout = [
      'not json',
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'bash',
        result: {
          details: {
            result: 'accept',
            message: 'wrong tool',
          },
        },
      }),
    ].join('\n');

    expect(extractReviewDecision(stdout)).toBeUndefined();
  });
});

describe('runAgentCheck', () => {
  test('retries with --continue when the child agent omits the review tool once', async () => {
    const calls: string[][] = [];
    let attempt = 0;

    const decision = await runAgentCheck(
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
            toolName: 'review',
            result: {
              details: {
                result: 'accept',
                message: 'looks good',
              },
            },
          }),
          stderr: '',
        });
      },
      process.cwd(),
      undefined,
      { kind: 'review' },
      {
        maxContinuationAttempts: 2,
      },
    );

    expect(decision).toEqual({
      result: 'accept',
      message: 'looks good',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('--continue');
    expect(calls[1]).toContain('--continue');
  });

  test('fails after too many missing review-tool completions', async () => {
    await expect(
      runAgentCheck(
        () =>
          Promise.resolve({
            code: 0,
            killed: false,
            stdout: JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
            stderr: '',
          }),
        process.cwd(),
        undefined,
        { kind: 'review' },
        {
          maxContinuationAttempts: 2,
        },
      ),
    ).rejects.toThrow(
      'set-ralph-loop review agent finished without calling the required review tool after 2 retries.',
    );
  });
});
