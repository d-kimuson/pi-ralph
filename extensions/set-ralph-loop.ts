import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  advanceActiveRalphLoop,
  createActiveRalphLoop,
  updateActiveRalphLoop,
  type ActiveRalphLoop,
} from '../src/ralph-loop/activeLoop.service.ts';
import {
  runAgentCheck,
  type RunAgentCheckOptions,
} from '../src/ralph-loop/agentCheckRunner.service.ts';
import {
  runCompletionAutomation,
  type RunCompletionAutomationOptions,
} from '../src/ralph-loop/completionAutomationRunner.service.ts';
import { loadPullRequestTemplate } from '../src/ralph-loop/pullRequestTemplate.service.ts';
import {
  runRalphLoop,
  type RalphLoopCommandResult,
  type RalphLoopOutcome,
  type RalphLoopParams,
} from '../src/ralph-loop/ralphLoop.service.ts';
import {
  buildConfigurationGuidance,
  isPullRequestCompletion,
  requiresGitHubCli,
  validateRalphLoopParams,
} from '../src/ralph-loop/ralphLoopConfig.service.ts';

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const activeLoopsBySession = new Map<string, ActiveRalphLoop>();
const runningChecks = new Set<string>();

const normalizeParams = (
  params: Omit<RalphLoopParams, 'review'> & { readonly review?: boolean },
): RalphLoopParams => {
  const acceptanceCriteria = params.acceptanceCriteria?.trim();

  return {
    ...params,
    review: params.review ?? false,
    acceptanceCriteria: acceptanceCriteria === '' ? undefined : acceptanceCriteria,
  };
};

const createSessionKey = (cwd: string, sessionId: string): string =>
  JSON.stringify({
    cwd,
    sessionId,
  });

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
  results: readonly RalphLoopCommandResult[] | undefined,
): RalphLoopCommandResult | undefined => results?.at(-1);

const lastMeaningfulOutput = (
  results: readonly RalphLoopCommandResult[] | undefined,
): string | undefined =>
  results
    ?.toReversed()
    .flatMap((result) => [result.stderr.trim(), result.stdout.trim()])
    .find((value) => value !== '');

const notifyProgress = (message: string, ctx: ExtensionContext): void => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, 'info');
  }
};

const emitProgressLog = (pi: ExtensionAPI, content: string): void => {
  pi.sendMessage(
    {
      customType: 'set-ralph-loop-progress',
      content,
      display: true,
    },
    { triggerTurn: false },
  );
};

const summarizeResult = (outcome: RalphLoopOutcome): string => {
  const result = outcome.result;

  switch (result.kind) {
    case 'completed': {
      return 'set-ralph-loop completed: all configured static checks, agent checks, completion automation, and merge conditions passed.';
    }
    case 'continue': {
      if (result.reason === 'static-check-failed') {
        const failedCheck = lastCommand(result.staticChecks);

        return failedCheck === undefined
          ? 'set-ralph-loop requires more work: a static check failed.'
          : `set-ralph-loop requires more work: static check failed (${failedCheck.command}).`;
      }

      if (result.reason === 'completion-check-failed') {
        const failedCheck = lastCommand(result.completionChecks);

        return failedCheck === undefined
          ? 'set-ralph-loop requires more work: a completion check failed.'
          : `set-ralph-loop requires more work: completion check failed (${failedCheck.command}).`;
      }

      if (result.reason === 'completion-automation-failed') {
        const failedAutomation = result.completionAutomation?.at(-1);

        if (failedAutomation?.outcome.result === 'reject') {
          return `set-ralph-loop requires more work: ${failedAutomation.mode} automation failed (${failedAutomation.outcome.reason}).`;
        }

        return 'set-ralph-loop requires more work: a completion automation step failed.';
      }

      if (result.reason === 'merge-condition-failed') {
        const details = lastMeaningfulOutput(result.mergeConditionChecks);

        return details === undefined
          ? 'set-ralph-loop requires more work: a merge condition failed.'
          : `set-ralph-loop requires more work: merge condition failed (${details}).`;
      }

      const failedAgentCheck = result.agentChecks.at(-1);

      if (failedAgentCheck === undefined) {
        return 'set-ralph-loop requires more work: an agent check failed.';
      }

      if (failedAgentCheck.outcome.result === 'reject') {
        return `set-ralph-loop requires more work: ${failedAgentCheck.kind} rejected (${failedAgentCheck.outcome.reason}).`;
      }

      return `set-ralph-loop requires more work: ${failedAgentCheck.kind} did not pass.`;
    }
    default: {
      return assertNever(result);
    }
  }
};

