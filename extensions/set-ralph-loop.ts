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
import { buildCommentFixedFollowUp } from '../src/ralph-loop/commentFixedFeedback.service.ts';
import {
  runCompletionAutomation,
  type RunCompletionAutomationOptions,
} from '../src/ralph-loop/completionAutomationRunner.service.ts';
import { executeLocalShellCommand } from '../src/ralph-loop/localShellExecutor.service.ts';
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
  cwd: string,
  signal: AbortSignal | undefined,
  command: string,
): Promise<RalphLoopCommandResult> =>
  await executeLocalShellCommand({
    cwd,
    signal,
    command,
    timeoutMs: TOOL_TIMEOUT_MS,
  });

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

// ============ Status Widget ============

type WidgetStepStatus = 'pending' | 'in-progress' | 'passed' | 'failed';

type WidgetStep = {
  readonly id: string;
  label: string;
  status: WidgetStepStatus;
  detail?: string;
  description?: string;
  readonly commands?: readonly string[];
};

const stepIcon = (status: WidgetStepStatus): { readonly icon: string; readonly color: string } => {
  switch (status) {
    case 'pending':
      return { icon: '◯', color: 'muted' };
    case 'in-progress':
      return { icon: '◎', color: 'accent' };
    case 'passed':
      return { icon: '●', color: 'success' };
    case 'failed':
      return { icon: '✕', color: 'error' };
  }
};

const themedIcon = (status: WidgetStepStatus, theme: ExtensionContext['ui']['theme']): string => {
  const { icon, color } = stepIcon(status);

  switch (color) {
    case 'muted':
      return theme.fg('muted', icon);
    case 'accent':
      return theme.fg('accent', icon);
    case 'success':
      return theme.fg('success', icon);
    case 'error':
      return theme.fg('error', icon);
  }
};

const stepLabelColor = (status: WidgetStepStatus): 'dim' | 'text' =>
  status === 'pending' ? 'dim' : 'text';

const detailForStatus = (step: WidgetStep): string | undefined => {
  if (step.detail !== undefined) {
    return step.detail;
  }

  switch (step.id) {
    case 'review': {
      switch (step.status) {
        case 'in-progress':
          return 'checking…';
        case 'passed':
          return 'fixed';
        case 'failed':
          return 'rejected';
        default:
          return undefined;
      }
    }
    case 'acceptance-criteria': {
      switch (step.status) {
        case 'in-progress':
          return 'checking…';
        case 'passed':
          return 'passed';
        case 'failed':
          return 'rejected';
        default:
          return undefined;
      }
    }
    case 'ci-passed': {
      switch (step.status) {
        case 'in-progress':
          return 'waiting…';
        case 'passed':
          return 'passed';
        case 'failed':
          return 'failed';
        default:
          return undefined;
      }
    }
    case 'review-fixed': {
      switch (step.status) {
        case 'in-progress':
          return 'checking…';
        case 'passed':
          return 'resolved';
        case 'failed':
          return 'unresolved';
        default:
          return undefined;
      }
    }
    case 'pr-created': {
      switch (step.status) {
        case 'in-progress':
          return 'creating…';
        case 'passed':
          return 'created';
        default:
          return undefined;
      }
    }
    case 'merge': {
      switch (step.status) {
        case 'in-progress':
          return 'merging…';
        case 'passed':
          return 'merged';
        default:
          return undefined;
      }
    }
    default: {
      return undefined;
    }
  }
};

const computeWidgetSteps = (params: RalphLoopParams): WidgetStep[] => {
  const steps: WidgetStep[] = [
    {
      id: 'static-checks',
      label: 'static-checks',
      status: 'pending',
      commands: params.staticChecks.length > 0 ? params.staticChecks : undefined,
    },
  ];

  if (params.review) {
    steps.push({ id: 'review', label: 'review', status: 'pending' });
  }

  if (params.acceptanceCriteria !== undefined) {
    steps.push({
      id: 'acceptance-criteria',
      label: 'acceptance-criteria',
      status: 'pending',
      description: params.acceptanceCriteria,
    });
  }

  if (params.completion !== 'edit-only') {
    steps.push({
      id: 'completion-checks',
      label: 'completion-checks',
      status: 'pending',
      commands: [
        'git diff --quiet --exit-code',
        'git diff --cached --quiet --exit-code',
        'test -z "$(git ls-files --others --exclude-standard)"',
      ],
    });
    steps.push({ id: 'pr-created', label: 'pr-created', status: 'pending' });
  }

  if (params.autofix !== 'none') {
    steps.push({ id: 'ci-passed', label: 'ci', status: 'pending' });
  }

  if (params.autofix === 'comment') {
    steps.push({ id: 'review-fixed', label: 'review-fixed', status: 'pending' });
  }

  if (params.mergeCondition.enabled) {
    steps.push({ id: 'merge', label: 'merge', status: 'pending' });
  }

  return steps;
};

