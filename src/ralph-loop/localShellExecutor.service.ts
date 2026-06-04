import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { RalphLoopCommandResult } from './ralphLoop.service.ts';

const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const DEFAULT_AGENT_DIR_PATH = ['.pi', 'agent'] as const;
const AGENT_BIN_DIR_NAME = 'bin';
const DEFAULT_BASH_PATH = '/bin/bash';
const DEFAULT_SH_PATH = '/bin/sh';

type PathExists = (path: string) => boolean;

export type LocalShellExecutorOptions = {
  readonly cwd: string;
  readonly command: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly pathExists?: PathExists;
};

export type LocalShellConfig = {
  readonly shell: string;
  readonly args: readonly string[];
};

const expandTildePath = (path: string, homeDirectory: string): string => {
  if (path === '~') {
    return homeDirectory;
  }

  if (path.startsWith('~/')) {
    return join(homeDirectory, path.slice(2));
  }

  return path;
};

export const getPiAgentDir = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string => {
  const configuredDirectory = env[PI_AGENT_DIR_ENV]?.trim();

  if (configuredDirectory !== undefined && configuredDirectory !== '') {
    return expandTildePath(configuredDirectory, homeDirectory);
  }

  return join(homeDirectory, ...DEFAULT_AGENT_DIR_PATH);
};

export const buildLocalShellEnv = (
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly agentDir?: string;
  } = {},
): NodeJS.ProcessEnv => {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = env[pathKey] ?? '';
  const agentBinDir = join(options.agentDir ?? getPiAgentDir(env), AGENT_BIN_DIR_NAME);
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const nextPath = pathEntries.includes(agentBinDir)
    ? currentPath
    : [agentBinDir, currentPath].filter(Boolean).join(delimiter);

  return {
    ...env,
    [pathKey]: nextPath,
  };
};

export const resolveLocalShellConfig = (
  options: {
    readonly pathExists?: PathExists;
  } = {},
): LocalShellConfig => {
  const pathExists = options.pathExists ?? existsSync;

  if (pathExists(DEFAULT_BASH_PATH)) {
    return {
      shell: DEFAULT_BASH_PATH,
      args: ['-c'],
    };
  }

  if (pathExists(DEFAULT_SH_PATH)) {
    return {
      shell: DEFAULT_SH_PATH,
      args: ['-c'],
    };
  }

  return {
    shell: 'sh',
    args: ['-c'],
  };
};

const killProcessTree = (pid: number): void => {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      detached: true,
    });

    killer.unref();
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore: process already exited
    }
  }
};

export const executeLocalShellCommand = async (
  options: LocalShellExecutorOptions,
): Promise<RalphLoopCommandResult> => {
  const shellConfig = resolveLocalShellConfig(options);
  const env = buildLocalShellEnv(options.env, {
    agentDir: getPiAgentDir(options.env, options.homeDirectory),
  });
  const child = spawn(shellConfig.shell, [...shellConfig.args, options.command], {
    cwd: options.cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timeoutId: NodeJS.Timeout | undefined;

  const abortProcess = (): void => {
    if (child.pid !== undefined) {
      killProcessTree(child.pid);
    } else {
      child.kill('SIGKILL');
    }
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      abortProcess();
    } else {
      options.signal.addEventListener('abort', abortProcess, { once: true });
    }
  }

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      abortProcess();
    }, options.timeoutMs);
  }

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (closeCode) => {
        resolve(closeCode ?? 1);
      });
    });

    return {
      command: options.command,
      code,
      stdout,
      stderr,
    };
  } catch (error) {
    stderr = stderr === '' ? String(error) : `${stderr}\n${String(error)}`;

    return {
      command: options.command,
      code: 1,
      stdout,
      stderr,
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    options.signal?.removeEventListener('abort', abortProcess);
  }
};
