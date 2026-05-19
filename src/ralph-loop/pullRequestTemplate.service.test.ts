import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { loadPullRequestTemplate } from './pullRequestTemplate.service.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await import('node:fs/promises').then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }),
  );
});

describe('loadPullRequestTemplate', () => {
  test('loads .github/pull_request_template.md from the git top level when it exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ralph-loop-pr-template-'));
    directories.push(root);
    const templateDirectory = path.join(root, '.github');
    const templatePath = path.join(templateDirectory, 'pull_request_template.md');

    await mkdir(templateDirectory, { recursive: true });
    await writeFile(templatePath, '## Summary\n\n- item', 'utf8');

    const template = await loadPullRequestTemplate(
      () =>
        Promise.resolve({
          code: 0,
          stdout: `${root}\n`,
          stderr: '',
        }),
      root,
      undefined,
    );

    expect(template).toEqual({
      path: templatePath,
      content: '## Summary\n\n- item',
    });
  });

  test('returns undefined when the repository does not define the template file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ralph-loop-pr-template-'));
    directories.push(root);

    const template = await loadPullRequestTemplate(
      () =>
        Promise.resolve({
          code: 0,
          stdout: `${root}\n`,
          stderr: '',
        }),
      root,
      undefined,
    );

    expect(template).toBeUndefined();
  });
});