const renderStatusWidget = (ctx: ExtensionContext, widgetSteps: WidgetStep[]): void => {
  if (!ctx.hasUI) return;

  const theme = ctx.ui.theme;
  const lines: string[] = [theme.fg('accent', theme.bold('ralph-loop'))];

  for (const step of widgetSteps) {
    const icon = themedIcon(step.status, theme);
    const labelColor = stepLabelColor(step.status);

    let line: string;

    if (step.commands !== undefined && step.commands.length > 0) {
      const cmdList = step.commands.join(', ');

      line = `  ${icon} ${theme.fg(labelColor, `${step.label}:`)} ${theme.fg('dim', cmdList)}`;
    } else {
      line = `  ${icon} ${theme.fg(labelColor, step.label)}`;
    }

    const detailText = detailForStatus(step);

    if (detailText !== undefined) {
      line += `  ${theme.fg('dim', detailText)}`;
    }

    lines.push(line);

    // Render description (e.g. acceptance criteria text).
    if (step.description !== undefined) {
      lines.push(`       ${theme.fg('dim', step.description)}`);
    }
  }

  ctx.ui.setWidget('ralph-loop-status', lines);
};

const clearStatusWidget = (ctx: ExtensionContext): void => {
  if (ctx.hasUI) {
    ctx.ui.setWidget('ralph-loop-status', undefined);
  }
};

const initWidgetSteps = (params: RalphLoopParams): WidgetStep[] => {
  const steps = computeWidgetSteps(params);

  // Static checks always run fresh each time; mark them in-progress.
  const staticChecksStep = steps.find((s) => s.id === 'static-checks');

  if (staticChecksStep !== undefined) {
    staticChecksStep.status = 'in-progress';
  }

  return steps;
};

const markStepsUpTo = (widgetSteps: WidgetStep[], id: string): void => {
  for (const step of widgetSteps) {
    if (step.id === id) {
      step.status = 'in-progress';
      return;
    }

    if (step.status === 'pending') {
      step.status = 'passed';
    }
  }
};

