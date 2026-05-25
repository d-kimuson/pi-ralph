import { realpathSync } from 'node:fs';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { basename } from 'node:path';

import type { RalphLoopDecision } from './ralphLoop.service.ts';

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

export type RunDecisionAgentOptions<Request> = {
  readonly toolName: string;
  readonly tools: string;
  readonly extensionPath: string;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly request: Request;
  readonly buildSystemPrompt: (request: Request) => string;
  readonly buildInitialPrompt: (request: Request) => string;
  readonly buildResumePrompt: (request: Request) => string;
  readonly requestLabel: string;
  readonly maxContinuationAttempts?: number;
  readonly onMissingRequiredToolCall?: (
    attempt: number,
    maxContinuationAttempts: number,
    request: Request,
  ) => Promise<void> | void;
};

const PI_CLI_PATH_ENV = 'PI_RALPH_PI_CLI_PATH';
const PI_EXECUTABLE_NAME_PATTERN = /^pi(?:\.exe)?$/;
const PI_CLI_SCRIPT_PATH_PATTERN =
  /(?:^|\/)@earendil-works\/pi-coding-agent\/dist\/cli\.(?:[cm]?js)$/;

type ProcessInfo = Pick<NodeJS.Process, 'argv' | 'env' | 'execPath'>;

const normalizePath = (filePath: string): string => filePath.replace(/\\/gu, '/');

const getResolvedPathCandidates = (filePath: string): readonly string[] => {
  const normalizedPath = normalizePath(filePath);

  try {
    const resolvedPath = normalizePath(realpathSync(filePath));

    return resolvedPath === normalizedPath ? [normalizedPath] : [normalizedPath, resolvedPath];
  } catch {
    return [normalizedPath];
  }
};

const isBunVirtualScript = (scriptPath: string): boolean => scriptPath.startsWith('/$bunfs/root/');

const isPiCliScript = (scriptPath: string): boolean =>
  getResolvedPathCandidates(scriptPath).some((candidatePath) => {
    const scriptName = basename(candidatePath).toLowerCase();

    if (PI_EXECUTABLE_NAME_PATTERN.test(scriptName)) {
      return true;
    }

    return PI_CLI_SCRIPT_PATH_PATTERN.test(candidatePath);
  });

const isPiExecutable = (execPath: string): boolean =>
  getResolvedPathCandidates(execPath).some((candidatePath) =>
    PI_EXECUTABLE_NAME_PATTERN.test(basename(candidatePath).toLowerCase()),
  );

const getConfiguredPiCommand = (processInfo: ProcessInfo): string | undefined => {
  const configuredCommand = processInfo.env[PI_CLI_PATH_ENV]?.trim();

  if (configuredCommand === undefined || configuredCommand === '') {
    return undefined;
  }

  return configuredCommand;
};

export const getPiInvocation = (
  args: string[],
  processInfo: ProcessInfo = process,
): { readonly command: string; readonly args: readonly string[] } => {
  const configuredPiCommand = getConfiguredPiCommand(processInfo);

  if (configuredPiCommand !== undefined) {
    return { command: configuredPiCommand, args };
  }

  const currentScript = processInfo.argv[1];

  if (
    currentScript !== undefined &&
    isBunVirtualScript(currentScript) !== true &&
    isPiCliScript(currentScript)
  ) {
    return {
      command: processInfo.execPath,
      args: [currentScript, ...args],
    };
  }

  if (isPiExecutable(processInfo.execPath)) {
    return { command: processInfo.execPath, args };
  }

  return { command: 'pi', args };
};

const buildPiFallbackHint = (command: string): string =>
  command === 'pi'
    ? ` If you are running inside an embedded host, set ${PI_CLI_PATH_ENV}=/absolute/path/to/pi.`
    : '';

