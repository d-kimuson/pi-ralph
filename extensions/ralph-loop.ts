import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  runRalphLoop,
  type RalphLoopCommandResult,
  type RalphLoopResult,
} from '../src/ralph-loop/ralphLoop.service.ts';

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

const executeShellCommand = async (
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  command: string,
): Promise<RalphLoopCommandResult> => {
  const result = await pi.exec('bash', ['-lc', command], {
    cwd,
    signal,
    timeout: TOOL_TIMEOUT_MS,
  });

  return {
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const lastCommand = (
  results: readonly RalphLoopCommandResult[],
): RalphLoopCommandResult | undefined => results.at(-1);

const summarizeResult = (result: RalphLoopResult): string => {
  switch (result.kind) {
    case 'completed': {
      return 'ralph-loop completed: all static checks and completion checks passed.';
    }
    case 'continue': {
      if (result.reason === 'static-check-failed') {
        const failedCheck = lastCommand(result.staticChecks);

        return failedCheck === undefined
          ? 'ralph-loop requires more work: a static check failed.'
          : `ralph-loop requires more work: static check failed (${failedCheck.command}).`;
      }

      if (result.reason === 'completion-check-failed') {
        const failedCheck = lastCommand(result.completionChecks);

        return failedCheck === undefined
          ? 'ralph-loop requires more work: a completion check failed.'
          : `ralph-loop requires more work: completion check failed (${failedCheck.command}).`;
      }

      return assertNever(result);
    }
    default: {
      return assertNever(result);
    }
  }
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

const createRalphLoopTool = (pi: ExtensionAPI) =>
  defineTool({
    name: 'ralph-loop',
    label: 'Ralph Loop',
    description:
      "Set the task's completion conditions before focused work starts. When finishing, ralph-loop checks the configured static checks and completion policy, and work is not done until they pass.",
    promptSnippet:
      'Set ralph-loop at task start to define done criteria; the task is not complete until its checks pass.',
    promptGuidelines: [
      'At the start of a task, set ralph-loop with the static checks and completion policy that define done.',
      'When finishing the task, run the configured ralph-loop checks to verify the done criteria.',
      'If ralph-loop returns kind=continue, keep working and run it again until it returns kind=completed.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      staticChecks: Type.Array(
        Type.String({
          description: 'Shell command that must pass for the task to count as complete.',
        }),
        {
          description: "Static checks that define the task's done criteria.",
        },
      ),
      completion: Type.Union([Type.Literal('only-edit'), Type.Literal('commit')], {
        description: 'Completion policy that must hold after the static checks pass.',
      }),
      mergeCondition: Type.Literal('none', {
        description: 'Reserved for future merge gating. Only none is currently supported.',
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runRalphLoop(params, async (command) =>
        executeShellCommand(pi, ctx.cwd, signal, command),
      );

      return {
        content: [{ type: 'text', text: summarizeResult(result) }],
        details: result,
        terminate: result.kind === 'completed',
      };
    },
  });

export default function (pi: ExtensionAPI) {
  pi.registerTool(createRalphLoopTool(pi));
}
