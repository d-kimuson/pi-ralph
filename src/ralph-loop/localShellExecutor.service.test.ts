import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  buildLocalShellEnv,
  executeLocalShellCommand,
  getPiAgentDir,
  resolveLocalShellConfig,
} from './localShellExecutor.service.ts';

describe('localShellExecutor', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test('uses the default pi agent directory when PI_CODING_AGENT_DIR is not set', () => {
    expect(getPiAgentDir({}, '/Users/example')).toBe('/Users/example/.pi/agent');
  });

  test('expands PI_CODING_AGENT_DIR from the environment', () => {
    expect(
      getPiAgentDir(
        {
          PI_CODING_AGENT_DIR: '~/custom-agent-dir',
        },
        '/Users/example',
      ),
    ).toBe('/Users/example/custom-agent-dir');
  });

  test('prepends the pi agent bin directory to PATH once', () => {
    const first = buildLocalShellEnv(
      {
        PATH: '/usr/local/bin:/usr/bin',
      },
      {
        agentDir: '/Users/example/.pi/agent',
      },
    );
    const second = buildLocalShellEnv(first, {
      agentDir: '/Users/example/.pi/agent',
    });

    expect(first['PATH']).toBe('/Users/example/.pi/agent/bin:/usr/local/bin:/usr/bin');
    expect(second['PATH']).toBe('/Users/example/.pi/agent/bin:/usr/local/bin:/usr/bin');
  });

  test('preserves PATH key casing when augmenting env', () => {
    const env = buildLocalShellEnv(
      {
        Path: '/usr/local/bin',
      },
      {
        agentDir: '/Users/example/.pi/agent',
      },
    );

    expect(env['Path']).toBe('/Users/example/.pi/agent/bin:/usr/local/bin');
    expect(env['PATH']).toBeUndefined();
  });

  test('prefers /bin/bash for internal commands', () => {
    const config = resolveLocalShellConfig({
      pathExists: (targetPath) => targetPath === '/bin/bash',
    });

    expect(config).toEqual({
      shell: '/bin/bash',
      args: ['-c'],
    });
  });

  test('falls back to /bin/sh when /bin/bash is unavailable', () => {
    const config = resolveLocalShellConfig({
      pathExists: (targetPath) => targetPath === '/bin/sh',
    });

    expect(config).toEqual({
      shell: '/bin/sh',
      args: ['-c'],
    });
  });

  test('executes commands with the augmented PATH', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-ralph-shell-exec-'));
    temporaryDirectories.push(directory);

    const result = await executeLocalShellCommand({
      cwd: directory,
      command: 'printf %s "$PATH"',
      env: {
        PATH: '/usr/bin',
      },
      homeDirectory: '/Users/example',
      pathExists: (targetPath) => targetPath === '/bin/bash',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('/Users/example/.pi/agent/bin:/usr/bin');
    expect(result.stderr).toBe('');
  });

  test('captures stderr and exit code from failed commands', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-ralph-shell-exec-'));
    temporaryDirectories.push(directory);

    const result = await executeLocalShellCommand({
      cwd: directory,
      command: 'printf failure >&2; exit 7',
      pathExists: (targetPath) => targetPath === '/bin/bash',
    });

    expect(result.code).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('failure');
  });
});
