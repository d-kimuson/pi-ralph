import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    fail('Failed to parse JSON output.');
  }
};

const readPackageJson = (): unknown =>
  parseJson(readFileSync(path.join(root, 'package.json'), 'utf-8'));

const readPackageName = (packageJson: unknown): string => {
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    Array.isArray(packageJson) ||
    !('name' in packageJson) ||
    typeof packageJson.name !== 'string'
  ) {
    fail('package.json must contain a string name.');
  }

  return packageJson.name;
};

const readPiManifest = (packageJson: unknown): void => {
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    Array.isArray(packageJson) ||
    !('pi' in packageJson) ||
    typeof packageJson.pi !== 'object' ||
    packageJson.pi === null ||
    Array.isArray(packageJson.pi)
  ) {
    fail('package.json must contain a pi manifest object.');
  }

  const requiredEntries = {
    extensions: './extensions',
    skills: './skills',
    prompts: './prompts',
    themes: './themes',
  };

  for (const [key, expected] of Object.entries(requiredEntries)) {
    const value = packageJson.pi[key];
    if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) {
      fail(`package.json pi.${key} must be ["${expected}"].`);
    }
  }
};

const listPackFiles = (): readonly string[] => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf-8',
  });
  const parsed = parseJson(output);

  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail('npm pack --dry-run --json must return exactly one package entry.');
  }

  const [entry] = parsed;
  if (
    typeof entry !== 'object' ||
    entry === null ||
    Array.isArray(entry) ||
    !('files' in entry) ||
    !Array.isArray(entry.files)
  ) {
    fail('npm pack output must contain a files array.');
  }

  const files: string[] = [];
  for (const fileEntry of entry.files) {
    if (
      typeof fileEntry !== 'object' ||
      fileEntry === null ||
      Array.isArray(fileEntry) ||
      !('path' in fileEntry) ||
      typeof fileEntry.path !== 'string'
    ) {
      fail('Every npm pack file entry must contain a string path.');
    }
    files.push(fileEntry.path);
  }

  return files;
};

const requireFile = (files: readonly string[], expected: string): void => {
  if (!files.includes(expected)) {
    fail(`Packed package is missing ${expected}.`);
  }
};

const requirePrefix = (files: readonly string[], expectedPrefix: string): void => {
  if (!files.some((file) => file.startsWith(expectedPrefix))) {
    fail(`Packed package is missing files under ${expectedPrefix}.`);
  }
};

const forbiddenPatterns = [/^extensions\/.*\.test\.[^.]+$/u];

const forbiddenPrefixes = ['.agents/', '.github/', 'docs/', 'scripts/', 'node_modules/'];

const packageJson = readPackageJson();
const packageName = readPackageName(packageJson);
readPiManifest(packageJson);

const files = listPackFiles();

requireFile(files, 'package.json');
requireFile(files, 'README.md');
requireFile(files, 'LICENSE');
requirePrefix(files, 'extensions/');
requirePrefix(files, 'prompts/');
requirePrefix(files, 'skills/');
requirePrefix(files, 'src/');
requirePrefix(files, 'themes/');

for (const file of files) {
  const forbidden = forbiddenPrefixes.find((prefix) => file.startsWith(prefix));
  if (forbidden !== undefined) {
    fail(`Packed package must not include ${file} (${forbidden} is release/internal-only).`);
  }

  const forbiddenPattern = forbiddenPatterns.find((pattern) => pattern.test(file));
  if (forbiddenPattern !== undefined) {
    fail(
      `Packed package must not include ${file} (test files under extensions are not runtime extensions).`,
    );
  }
}

console.log(`✓ ${packageName} package shape is publish-ready (${files.length} files).`);
