import { fileURLToPath } from 'node:url';

import type { RalphLoopAgentRequest, RalphLoopReviewDecision } from './ralphLoop.service.ts';

import {
  extractToolDecision,
  runDecisionAgent,
  type ExecCommand,
  type ExecResult,
} from './decisionAgentRunner.service.ts';

const AGENT_TIMEOUT_MS = 2 * 60 * 1000;
const REVIEW_TOOL_EXTENSION_PATH = fileURLToPath(
  new URL('./reviewTool.extension.ts', import.meta.url),
);
const REVIEW_TOOL_LIST = 'read,bash,grep,find,ls,review';

export type { ExecCommand, ExecResult };

export type RunAgentCheckOptions = {
  readonly maxContinuationAttempts?: number;
  readonly onMissingReviewToolCall?: (
    attempt: number,
    maxContinuationAttempts: number,
    request: RalphLoopAgentRequest,
  ) => Promise<void> | void;
};

const buildSystemPrompt = (request: RalphLoopAgentRequest): string => {
  switch (request.kind) {
    case 'review': {
      return [
        'You are the set-ralph-loop review agent.',
        'Inspect the current repository state and recent changes using read-only tools only.',
        'Prefer the minimum inspection needed to reach a verdict quickly.',
        'Use bash only for read-only inspection such as git diff, git status, git show, or running read-only project inspection commands.',
        'Do not modify files, do not run edit/write tools, and do not make speculative claims.',
        'You MUST call the review tool exactly once before finishing.',
        'If the work is acceptable, call review with { result: "accept", message: string }.',
        'If the work is not acceptable, call review with { result: "reject", reason: string }.',
        'Do not finish with a normal assistant message instead of the review tool.',
        'Do not ask clarifying questions. If the evidence is insufficient, call review with result="reject" and explain what is missing.',
        'As soon as you have enough evidence, call review immediately.',
      ].join('\n');
    }
    case 'acceptance-criteria': {
      return [
        'You are the set-ralph-loop acceptance-criteria agent.',
        'Inspect the current repository state against the provided acceptance criteria using read-only tools only.',
        'Prefer the minimum inspection needed to reach a verdict quickly.',
        'Use bash only for read-only inspection such as git diff, git status, git show, or running read-only project inspection commands.',
        'Do not modify files, do not run edit/write tools, and do not make speculative claims.',
        `Acceptance criteria:\n${request.acceptanceCriteria}`,
        'You MUST call the review tool exactly once before finishing.',
        'If every acceptance criterion is satisfied, call review with { result: "accept", message: string }.',
        'If any acceptance criterion is not satisfied, call review with { result: "reject", reason: string }.',
        'Do not finish with a normal assistant message instead of the review tool.',
        'Do not ask clarifying questions. If the evidence is insufficient, call review with result="reject" and explain what is missing.',
        'As soon as you have enough evidence, call review immediately.',
      ].join('\n');
    }
    default: {
      return assertNever(request);
    }
  }
};

const buildInitialPrompt = (request: RalphLoopAgentRequest): string => {
  switch (request.kind) {
    case 'review': {
      return [
        'Review the current task result and call review exactly once with your verdict.',
        'If you are unsure or lack evidence, reject instead of asking questions.',
      ].join('\n');
    }
    case 'acceptance-criteria': {
      return [
        'Check whether the current task result satisfies the provided acceptance criteria.',
        'Call review exactly once with your verdict.',
        'If you are unsure or lack evidence, reject instead of asking questions.',
      ].join('\n');
    }
    default: {
      return assertNever(request);
    }
  }
};

const buildResumePrompt = (request: RalphLoopAgentRequest): string => {
  switch (request.kind) {
    case 'review': {
      return [
        'You finished without calling the required review tool.',
        'Continue the same review and call review now with either accept or reject.',
        'Do not ask questions or continue exploring; emit the review tool now.',
      ].join('\n');
    }
    case 'acceptance-criteria': {
      return [
        'You finished without calling the required review tool.',
        'Continue the same acceptance-criteria check and call review now with either accept or reject.',
        'Do not ask questions or continue exploring; emit the review tool now.',
      ].join('\n');
    }
    default: {
      return assertNever(request);
    }
  }
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

export const extractReviewDecision = (stdout: string): RalphLoopReviewDecision | undefined =>
  extractToolDecision(stdout, 'review');

export const runAgentCheck = async (
  execCommand: ExecCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  request: RalphLoopAgentRequest,
  options?: RunAgentCheckOptions,
): Promise<RalphLoopReviewDecision> =>
  runDecisionAgent(execCommand, {
    toolName: 'review',
    tools: REVIEW_TOOL_LIST,
    extensionPath: REVIEW_TOOL_EXTENSION_PATH,
    cwd,
    signal,
    timeoutMs: AGENT_TIMEOUT_MS,
    request,
    buildSystemPrompt,
    buildInitialPrompt,
    buildResumePrompt,
    requestLabel: request.kind,
    maxContinuationAttempts: options?.maxContinuationAttempts,
    onMissingRequiredToolCall: options?.onMissingReviewToolCall,
  });
