import { describe, expect, test } from 'vitest';

import {
  createPresetCommandConfiguration,
  createRalphLoopFollowUpText,
  normalizePresetRequirement,
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
      mergeCondition: {
        enabled: false,
      },
      review: false,
      acceptanceCriteria: '  --review ほげほげ機能の実装  ',
    },
  },
  {
    commandName: 'ralph-pr',
    expectedNotification:
      'ralph-pr: draft PR with review, acceptance checks, CI, and comment follow-up',
    expectedParams: {
      staticChecks: ['pnpm typecheck'],
      completion: 'draft-pr',
      autofix: 'comment',
      mergeCondition: {
        enabled: false,
      },
      review: true,
      acceptanceCriteria: '  --review ほげほげ機能の実装  ',
    },
  },
  {
    commandName: 'ralph-delegate',
    expectedNotification:
      'ralph-delegate: ready PR with review, acceptance checks, autofix, and merge',
    expectedParams: {
      staticChecks: ['pnpm typecheck'],
      completion: 'pr',
      autofix: 'comment',
      mergeCondition: {
        enabled: true,
        approved: false,
      },
      review: true,
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

describe('createRalphLoopFollowUpText', () => {
  test('builds a natural-language handoff for /ralph-loop', () => {
    expect(
      createRalphLoopFollowUpText('--merge approved ほげほげ機能の実装', {
        staticChecks: ['pnpm typecheck', 'pnpm test'],
      }),
    ).toContain('Interpret the request below and resolve one set of set-ralph-loop parameters.');
    expect(
      createRalphLoopFollowUpText('--merge approved ほげほげ機能の実装', {
        staticChecks: ['pnpm typecheck', 'pnpm test'],
      }),
    ).toContain('Do not stop after configuration.');
    expect(
      createRalphLoopFollowUpText('--merge approved ほげほげ機能の実装', {
        staticChecks: ['pnpm typecheck', 'pnpm test'],
      }),
    ).toContain('Request: --merge approved ほげほげ機能の実装');
  });
});
