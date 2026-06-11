import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  RalphLoopMergeCondition,
  RalphLoopParams,
} from '../src/ralph-loop/ralphLoop.service.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RalphLoopCompletion = RalphLoopParams['completion'];
type RalphLoopAutofix = RalphLoopParams['autofix'];

type RalphLoopDefaults = {
  readonly staticChecks: readonly string[];
};

type RalphLoopOptions = RalphLoopDefaults & {
  readonly completion: RalphLoopCompletion;
  readonly autofix: RalphLoopAutofix;
  readonly mergeCondition: RalphLoopMergeCondition;
  readonly review: boolean;
  readonly acceptanceCriteria?: string;
};

const DEFAULT_OPTIONS: RalphLoopDefaults = {
  staticChecks: [],
};

const SAFE_LOW_LEVEL_OPTIONS = {
  completion: 'edit-only',
  autofix: 'none',
  mergeCondition: { enabled: false },
  review: false,
} as const satisfies Omit<RalphLoopOptions, 'staticChecks' | 'acceptanceCriteria'>;

const PRESET_COMMANDS = {
  'ralph-check': {
    notification: 'ralph-check: lightweight verification gate',
    preset: SAFE_LOW_LEVEL_OPTIONS,
  },
  'ralph-pr': {
    notification: 'ralph-pr: draft PR with review, acceptance checks, CI, and comment follow-up',
    preset: {
      completion: 'draft-pr',
      autofix: 'comment',
      mergeCondition: { enabled: false },
      review: true,
    },
  },
  'ralph-delegate': {
    notification: 'ralph-delegate: ready PR with review, acceptance checks, autofix, and merge',
    preset: {
      completion: 'pr',
      autofix: 'comment',
      mergeCondition: { enabled: true, approved: false },
      review: true,
    },
  },
} as const satisfies Record<
  string,
  {
    readonly notification: string;
    readonly preset: Omit<RalphLoopOptions, 'staticChecks' | 'acceptanceCriteria'>;
  }
>;

type PresetCommandName = keyof typeof PRESET_COMMANDS;

// ---------------------------------------------------------------------------
// Default-options file helpers
// ---------------------------------------------------------------------------

const getConfigDir = (cwd: string): string => path.join(cwd, '.pi', 'agent', 'ralph-loop');

const getConfigFile = (cwd: string): string => path.join(getConfigDir(cwd), 'default-options.json');

const readStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => typeof item === 'string');
};

const loadDefaultOptions = (cwd: string): RalphLoopDefaults => {
  const file = getConfigFile(cwd);
  if (!existsSync(file)) {
    return { ...DEFAULT_OPTIONS };
  }

  try {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      staticChecks: readStringArray(parsed['staticChecks']),
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
};

const saveDefaultOptions = (cwd: string, options: RalphLoopDefaults): void => {
  const dir = getConfigDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigFile(cwd), JSON.stringify(options, null, 2) + '\n', 'utf-8');
};

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

const buildPresetMessage = (params: Omit<RalphLoopOptions, 'acceptanceCriteria'>): string => {
  const lines: string[] = ['Preset parameters (use these exactly):'];

  if (params.staticChecks.length > 0) {
    lines.push('  staticChecks:');
    for (const check of params.staticChecks) {
      lines.push(`    - "${check}"`);
    }
  } else {
    lines.push('  staticChecks: []');
  }

  lines.push(`  completion: ${params.completion}`);
  lines.push(`  autofix: ${params.autofix}`);
  lines.push('  mergeCondition:');
  lines.push(`    enabled: ${params.mergeCondition.enabled}`);

  if (params.mergeCondition.enabled) {
    lines.push(`    approved: ${params.mergeCondition.approved}`);
  }

  lines.push(`  review: ${params.review}`);

  return lines.join('\n');
};

const createDisplayedRequirement = (requirement: string): string =>
  requirement.trim() === '' ? '(none — work on the current request)' : requirement;

const sendStructuredConfiguration = (
  pi: ExtensionAPI,
  commandName: string,
  requirement: string,
  params: Omit<RalphLoopOptions, 'acceptanceCriteria'>,
): void => {
  const defaultsDisplay =
    params.staticChecks.length === 0
      ? '[]'
      : params.staticChecks.map((c) => JSON.stringify(c)).join(', ');

  pi.sendUserMessage(
    [
      {
        type: 'text',
        text: [
          `The user invoked /${commandName}.`,
          '',
          `Requirement: ${createDisplayedRequirement(requirement)}`,
          '',
          buildPresetMessage(params),
          '',
          'For the remaining parameters, infer from the requirement:',
          `- staticChecks: include any checks explicitly mentioned in the requirement, plus the repository defaults (${defaultsDisplay}).`,
          '- acceptanceCriteria: derive concrete, verifiable acceptance criteria from the requirement. Focus on behavioral requirements, correctness conditions, and non-deterministic quality aspects. Do NOT include items already covered by staticChecks (e.g. lint, typecheck, test commands). Formulate clear pass/fail conditions.',
          '',
          'Call set-ralph-loop once with the resolved parameters.',
          'Then immediately continue the task work. Do not stop after configuration.',
          'Do not ask the user to confirm.',
        ].join('\n'),
      },
    ],
    { deliverAs: 'followUp' },
  );
};

