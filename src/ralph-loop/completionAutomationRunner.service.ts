import { fileURLToPath } from 'node:url';

import type {
  RalphLoopCompletionAutomationRequest,
  RalphLoopDecision,
} from './ralphLoop.service.ts';

import {
  extractToolDecision,
  runDecisionAgent,
  type ExecCommand,
} from './decisionAgentRunner.service.ts';

const AUTOMATION_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETION_AUTOMATION_EXTENSION_PATH = fileURLToPath(
  new URL('./completionAutomationTool.extension.ts', import.meta.url),
);
const COMPLETION_AUTOMATION_TOOL_LIST = 'read,bash,grep,find,ls,completion-automation';

export type RunCompletionAutomationOptions = {
  readonly maxContinuationAttempts?: number;
  readonly onMissingCompletionAutomationToolCall?: (
    attempt: number,
    maxContinuationAttempts: number,
    request: RalphLoopCompletionAutomationRequest,
  ) => Promise<void> | void;
};

const buildSystemPrompt = (request: RalphLoopCompletionAutomationRequest): string => {
  const templateSection =
    request.pullRequestTemplate === undefined
      ? 'No pull request template file was found at the repository root.'
      : [
          `Pull request template path: ${request.pullRequestTemplate.path}`,
          'Fill this template with repository-specific content. Do not leave placeholders unchanged.',
          'Pull request template content:',
          '```md',
          request.pullRequestTemplate.content,
          '```',
        ].join('\n');

  return [
    'You are the set-ralph-loop completion automation agent.',
    'Inspect the current repository state and recent commits, then create or update the pull request for the current branch using GitHub CLI.',
    'Use read-only tools for inspection and bash for git/gh commands.',
    'Do not edit repository files. Temporary files outside the repository are allowed when needed for gh arguments.',
    'Do not create, rename, or switch git branches. Use the current branch only.',
    'If there is already a pull request for the current branch, reuse it instead of creating a duplicate.',
    request.mode === 'pr'
      ? 'Ensure the final pull request is ready for review (not a draft).'
      : 'Ensure the final pull request remains a draft.',
    templateSection,
    'You MUST call the completion-automation tool exactly once before finishing.',
    'If the automation succeeds, call completion-automation with { result: "accept", message: string } and include the PR URL when possible.',
    'If the automation cannot be completed, call completion-automation with { result: "reject", reason: string }.',
    'Do not ask clarifying questions. If the automation is blocked, reject with a concrete reason.',
  ].join('\n');
};

const buildInitialPrompt = (request: RalphLoopCompletionAutomationRequest): string =>
  [
    `Inspect the committed changes and ${request.mode === 'pr' ? 'create or update a ready-for-review PR' : 'create or update a draft PR'} for the current branch.`,
    'After the PR state is correct, call completion-automation exactly once with accept or reject.',
  ].join('\n');

const buildResumePrompt = (_request: RalphLoopCompletionAutomationRequest): string =>
  [
    'You finished without calling the required completion-automation tool.',
    'Continue the same pull-request automation and call completion-automation now with either accept or reject.',
    'Do not ask questions or continue exploring; emit the completion-automation tool now.',
  ].join('\n');

export const extractCompletionAutomationDecision = (
  stdout: string,
): RalphLoopDecision | undefined => extractToolDecision(stdout, 'completion-automation');

export const runCompletionAutomation = async (
  execCommand: ExecCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  request: RalphLoopCompletionAutomationRequest,
  options?: RunCompletionAutomationOptions,
): Promise<RalphLoopDecision> =>
  runDecisionAgent(execCommand, {
    toolName: 'completion-automation',
    tools: COMPLETION_AUTOMATION_TOOL_LIST,
    extensionPath: COMPLETION_AUTOMATION_EXTENSION_PATH,
    cwd,
    signal,
    timeoutMs: AUTOMATION_TIMEOUT_MS,
    request,
    buildSystemPrompt,
    buildInitialPrompt,
    buildResumePrompt,
    requestLabel: 'completion automation',
    maxContinuationAttempts: options?.maxContinuationAttempts,
    onMissingRequiredToolCall: options?.onMissingCompletionAutomationToolCall,
  });