const summarizeResult = (outcome: RalphLoopOutcome): string => {
  const result = outcome.result;

  switch (result.kind) {
    case 'completed': {
      return 'set-ralph-loop completed: all configured static checks, agent checks, completion automation, autofix checks, and merge conditions passed.';
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

      if (result.reason === 'autofix-ci-failed') {
        const details = lastMeaningfulOutput(result.autofixChecks);

        return details === undefined
          ? 'set-ralph-loop requires more work: PR CI still needs fixes.'
          : `set-ralph-loop requires more work: PR CI still needs fixes (${details}).`;
      }

      if (result.reason === 'autofix-comment-failed') {
        if (result.autofixDetails?.kind === 'comment-fixed') {
          return 'set-ralph-loop requires more work: unresolved PR comments still need replies before merge.';
        }

        const details = lastMeaningfulOutput(result.autofixChecks);

        return details === undefined
          ? 'set-ralph-loop requires more work: unresolved PR comments still need work.'
          : `set-ralph-loop requires more work: unresolved PR comments still need work (${details}).`;
      }

      if (result.reason === 'merge-approval-failed') {
        const details = lastMeaningfulOutput(result.mergeConditionChecks);

        return details === undefined
          ? 'set-ralph-loop requires more work: PR approval is still required before merge.'
          : `set-ralph-loop requires more work: PR approval is still required before merge (${details}).`;
      }

      if (result.reason === 'merge-command-failed') {
        const details = lastMeaningfulOutput(result.mergeConditionChecks);

        return details === undefined
          ? 'set-ralph-loop requires more work: the merge step failed.'
          : `set-ralph-loop requires more work: merge step failed (${details}).`;
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

const createFollowUpContent = (outcome: RalphLoopOutcome): string => {
  const content = [
    '[set-ralph-loop]',
    summarizeResult(outcome),
    'Continue working on the task until the configured checks pass.',
    'Do not call set-ralph-loop again; it is already configured for this session and directory.',
  ];

  if (
    outcome.result.kind === 'continue' &&
    outcome.result.reason === 'autofix-comment-failed' &&
    outcome.result.autofixDetails?.kind === 'comment-fixed' &&
    outcome.result.autofixDetails.pendingComments.length > 0
  ) {
    content.splice(2, 0, buildCommentFixedFollowUp(outcome.result.autofixDetails));
  }

  return content.join('\n\n');
};

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
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const result = await executeShellCommand(cwd, signal, 'command -v gh >/dev/null 2>&1');

  if (result.code !== 0) {
    throw new Error('GitHub CLI (gh) is required for the configured PR or merge automation.');
  }
};

const getCurrentBranch = async (
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  const result = await executeShellCommand(cwd, signal, 'git branch --show-current');
  const branch = result.stdout.trim();

  return result.code === 0 && branch !== '' ? branch : undefined;
};

const getDefaultBranch = async (
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  const gitResult = await executeShellCommand(
    cwd,
    signal,
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's#^origin/##'",
  );
  const gitBranch = gitResult.stdout.trim();

  if (gitResult.code === 0 && gitBranch !== '') {
    return gitBranch;
  }

  const ghResult = await executeShellCommand(
    cwd,
    signal,
    'gh repo view --json defaultBranchRef --jq .defaultBranchRef.name',
  );
  const ghBranch = ghResult.stdout.trim();

  return ghResult.code === 0 && ghBranch !== '' ? ghBranch : undefined;
};

const ensureNotOnDefaultBranchForPullRequestCompletion = async (
  cwd: string,
  signal: AbortSignal | undefined,
  params: RalphLoopParams,
): Promise<void> => {
  if (!isPullRequestCompletion(params.completion)) {
    return;
  }

  const currentBranch = await getCurrentBranch(cwd, signal);
  const defaultBranch = await getDefaultBranch(cwd, signal);

  if (
    currentBranch === undefined ||
    defaultBranch === undefined ||
    currentBranch !== defaultBranch
  ) {
    return;
  }

  throw new Error(
    [
      `completion=${params.completion} is configured, but the current branch is the default branch (${defaultBranch}).`,
      'ralph-package does not create or switch working branches for you.',
      'Before starting PR-oriented ralph-loop work, create and switch to a local feature branch yourself, then call set-ralph-loop again.',
    ].join(' '),
  );
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

    // Initialize the status widget for this run.
    const widgetSteps = initWidgetSteps(advanced.params);

    if (advanced.state.review.status === 'passed') {
      const reviewStep = widgetSteps.find((s) => s.id === 'review');

      if (reviewStep !== undefined) {
        reviewStep.status = 'passed';
      }
    }

    if (advanced.state.acceptanceCriteria.status === 'passed') {
      const acStep = widgetSteps.find((s) => s.id === 'acceptance-criteria');

      if (acStep !== undefined) {
        acStep.status = 'passed';
      }
    }

    renderStatusWidget(ctx, widgetSteps);

    const pullRequestTemplate = isPullRequestCompletion(advanced.params.completion)
      ? await loadPullRequestTemplate(() =>
          executeShellCommand(ctx.cwd, ctx.signal, 'git rev-parse --show-toplevel'),
        )
      : undefined;

    const outcome = await runRalphLoop(
      advanced.params,
      advanced.state,
      async (command) => executeShellCommand(ctx.cwd, ctx.signal, command),
      async (request) =>
        runAgentCheck(pi.exec.bind(pi), ctx.cwd, ctx.signal, request, createAgentCheckOptions(ctx)),
      {
        onStaticChecksPassed: () => {
          const scStep = widgetSteps.find((s) => s.id === 'static-checks');

          if (scStep !== undefined) {
            scStep.status = 'passed';
          }

          renderStatusWidget(ctx, widgetSteps);
          notifyProgress('set-ralph-loop: static checks passed.', ctx);
          emitProgressLog(pi, '[set-ralph-loop]\n\nStatic checks passed.');
        },
        onReviewStarted: (reused) => {
          markStepsUpTo(widgetSteps, 'review');

          if (reused) {
            const reviewStep = widgetSteps.find((s) => s.id === 'review');

            if (reviewStep !== undefined) {
              reviewStep.status = 'passed';
              reviewStep.detail = 'passed (reused)';
            }
          }

          renderStatusWidget(ctx, widgetSteps);
          notifyProgress(
            reused
              ? 'set-ralph-loop: static checks passed. reusing the passed review result.'
              : 'set-ralph-loop: static checks passed. running review...',
            ctx,
          );
        },
        onAcceptanceCriteriaStarted: (reused) => {
          markStepsUpTo(widgetSteps, 'acceptance-criteria');

          if (reused) {
            const acStep = widgetSteps.find((s) => s.id === 'acceptance-criteria');

            if (acStep !== undefined) {
              acStep.status = 'passed';
              acStep.detail = 'passed (reused)';
            }
          }

          renderStatusWidget(ctx, widgetSteps);
          notifyProgress(
            reused
              ? 'set-ralph-loop: static checks passed. reusing the passed acceptance-criteria result.'
              : 'set-ralph-loop: static checks passed. checking acceptance criteria...',
            ctx,
          );
        },
        onCompletionChecksStarted: () => {
          markStepsUpTo(widgetSteps, 'completion-checks');
          renderStatusWidget(ctx, widgetSteps);
          notifyProgress(
            'set-ralph-loop: static checks passed. checking completion conditions...',
            ctx,
          );
        },
        onCompletionAutomationStarted: (mode) => {
          markStepsUpTo(widgetSteps, 'pr-created');
          renderStatusWidget(ctx, widgetSteps);
          notifyProgress(
            mode === 'pr'
              ? 'set-ralph-loop: commit checks passed. creating or updating the ready PR...'
              : 'set-ralph-loop: commit checks passed. creating or updating the draft PR...',
            ctx,
          );
        },
        onAutofixStarted: (autofix) => {
          markStepsUpTo(widgetSteps, 'ci-passed');

          if (autofix === 'comment') {
            const reviewFixedStep = widgetSteps.find((s) => s.id === 'review-fixed');

            if (reviewFixedStep !== undefined) {
              reviewFixedStep.status = 'in-progress';
            }
          }

          renderStatusWidget(ctx, widgetSteps);
          notifyProgress(
            autofix === 'comment'
              ? 'set-ralph-loop: PR automation passed. waiting for CI if present, then checking unresolved PR comments...'
              : 'set-ralph-loop: PR automation passed. waiting for CI if present...',
            ctx,
          );
        },
        onMergeConditionStarted: (params) => {
          markStepsUpTo(widgetSteps, 'merge');
          renderStatusWidget(ctx, widgetSteps);

          if (params.completion === 'draft-pr' && params.mergeCondition.enabled) {
            notifyProgress(
              params.mergeCondition.approved
                ? 'set-ralph-loop: autofix checks passed. marking the draft PR ready for review, then waiting for approval before merge...'
                : 'set-ralph-loop: autofix checks passed. marking the draft PR ready for review, then merging automatically...',
              ctx,
            );
            return;
          }

          notifyProgress(
            params.mergeCondition.enabled && params.mergeCondition.approved
              ? 'set-ralph-loop: autofix checks passed. waiting until PR approval before merge...'
              : 'set-ralph-loop: autofix checks passed. merging automatically...',
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

      // Mark all remaining steps as passed and show final state briefly.
      for (const step of widgetSteps) {
        if (step.status === 'pending' || step.status === 'in-progress') {
          step.status = 'passed';
        }
      }

      renderStatusWidget(ctx, widgetSteps);
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

    // Loop continues — mark the failing step with detail and keep the widget visible.
    if (outcome.result.kind === 'continue') {
      const reasonToStepId: Record<string, string> = {
        'static-check-failed': 'static-checks',
        'review-rejected': 'review',
        'acceptance-criteria-rejected': 'acceptance-criteria',
        'completion-check-failed': 'completion-checks',
        'completion-automation-failed': 'pr-created',
        'autofix-ci-failed': 'ci-passed',
        'autofix-comment-failed': 'review-fixed',
        'merge-approval-failed': 'merge',
        'merge-command-failed': 'merge',
      };

      const failedStepId = reasonToStepId[outcome.result.reason];

      if (failedStepId !== undefined) {
        const failedStep = widgetSteps.find((s) => s.id === failedStepId);

        if (failedStep !== undefined) {
          failedStep.status = 'failed';

          // Set detail text for CI failures from the actual check output.
          if (failedStepId === 'ci-passed' && outcome.result.autofixChecks !== undefined) {
            const last = lastMeaningfulOutput(outcome.result.autofixChecks);

            if (last !== undefined && last.length > 0) {
              failedStep.detail = last.length > 60 ? `${last.slice(0, 57)}…` : last;
            }
          }
        }
      }

      renderStatusWidget(ctx, widgetSteps);
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

    clearStatusWidget(ctx);
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
    'set-ralph-loop configured. Work on the task normally; the configured checks will run automatically when you are done and stop taking further actions.',
    'Trigger condition: when you believe the task is complete, do not wait, do not run sleep, and do not run unrelated confirmation commands just to see whether ralph-loop fires. Simply stop and let the current turn end; ralph-loop will start automatically from that agent_end.',
    'If this was configured autonomously without an explicit PR/delegation/merge request, treat it as a lightweight verification gate only: use static checks with completion=edit-only, autofix=none, and mergeCondition={ enabled: false }.',
    ...guidance,
  ].join('\n\n');
};

const createSetRalphLoopTool = (_pi: ExtensionAPI) =>
  defineTool({
    name: 'set-ralph-loop',
    label: 'Set Ralph Loop',
    description:
      'Configure ralph-loop completion checks for the current task. Autonomous use is allowed only as a lightweight verification gate: use the configured static checks with completion=edit-only, autofix=none, and mergeCondition={ enabled: false } unless the user explicitly asks for PR/delegation/merge automation or invokes a ralph command.',
    promptSnippet:
      'Use set-ralph-loop autonomously only for lightweight verification (static checks, completion=edit-only, autofix=none, mergeCondition={ enabled: false }). Use PR/autofix/merge modes only when explicitly requested or provided by a ralph command.',
    promptGuidelines: [
      'Autonomous use must be lightweight only: configured staticChecks, completion=edit-only, autofix=none, mergeCondition={ enabled: false }.',
      'Use PR/autofix/merge modes only when explicitly requested by the user or supplied by a ralph command.',
      'Do not call set-ralph-loop again after it has been configured for the current session and directory.',
      'After configuration, finish normal task work; when done, stop so agent_end can run ralph-loop.',
      'If ralph-loop reports a failure, continue fixing the task instead of reconfiguring the loop.',
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
      completion: Type.Unsafe<RalphLoopParams['completion']>({
        type: 'string',
        enum: ['edit-only', 'draft-pr', 'pr'],
        description:
          'Completion policy. Must be exactly one of: edit-only, draft-pr, pr. Do not use local, response, commit, or only-edit. Autonomous/default use should be edit-only.',
      }),
      autofix: Type.Unsafe<RalphLoopParams['autofix']>({
        type: 'string',
        enum: ['none', 'ci', 'comment'],
        description:
          'Autofix scope. Must be exactly one of: none, ci, comment. Use none unless CI/comment follow-up was explicitly requested or supplied by a ralph command.',
      }),
      mergeCondition: Type.Union(
        [
          Type.Object({
            enabled: Type.Literal(false),
          }),
          Type.Object({
            enabled: Type.Literal(true),
            approved: Type.Boolean({
              description:
                'Whether GitHub PR approval must be present before merge after autofix completes.',
            }),
          }),
        ],
        {
          description:
            'Optional merge policy. Use { enabled: false } unless merge automation was explicitly requested or supplied by a ralph command.',
        },
      ),
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
        await ensureGitHubCliAvailable(ctx.cwd, ctx.signal);
      }

      await ensureNotOnDefaultBranchForPullRequestCompletion(ctx.cwd, ctx.signal, normalizedParams);

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

      // Show initial widget with all steps pending.
      const widgetSteps = computeWidgetSteps(normalizedParams);

      renderStatusWidget(ctx, widgetSteps);
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
      clearStatusWidget(ctx);

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