export const createRalphLoopFollowUpText = (
  requirement: string,
  defaults: RalphLoopDefaults,
): string => {
  const lines = [
    'The user invoked /ralph-loop.',
    'Interpret the request below and resolve one set of set-ralph-loop parameters.',
    'Read both natural-language intent and any CLI-like fragments the user may have included.',
    'Use these safe defaults when the request leaves an option unspecified:',
    '  completion: edit-only',
    '  autofix: none',
    '  mergeCondition:',
    '    enabled: false',
    '  review: false',
    'When the user clearly asks for merge or autofix behavior, you may infer and fill required dependent options such as pull-request completion mode.',
    'Set acceptanceCriteria whenever you can infer concrete acceptance requirements from the request. Focus on behavioral requirements and non-deterministic quality aspects; do not repeat items already covered by staticChecks (e.g. lint, typecheck, test commands). Do not omit acceptanceCriteria casually.',
    'If you genuinely cannot infer meaningful acceptanceCriteria, omission is allowed.',
    'Do not ask the user to confirm. Call set-ralph-loop exactly once with the resolved parameters.',
    'After calling set-ralph-loop, immediately continue the actual task work. Do not stop after configuration.',
    '',
    `Default static checks for this repository: ${defaults.staticChecks.length === 0 ? '[]' : defaults.staticChecks.map((check) => JSON.stringify(check)).join(', ')}`,
    '',
    `Request: ${createDisplayedRequirement(requirement)}`,
  ];

  return lines.join('\n');
};

const sendNaturalLanguageConfigurationRequest = (
  pi: ExtensionAPI,
  requirement: string,
  defaults: RalphLoopDefaults,
): void => {
  pi.sendUserMessage(
    [
      {
        type: 'text',
        text: createRalphLoopFollowUpText(requirement, defaults),
      },
    ],
    { deliverAs: 'followUp' },
  );
};

const patternOptions = (
  defaults: RalphLoopDefaults,
  preset: Omit<RalphLoopOptions, 'staticChecks' | 'acceptanceCriteria'>,
): Omit<RalphLoopOptions, 'acceptanceCriteria'> => ({
  ...preset,
  staticChecks: defaults.staticChecks,
});

export const normalizePresetRequirement = (args: string): string => args;

export const createPresetCommandConfiguration = (
  defaults: RalphLoopDefaults,
  args: string,
  commandName: PresetCommandName,
): {
  readonly notification: string;
  readonly requirement: string;
  readonly params: Omit<RalphLoopOptions, 'acceptanceCriteria'>;
} => {
  const definition = PRESET_COMMANDS[commandName];
  const requirement = normalizePresetRequirement(args);

  return {
    notification: definition.notification,
    requirement,
    params: patternOptions(defaults, definition.preset),
  };
};

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand('ralph-configure', {
    description:
      'Create or update .pi/agent/ralph-loop/default-options.json. Only staticChecks are stored; completion/autofix/merge behavior is chosen per command or tool call.',
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const current = loadDefaultOptions(cwd);

      const staticCheckInput = await ctx.ui.input(
        'Static check commands (one per line):',
        current.staticChecks.join('\n'),
      );

      if (staticCheckInput === undefined) {
        ctx.ui.notify('ralph-configure cancelled.', 'warning');
        return;
      }

      const staticChecks = staticCheckInput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

      saveDefaultOptions(cwd, { staticChecks });
      ctx.ui.notify('Saved staticChecks to .pi/agent/ralph-loop/default-options.json', 'info');
    },
  });

  pi.registerCommand('ralph-loop', {
    description:
      'Natural-language ralph-loop entrypoint. The agent interprets the request, resolves set-ralph-loop parameters, configures them once, and then continues the task work.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);

      ctx.ui.notify(
        'ralph-loop: handing the request to the agent for natural-language configuration',
        'info',
      );
      sendNaturalLanguageConfigurationRequest(pi, args, defaults);
    },
  });

  pi.registerCommand('ralph-check', {
    description:
      'Configure a lightweight verification gate: completion=edit-only, autofix=none, mergeCondition.enabled=false.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-check');

      ctx.ui.notify(configuration.notification, 'info');
      sendStructuredConfiguration(
        pi,
        'ralph-check',
        configuration.requirement,
        configuration.params,
      );
    },
  });

  pi.registerCommand('ralph-pr', {
    description:
      'Configure a delegated draft-PR loop: completion=draft-pr, autofix=comment, mergeCondition.enabled=false, review=true.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-pr');

      ctx.ui.notify(configuration.notification, 'info');
      sendStructuredConfiguration(pi, 'ralph-pr', configuration.requirement, configuration.params);
    },
  });

  pi.registerCommand('ralph-delegate', {
    description:
      'Configure a highly delegated PR loop: completion=pr, autofix=comment, mergeCondition.enabled=true, approved=false, review=true.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-delegate');

      ctx.ui.notify(configuration.notification, 'info');
      sendStructuredConfiguration(
        pi,
        'ralph-delegate',
        configuration.requirement,
        configuration.params,
      );
    },
  });
}
