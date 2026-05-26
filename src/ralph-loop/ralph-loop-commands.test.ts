import { describe, expect, test } from 'vitest';

import {
  createPresetCommandConfiguration,
  normalizePresetRequirement,
  parseRalphLoopArgs,
} from '../../extensions/ralph-loop-commands.ts';

type PresetCommandName = Parameters<typeof createPresetCommandConfiguration>[2];

type PresetCommandCase = {
  readonly commandName: PresetCommandName;
  readonly expectedNotification: string;
  readonly expectedParams: Record<string, unknown>;
};

const presetCommandCases = [
  {
    commandName: 'ralph-check',
    expectedNotification: 'ralph-check: lightweight verification gate',
    expectedParams: {
      staticChecks: ['pnpm typecheck'],
      completion: 'edit-only',
      autofix: 'none',
      mergeCondition: 'none',
      review: false,
      qa: false,
      acceptanceCriteria: undefined,
    },
  },
  {
    commandName: 'ralph-pr',
    expectedNotification: 'ralph-pr: draft PR with review, QA, CI, and comment follow-up',
    expectedParams: {
      staticChecks: ['pnpm typecheck'],
      completion: 'draft-pr',
      autofix: 'comment',
      mergeCondition: 'none',
      review: true,
      qa: true,
      acceptanceCriteria: '  --review ほげほげ機能の実装  ',
    },
  },
  {
    commandName: 'ralph-delegate',
    expectedNotification: 'ralph-delegate: ready PR with review, QA, autofix, and merge',
    expectedParams: {
      staticChecks: ['pnpm typecheck'],
      completion: 'pr',
      autofix: 'comment',
      mergeCondition: 'fix-completed',
      review: true,
      qa: true,
      acceptanceCriteria: '  --review ほげほげ機能の実装  ',
    },
  },
] as const satisfies readonly PresetCommandCase[];

describe('normalizePresetRequirement', () => {
  test('preserves CLI-like text and surrounding whitespace for preset commands', () => {
    expect(normalizePresetRequirement('  --review ほげほげ機能の実装  ')).toBe(
      '  --review ほげほげ機能の実装  ',
    );
  });
});

describe('createPresetCommandConfiguration', () => {
  test.each(presetCommandCases)(
    'treats /$commandName args as raw requirement text',
    ({ commandName, expectedNotification, expectedParams }) => {
      const configuration = createPresetCommandConfiguration(
        { staticChecks: ['pnpm typecheck'] },
        '  --review ほげほげ機能の実装  ',
        commandName,
      );

      expect(configuration.notification).toBe(expectedNotification);
      expect(configuration.requirement).toBe('  --review ほげほげ機能の実装  ');
      expect(configuration.params).toEqual(expectedParams);
    },
  );
});

describe('parseRalphLoopArgs', () => {
  test('keeps strict option parsing for /ralph-loop', () => {
    expect(parseRalphLoopArgs('--review --qa ほげほげ機能の実装')).toEqual({
      staticChecks: [],
      completion: undefined,
      autofix: undefined,
      mergeCondition: undefined,
      review: true,
      qa: true,
      acceptanceCriteria: undefined,
      requirement: 'ほげほげ機能の実装',
    });
  });
});
