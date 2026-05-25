import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { getPiInvocation } from './decisionAgentRunner.service.ts';

describe('getPiInvocation', () => {
  const args = ['--mode', 'json', '-p'];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test('reuses the current script only when it is the pi CLI entrypoint', () => {
    const invocation = getPiInvocation(args, {
      argv: [
        '/nix/store/node/bin/node',
        '/home/kaito/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.75.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ],
      env: {},
      execPath: '/nix/store/node/bin/node',
    });

    expect(invocation).toEqual({
      command: '/nix/store/node/bin/node',
      args: [
        '/home/kaito/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.75.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        '--mode',
        'json',
        '-p',
      ],
    });
  });

  test('reuses a symlinked wrapper script when it resolves to the pi CLI entrypoint', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pi-ralph-cli-wrapper-'));
    temporaryDirectories.push(temporaryDirectory);
    const realCliPath = path.join(
      temporaryDirectory,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    const wrapperPath = path.join(temporaryDirectory, 'bin', 'acme-pi');

    await mkdir(path.dirname(realCliPath), { recursive: true });
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(realCliPath, '#!/usr/bin/env node\n', 'utf8');
    await symlink(realCliPath, wrapperPath);

    const invocation = getPiInvocation(args, {
      argv: ['/nix/store/node/bin/node', wrapperPath],
      env: {},
      execPath: '/nix/store/node/bin/node',
    });

    expect(invocation).toEqual({
      command: '/nix/store/node/bin/node',
      args: [wrapperPath, '--mode', 'json', '-p'],
    });
  });

  test('falls back to pi when running inside an embedded host process', () => {
    const invocation = getPiInvocation(args, {
      argv: ['/nix/store/node/bin/node', '/Users/kaito/repos/symphony-pi/src/main.ts'],
      env: {},
      execPath: '/nix/store/node/bin/node',
    });

    expect(invocation).toEqual({
      command: 'pi',
      args,
    });
  });

  test('uses an explicit pi command when configured', () => {
    const invocation = getPiInvocation(args, {
      argv: ['/nix/store/node/bin/node', '/Users/kaito/repos/symphony-pi/src/main.ts'],
      env: {
        PI_RALPH_PI_CLI_PATH: '/custom/bin/pi',
      },
      execPath: '/nix/store/node/bin/node',
    });

    expect(invocation).toEqual({
      command: '/custom/bin/pi',
      args,
    });
  });

  test('uses the current executable when already running as the pi binary', () => {
    const invocation = getPiInvocation(args, {
      argv: ['/usr/local/bin/pi'],
      env: {},
      execPath: '/usr/local/bin/pi',
    });

    expect(invocation).toEqual({
      command: '/usr/local/bin/pi',
      args,
    });
  });

  test('uses a symlinked wrapper executable when it resolves to the pi binary', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pi-ralph-bin-wrapper-'));
    temporaryDirectories.push(temporaryDirectory);
    const realExecutablePath = path.join(temporaryDirectory, 'real', 'pi');
    const wrapperPath = path.join(temporaryDirectory, 'bin', 'acme-agent');

    await mkdir(path.dirname(realExecutablePath), { recursive: true });
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(realExecutablePath, '', 'utf8');
    await symlink(realExecutablePath, wrapperPath);

    const invocation = getPiInvocation(args, {
      argv: [wrapperPath],
      env: {},
      execPath: wrapperPath,
    });

    expect(invocation).toEqual({
      command: wrapperPath,
      args,
    });
  });
});