const createFollowUpContent = (outcome: RalphLoopOutcome): string =>
  [
    '[set-ralph-loop]',
    summarizeResult(outcome),
    'Continue working on the task until the configured checks pass.',
    'Do not call set-ralph-loop again; it is already configured for this session and directory.',
  ].join('\n\n');

const createAgentCheckOptions = (ctx: ExtensionContext): RunAgentCheckOptions => ({
  onMissingReviewToolCall: (attempt, maxContinuationAttempts, request) => {
    notifyProgress(
      `set-ralph-loop: ${request.kind} finished without review; retrying (${attempt}/${maxContinuationAttempts})...`,
      ctx,
    );
  },
});

const createCompletionAutomationOptions = (
  ctx: ExtensionContext,
): RunCompletionAutomationOptions => ({
  onMissingCompletionAutomationToolCall: (attempt, maxContinuationAttempts) => {
    notifyProgress(
      `set-ralph-loop: completion automation finished without a report; retrying (${attempt}/${maxContinuationAttempts})...`,
      ctx,
    );
  },
});

const ensureGitHubCliAvailable = async (
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const result = await pi.exec('bash', ['-lc', 'command -v gh >/dev/null 2>&1'], {
    cwd,
    signal,
    timeout: TOOL_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    throw new Error('GitHub CLI (gh) is required for the configured PR or merge automation.');
  }
};

const runConfiguredLoop = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionKey: string,
): Promise<void> => {
  const activeLoop = activeLoopsBySession.get(sessionKey);

  if (activeLoop === undefined || runningChecks.has(sessionKey)) {
    return;
  }

  const advanced = advanceActiveRalphLoop(activeLoop);

  runningChecks.add(sessionKey);

  try {
    notifyProgress('set-ralph-loop: running static checks...', ctx);

    const pullRequestTemplate = isPullRequestCompletion(advanced.params.completion)
      ? await loadPullRequestTemplate(pi.exec.bind(pi), ctx.cwd, ctx.signal)
      : undefined;

    const outcome = await runRalphLoop(
      advanced.params,
      advanced.state,
      async (command) => executeShellCommand(pi, ctx.cwd, ctx.signal, command),
      async (request) =>
        runAgentCheck(pi.exec.bind(pi), ctx.cwd, ctx.signal, request, createAgentCheckOptions(ctx)),
      {
        onStaticChecksPassed: () => {
          notifyProgress('set-ralph-loop: static checks passed.', ctx);
          emitProgressLog(pi, '[set-ralph-loop]\n\nStatic checks passed.');
        },
        onReviewStarted: (reused) => {
          notifyProgress(
            reused
              ? 'set-ralph-loop: static checks passed. reusing the passed review result.'
              : 'set-ralph-loop: static checks passed. running review...',
            ctx,
          );
        },
        onAcceptanceCriteriaStarted: (reused) => {
          notifyProgress(
            reused
              ? 'set-ralph-loop: static checks passed. reusing the passed acceptance-criteria result.'
              : 'set-ralph-loop: static checks passed. checking acceptance criteria...',
            ctx,
          );
        },
        onCompletionChecksStarted: () => {
          notifyProgress(
            'set-ralph-loop: static checks passed. checking completion conditions...',
            ctx,
          );
        },
        onCompletionAutomationStarted: (mode) => {
          notifyProgress(
            mode === 'pr'
              ? 'set-ralph-loop: commit checks passed. creating or updating the ready PR...'
              : 'set-ralph-loop: commit checks passed. creating or updating the draft PR...',
            ctx,
          );
        },
        onMergeConditionStarted: () => {
          notifyProgress(
            'set-ralph-loop: PR automation passed. waiting for CI and merging automatically when possible...',
            ctx,
          );
        },
      },
      {
        executeCompletionAutomation: (request) =>
          runCompletionAutomation(
            pi.exec.bind(pi),
            ctx.cwd,
            ctx.signal,
            {
              ...request,
              pullRequestTemplate,
            },
            createCompletionAutomationOptions(ctx),
          ),
        pullRequestTemplate,
      },
    );

    const nextActiveLoop = updateActiveRalphLoop(advanced, outcome);

    if (nextActiveLoop === undefined) {
      activeLoopsBySession.delete(sessionKey);
      notifyProgress('set-ralph-loop: all configured checks passed.', ctx);
      pi.sendMessage(
        {
          customType: 'set-ralph-loop-complete',
          content: summarizeResult(outcome),
          display: true,
          details: outcome,
        },
        { triggerTurn: false },
      );
      return;
    }

    activeLoopsBySession.set(sessionKey, nextActiveLoop);
    pi.sendMessage(
      {
        customType: 'set-ralph-loop-feedback',
        content: createFollowUpContent(outcome),
        display: true,
        details: outcome,
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    notifyProgress(`set-ralph-loop: automatic checking stopped (${message}).`, ctx);
    pi.sendMessage(
      {
        customType: 'set-ralph-loop-error',
        content: [
          '[set-ralph-loop]',
          `Automatic checking stopped: ${message}`,
          'Fix the broken check path, or use bypass-ralph-loop only when the checks themselves are broken or impossible to run.',
        ].join('\n\n'),
        display: true,
        details: {
          error: message,
        },
      },
      { triggerTurn: false },
    );
  } finally {
    runningChecks.delete(sessionKey);
  }
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

const createConfigurationResponseText = (params: RalphLoopParams): string => {
  const guidance = buildConfigurationGuidance(params);

  return [
    'set-ralph-loop configured. Work on the task normally; the configured checks will run automatically when the task tries to finish.',
    'From this point on, ralph-loop enters its self-evaluation loop. Do not expect normal back-and-forth with the user; proceed autonomously and make the remaining implementation decisions yourself unless the goal itself becomes unclear or needs to change.',
    ...guidance,
  ].join('\n\n');
};

const createSetRalphLoopTool = (pi: ExtensionAPI) =>
  defineTool({
    name: 'set-ralph-loop',
    label: 'Set Ralph Loop',
    description:
      "Set the task's completion conditions before focused work starts. After that, set-ralph-loop automatically runs the configured static checks, optional agent checks, completion automation, and merge policy whenever the task tries to finish, and it keeps the task open until they pass.",
    promptSnippet:
      'Call set-ralph-loop once at task start to configure done criteria; after that the checks run automatically until they pass.',
    promptGuidelines: [
      'At the start of a task, call set-ralph-loop once with the static checks and completion policy that define done.',
      'Do not call set-ralph-loop again after it has been configured for the current session and directory.',
      'After configuration, keep working normally; set-ralph-loop will automatically run the configured checks whenever the task tries to finish.',
      'After configuration, assume ralph-loop will take over the endgame as a self-evaluation loop; proceed autonomously instead of expecting further user back-and-forth.',
      'Configuring set-ralph-loop does not complete the task and does not ask you to call it again later.',
      'If set-ralph-loop reports a failure, continue working on the task instead of trying to configure it again.',
      'When completion is pr or draft-pr, commit your changes yourself and create the working branch yourself; set-ralph-loop will handle the PR automation later.',
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
      completion: Type.Union(
        [
          Type.Literal('only-edit'),
          Type.Literal('commit'),
          Type.Literal('pr'),
          Type.Literal('draft-pr'),
        ],
        {
          description:
            'Completion policy that must hold after the static checks pass. pr and draft-pr also trigger pull-request automation after commit cleanliness checks pass.',
        },
      ),
      mergeCondition: Type.Union([Type.Literal('none'), Type.Literal('ci-passed')], {
        description:
          'Optional merge policy. ci-passed waits for GitHub CI on the PR and automatically merges when no failed checks remain.',
      }),
      review: Type.Optional(
        Type.Boolean({
          description: 'Whether an agent-based review check is required before completion.',
        }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.String({
          description:
            'Optional acceptance criteria checked by an agent after static checks and review pass.',
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const normalizedParams = normalizeParams(params);
      const validation = validateRalphLoopParams(normalizedParams);

      if (validation.kind === 'invalid') {
        throw new Error(validation.message);
      }

      if (requiresGitHubCli(normalizedParams)) {
        await ensureGitHubCliAvailable(pi, ctx.cwd, ctx.signal);
      }

      const sessionKey = createSessionKey(ctx.cwd, ctx.sessionManager.getSessionId());
      const configured = createActiveRalphLoop(
        activeLoopsBySession.get(sessionKey),
        normalizedParams,
      );

      if (configured.kind === 'blocked') {
        return {
          content: [
            {
              type: 'text',
              text: 'set-ralph-loop is already configured for this session and directory.',
            },
          ],
          details: configured,
        };
      }

      activeLoopsBySession.set(sessionKey, configured.activeLoop);
      notifyProgress(
        'set-ralph-loop configured. The completion checks will run automatically when the task next tries to finish.',
        ctx,
      );

      return {
        content: [
          {
            type: 'text',
            text: createConfigurationResponseText(normalizedParams),
          },
        ],
        details: configured,
      };
    },
  });

const createBypassRalphLoopTool = () =>
  defineTool({
    name: 'bypass-ralph-loop',
    label: 'Bypass Ralph Loop',
    description:
      'Emergency escape hatch. Do not use this normally. Use it only when set-ralph-loop cannot proceed because the configured checks themselves are broken or impossible to run in the current environment.',
    promptSnippet:
      'Only use bypass-ralph-loop as an emergency escape hatch when the configured checks themselves are broken or impossible to run.',
    promptGuidelines: [
      'Do not use bypass-ralph-loop during normal task execution.',
      'Use bypass-ralph-loop only when the configured checks themselves are broken or impossible to run.',
      'Always include a concrete reason when using bypass-ralph-loop.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      reason: Type.String({
        description: 'Concrete reason why set-ralph-loop must be bypassed.',
      }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionKey = createSessionKey(ctx.cwd, ctx.sessionManager.getSessionId());
      const activeLoop = activeLoopsBySession.get(sessionKey);

      runningChecks.delete(sessionKey);
      activeLoopsBySession.delete(sessionKey);

      if (activeLoop === undefined) {
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: 'No active set-ralph-loop configuration was found to bypass.',
            },
          ],
          details: {
            kind: 'not-configured',
            reason: params.reason,
          },
        });
      }

      notifyProgress(`bypass-ralph-loop used: ${params.reason}`, ctx);

      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: `Bypassed set-ralph-loop: ${params.reason}`,
          },
        ],
        details: {
          kind: 'bypassed',
          reason: params.reason,
        },
      });
    },
  });

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'set-ralph-loop') {
      return;
    }

    const sessionKey = createSessionKey(ctx.cwd, ctx.sessionManager.getSessionId());

    if (!activeLoopsBySession.has(sessionKey)) {
      return;
    }

    return {
      block: true,
      reason:
        'set-ralph-loop is already configured for this session and directory. Keep working and let it run automatically, or use bypass-ralph-loop only in emergencies.',
    };
  });

  pi.on('agent_end', async (_event, ctx) => {
    await runConfiguredLoop(pi, ctx, createSessionKey(ctx.cwd, ctx.sessionManager.getSessionId()));
  });

  pi.registerTool(createSetRalphLoopTool(pi));
  pi.registerTool(createBypassRalphLoopTool());
}
