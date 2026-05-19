import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RalphLoopAgentRequest, RalphLoopReviewDecision } from './ralphLoop.service.ts';

export type ExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed: boolean;
};

export type ExecCommand = (
  command: string,
  args: string[],
  options: {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly timeout: number;
  },
) => Promise<ExecResult>;

const AGENT_TIMEOUT_MS = 2 * 60 * 1000;
const REVIEW_TOOL_EXTENSION_PATH = fileURLToPath(
  new URL('./reviewTool.extension.ts', import.meta.url),
);
const REVIEW_TOOL_LIST = 'read,bash,grep,find,ls,review';

const getPiInvocation = (
  args: string[],
): { readonly command: string; readonly args: readonly string[] } => {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');

  if (currentScript !== undefined && isBunVirtualScript !== true) {
    return {
      command: process.execPath,
      args: [currentScript, ...args],
    };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
};

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

const parseReviewDecisionFromDetails = (details: unknown): RalphLoopReviewDecision | undefined => {
  if (typeof details !== 'object' || details === null || !('result' in details)) {
    return undefined;
  }

  if (details.result === 'accept') {
    if (!('message' in details) || typeof details.message !== 'string') {
      return undefined;
    }

    return {
      result: 'accept',
      message: details.message,
    };
  }

  if (details.result === 'reject') {
    if (!('reason' in details) || typeof details.reason !== 'string') {
      return undefined;
    }

    return {
      result: 'reject',
      reason: details.reason,
    };
  }

  return undefined;
};

const extractDecisionFromEvent = (event: unknown): RalphLoopReviewDecision | undefined => {
  if (typeof event !== 'object' || event === null || !('type' in event)) {
    return undefined;
  }

  if (
    event.type === 'tool_execution_end' &&
    'toolName' in event &&
    event.toolName === 'review' &&
    'result' in event &&
    typeof event.result === 'object' &&
    event.result !== null &&
    'details' in event.result
  ) {
    return parseReviewDecisionFromDetails(event.result.details);
  }

  if (
    event.type === 'message_end' &&
    'message' in event &&
    typeof event.message === 'object' &&
    event.message !== null &&
    'role' in event.message &&
    event.message.role === 'toolResult' &&
    'toolName' in event.message &&
    event.message.toolName === 'review' &&
    'details' in event.message
  ) {
    return parseReviewDecisionFromDetails(event.message.details);
  }

  return undefined;
};

export const extractReviewDecision = (stdout: string): RalphLoopReviewDecision | undefined => {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const decision = extractDecisionFromEvent(event);

    if (decision !== undefined) {
      return decision;
    }
  }

  return undefined;
};

const buildAgentArgs = (
  sessionDir: string,
  promptPath: string,
  request: RalphLoopAgentRequest,
  continueSession: boolean,
): string[] => {
  const args = [
    '--mode',
    'json',
    '-p',
    '--session-dir',
    sessionDir,
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-extensions',
    '--extension',
    REVIEW_TOOL_EXTENSION_PATH,
    '--tools',
    REVIEW_TOOL_LIST,
    '--append-system-prompt',
    promptPath,
  ];

  if (continueSession) {
    args.push('--continue');
    args.push(buildResumePrompt(request));
    return args;
  }

  args.push(buildInitialPrompt(request));
  return args;
};

const writePromptToTempFile = async (request: RalphLoopAgentRequest): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ralph-loop-prompt-'));
  const filePath = path.join(directory, 'prompt.md');

  await writeFile(filePath, buildSystemPrompt(request), 'utf8');

  return filePath;
};

const removePromptFile = async (promptPath: string): Promise<void> => {
  await unlink(promptPath).catch(() => undefined);
  await rm(path.dirname(promptPath), { recursive: true, force: true }).catch(() => undefined);
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

export const runAgentCheck = async (
  execCommand: ExecCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  request: RalphLoopAgentRequest,
  options?: RunAgentCheckOptions,
): Promise<RalphLoopReviewDecision> => {
  const promptPath = await writePromptToTempFile(request);
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'ralph-loop-session-'));

  try {
    let continueSession = false;
    let continuationAttempts = 0;
    const maxContinuationAttempts = options?.maxContinuationAttempts ?? 3;

    for (;;) {
      const args = buildAgentArgs(sessionDir, promptPath, request, continueSession);
      const invocation = getPiInvocation(args);
      const result = await execCommand(invocation.command, [...invocation.args], {
        cwd,
        signal,
        timeout: AGENT_TIMEOUT_MS,
      });
      const decision = extractReviewDecision(result.stdout);

      if (decision !== undefined) {
        return decision;
      }

      if (result.code !== 0) {
        const output = result.stderr === '' ? result.stdout : result.stderr;
        throw new Error(
          `set-ralph-loop ${request.kind} agent failed without a review decision (exit ${result.code}): ${output}`,
        );
      }

      continuationAttempts += 1;

      if (continuationAttempts > maxContinuationAttempts) {
        throw new Error(
          `set-ralph-loop ${request.kind} agent finished without calling the required review tool after ${maxContinuationAttempts} retries.`,
        );
      }

      await options?.onMissingReviewToolCall?.(
        continuationAttempts,
        maxContinuationAttempts,
        request,
      );
      continueSession = true;
    }
  } finally {
    await removePromptFile(promptPath);
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