const parseDecisionFromDetails = (details: unknown): RalphLoopDecision | undefined => {
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

const extractDecisionFromEvent = (
  event: unknown,
  toolName: string,
): RalphLoopDecision | undefined => {
  if (typeof event !== 'object' || event === null || !('type' in event)) {
    return undefined;
  }

  if (
    event.type === 'tool_execution_end' &&
    'toolName' in event &&
    event.toolName === toolName &&
    'result' in event &&
    typeof event.result === 'object' &&
    event.result !== null &&
    'details' in event.result
  ) {
    return parseDecisionFromDetails(event.result.details);
  }

  if (
    event.type === 'message_end' &&
    'message' in event &&
    typeof event.message === 'object' &&
    event.message !== null &&
    'role' in event.message &&
    event.message.role === 'toolResult' &&
    'toolName' in event.message &&
    event.message.toolName === toolName &&
    'details' in event.message
  ) {
    return parseDecisionFromDetails(event.message.details);
  }

  return undefined;
};

export const extractToolDecision = (
  stdout: string,
  toolName: string,
): RalphLoopDecision | undefined => {
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

    const decision = extractDecisionFromEvent(event, toolName);

    if (decision !== undefined) {
      return decision;
    }
  }

  return undefined;
};

const buildAgentArgs = <Request>(
  sessionDir: string,
  promptPath: string,
  options: Pick<
    RunDecisionAgentOptions<Request>,
    'buildInitialPrompt' | 'buildResumePrompt' | 'extensionPath' | 'request' | 'toolName' | 'tools'
  >,
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
    options.extensionPath,
    '--tools',
    options.tools,
    '--append-system-prompt',
    promptPath,
  ];

  if (continueSession) {
    args.push('--continue');
    args.push(options.buildResumePrompt(options.request));
    return args;
  }

  args.push(options.buildInitialPrompt(options.request));
  return args;
};

const writePromptToTempFile = async <Request>(options: {
  readonly buildSystemPrompt: (request: Request) => string;
  readonly request: Request;
}): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ralph-loop-prompt-'));
  const filePath = path.join(directory, 'prompt.md');

  await writeFile(filePath, options.buildSystemPrompt(options.request), 'utf8');

  return filePath;
};

const removePromptFile = async (promptPath: string): Promise<void> => {
  await unlink(promptPath).catch(() => undefined);
  await rm(path.dirname(promptPath), { recursive: true, force: true }).catch(() => undefined);
};

export const runDecisionAgent = async <Request>(
  execCommand: ExecCommand,
  options: RunDecisionAgentOptions<Request>,
): Promise<RalphLoopDecision> => {
  const promptPath = await writePromptToTempFile(options);
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'ralph-loop-session-'));

  try {
    let continueSession = false;
    let continuationAttempts = 0;
    const maxContinuationAttempts = options.maxContinuationAttempts ?? 3;

    for (;;) {
      const args = buildAgentArgs(sessionDir, promptPath, options, continueSession);
      const invocation = getPiInvocation(args);
      let result: ExecResult;

      try {
        result = await execCommand(invocation.command, [...invocation.args], {
          cwd: options.cwd,
          signal: options.signal,
          timeout: options.timeoutMs,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        throw new Error(
          `set-ralph-loop ${options.requestLabel} agent failed to launch ${invocation.command}: ${detail}${buildPiFallbackHint(invocation.command)}`,
        );
      }
      const decision = extractToolDecision(result.stdout, options.toolName);

      if (decision !== undefined) {
        return decision;
      }

      if (result.code !== 0) {
        const output = result.stderr === '' ? result.stdout : result.stderr;
        throw new Error(
          `set-ralph-loop ${options.requestLabel} agent failed without a ${options.toolName} decision (exit ${result.code}): ${output}${buildPiFallbackHint(invocation.command)}`,
        );
      }

      continuationAttempts += 1;

      if (continuationAttempts > maxContinuationAttempts) {
        throw new Error(
          `set-ralph-loop ${options.requestLabel} agent finished without calling the required ${options.toolName} tool after ${maxContinuationAttempts} retries.`,
        );
      }

      await options.onMissingRequiredToolCall?.(
        continuationAttempts,
        maxContinuationAttempts,
        options.request,
      );
      continueSession = true;
    }
  } finally {
    await removePromptFile(promptPath);
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
};
