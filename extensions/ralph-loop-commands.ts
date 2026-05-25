import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RalphLoopCompletion = 'edit-only' | 'draft-pr' | 'pr';
type RalphLoopAutofix = 'none' | 'ci' | 'comment';
type RalphLoopMergeCondition = 'none' | 'fix-completed' | 'approved';

type RalphLoopDefaults = {
  readonly staticChecks: readonly string[];
};

type RalphLoopOptions = RalphLoopDefaults & {
  readonly completion: RalphLoopCompletion;
  readonly autofix: RalphLoopAutofix;
  readonly mergeCondition: RalphLoopMergeCondition;
  readonly review: boolean;
  readonly qa: boolean;
  readonly acceptanceCriteria?: string;
};

const DEFAULT_OPTIONS: RalphLoopDefaults = {
  staticChecks: [],
};

const SAFE_LOW_LEVEL_OPTIONS = {
  completion: 'edit-only',
  autofix: 'none',
  mergeCondition: 'none',
  review: false,
  qa: false,
} as const satisfies Omit<RalphLoopOptions, 'staticChecks' | 'acceptanceCriteria'>;

const PRESET_COMMANDS = {
  'ralph-check': {
    notification: 'ralph-check: lightweight verification gate',
    preset: SAFE_LOW_LEVEL_OPTIONS,
  },
  'ralph-pr': {
    notification: 'ralph-pr: draft PR with review, QA, CI, and comment follow-up',
    preset: {
      completion: 'draft-pr',
      autofix: 'comment',
      mergeCondition: 'none',
      review: true,
      qa: true,
    },
  },
  'ralph-delegate': {
    notification: 'ralph-delegate: ready PR with review, QA, autofix, and merge',
    preset: {
      completion: 'pr',
      autofix: 'comment',
      mergeCondition: 'fix-completed',
      review: true,
      qa: true,
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
// Validation helpers
// ---------------------------------------------------------------------------

const COMPLETION_VALUES: readonly RalphLoopCompletion[] = ['edit-only', 'draft-pr', 'pr'];
const AUTOFIX_VALUES: readonly RalphLoopAutofix[] = ['none', 'ci', 'comment'];
const MERGE_CONDITION_VALUES: readonly RalphLoopMergeCondition[] = [
  'none',
  'fix-completed',
  'approved',
];

const isValidCompletion = (value: unknown): value is RalphLoopCompletion =>
  typeof value === 'string' && (COMPLETION_VALUES as readonly string[]).includes(value);

const isValidAutofix = (value: unknown): value is RalphLoopAutofix =>
  typeof value === 'string' && (AUTOFIX_VALUES as readonly string[]).includes(value);

const isValidMergeCondition = (value: unknown): value is RalphLoopMergeCondition =>
  typeof value === 'string' && (MERGE_CONDITION_VALUES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// CLI argument parser for /ralph-loop
// ---------------------------------------------------------------------------

type ParsedArgs = {
  readonly staticChecks: readonly string[];
  readonly completion: RalphLoopCompletion | undefined;
  readonly autofix: RalphLoopAutofix | undefined;
  readonly mergeCondition: RalphLoopMergeCondition | undefined;
  readonly review: boolean;
  readonly qa: boolean;
  readonly acceptanceCriteria: string | undefined;
  readonly requirement: string;
};

const readNextToken = (tokens: readonly string[], index: number): string | undefined =>
  tokens[index + 1];

export const parseRalphLoopArgs = (args: string): ParsedArgs => {
  const tokens = tokenize(args);
  const staticChecks: string[] = [];
  let completion: RalphLoopCompletion | undefined;
  let autofix: RalphLoopAutofix | undefined;
  let mergeCondition: RalphLoopMergeCondition | undefined;
  let review = false;
  let qa = false;
  let acceptanceCriteria: string | undefined;
  const positional: string[] = [];

  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];

    if (token === undefined) {
      idx++;
      continue;
    }

    if (token === '--edit-only' || token === '--only-edit' || token === '--commit') {
      completion = 'edit-only';
    } else if (token === '--draft-pr') {
      completion = 'draft-pr';
    } else if (token === '--pr') {
      completion = 'pr';
    } else if (token === '--review') {
      review = true;
    } else if (token === '--qa') {
      qa = true;
    } else if (token === '--ci-passed') {
      autofix = 'ci';
      mergeCondition = 'fix-completed';
    } else if (token === '--comment-fixed') {
      autofix = 'comment';
      mergeCondition = 'fix-completed';
    } else if (token === '--no-merge') {
      mergeCondition = 'none';
    } else if (token === '--autofix') {
      const value = readNextToken(tokens, idx);
      if (isValidAutofix(value)) {
        autofix = value;
        idx++;
      }
    } else if (token.startsWith('--autofix=')) {
      const value = token.slice('--autofix='.length);
      if (isValidAutofix(value)) {
        autofix = value;
      }
    } else if (token === '--merge') {
      const value = readNextToken(tokens, idx);
      if (isValidMergeCondition(value)) {
        mergeCondition = value;
        idx++;
      }
    } else if (token.startsWith('--merge=')) {
      const value = token.slice('--merge='.length);
      if (isValidMergeCondition(value)) {
        mergeCondition = value;
      }
    } else if (token === '--completion') {
      const value = readNextToken(tokens, idx);
      if (isValidCompletion(value)) {
        completion = value;
        idx++;
      }
    } else if (token.startsWith('--completion=')) {
      const value = token.slice('--completion='.length);
      if (isValidCompletion(value)) {
        completion = value;
      }
    } else if (token === '--static-check' || token === '-c') {
      const nextArg = readNextToken(tokens, idx);
      if (nextArg !== undefined) {
        staticChecks.push(nextArg);
        idx++;
      }
    } else if (token.startsWith('--static-check=')) {
      const checkValue = token.slice('--static-check='.length);
      if (checkValue !== '') {
        staticChecks.push(checkValue);
      }
    } else if (token === '--acceptance' || token === '--ac') {
      const acToken = readNextToken(tokens, idx);
      if (acToken !== undefined) {
        acceptanceCriteria = acToken;
        qa = true;
        idx++;
      }
    } else if (token.startsWith('--acceptance=')) {
      const acValue = token.slice('--acceptance='.length);
      if (acValue !== '') {
        acceptanceCriteria = acValue;
        qa = true;
      }
    } else if (token.startsWith('--ac=')) {
      const acValue = token.slice('--ac='.length);
      if (acValue !== '') {
        acceptanceCriteria = acValue;
        qa = true;
      }
    } else {
      positional.push(token);
    }

    idx++;
  }

  return {
    staticChecks,
    completion,
    autofix,
    mergeCondition,
    review,
    qa,
    acceptanceCriteria,
    requirement: positional.join(' '),
  };
};

// ---------------------------------------------------------------------------
// Tokenizer for /ralph-loop CLI-style args
// ---------------------------------------------------------------------------

const tokenize = (input: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (const ch of input) {
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current !== '') {
    tokens.push(current);
  }

  return tokens;
};

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

const buildAcceptanceCriteria = (
  qa: boolean,
  requirement: string,
  explicitAcceptanceCriteria: string | undefined,
): string | undefined => {
  if (explicitAcceptanceCriteria !== undefined) {
    return explicitAcceptanceCriteria;
  }

  if (!qa) {
    return undefined;
  }

  return requirement.trim() === ''
    ? 'Verify that the requested task is complete and user-visible behavior is acceptable.'
    : requirement;
};

const buildSetRalphLoopMessage = (params: RalphLoopOptions): string => {
  const lines: string[] = ['set-ralph-loop:'];

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
  lines.push(`  mergeCondition: ${params.mergeCondition}`);
  lines.push(`  review: ${params.review}`);

  if (params.acceptanceCriteria !== undefined) {
    lines.push('  acceptanceCriteria: |');
    for (const line of params.acceptanceCriteria.split('\n')) {
      lines.push(`    ${line}`);
    }
  }

  lines.push('');
  lines.push('Call set-ralph-loop once with these exact parameters to configure done criteria.');

  return lines.join('\n');
};

const mergeLowLevelOptions = (
  defaults: RalphLoopDefaults,
  parsed: ParsedArgs,
): RalphLoopOptions => {
  const requirement = parsed.requirement;
  const qa = parsed.qa;

  return {
    staticChecks: parsed.staticChecks.length > 0 ? parsed.staticChecks : defaults.staticChecks,
    completion: parsed.completion ?? SAFE_LOW_LEVEL_OPTIONS.completion,
    autofix: parsed.autofix ?? SAFE_LOW_LEVEL_OPTIONS.autofix,
    mergeCondition: parsed.mergeCondition ?? SAFE_LOW_LEVEL_OPTIONS.mergeCondition,
    review: parsed.review || SAFE_LOW_LEVEL_OPTIONS.review,
    qa,
    acceptanceCriteria: buildAcceptanceCriteria(qa, requirement, parsed.acceptanceCriteria),
  };
};

const sendRalphLoopConfiguration = (
  pi: ExtensionAPI,
  commandName: string,
  requirement: string,
  params: RalphLoopOptions,
): void => {
  const message = buildSetRalphLoopMessage(params);

  const displayedRequirement =
    requirement.trim() === '' ? '(none — work on the current request)' : requirement;

  pi.sendUserMessage(
    [
      {
        type: 'text',
        text: [
          `The user invoked /${commandName}. Configure the task using set-ralph-loop once with the following parameters.`,
          '',
          `Requirement: ${displayedRequirement}`,
          '',
          message,
          '',
          'Do not ask the user to confirm. Call set-ralph-loop now with these exact parameters.',
        ].join('\n'),
      },
    ],
    { deliverAs: 'followUp' },
  );
};

const patternOptions = (
  defaults: RalphLoopDefaults,
  requirement: string,
  preset: Omit<RalphLoopOptions, 'staticChecks' | 'acceptanceCriteria'>,
): RalphLoopOptions => ({
  ...preset,
  staticChecks: defaults.staticChecks,
  acceptanceCriteria: buildAcceptanceCriteria(preset.qa, requirement, undefined),
});

export const normalizePresetRequirement = (args: string): string => args;

export const createPresetCommandConfiguration = (
  defaults: RalphLoopDefaults,
  args: string,
  commandName: PresetCommandName,
): {
  readonly notification: string;
  readonly requirement: string;
  readonly params: RalphLoopOptions;
} => {
  const definition = PRESET_COMMANDS[commandName];
  const requirement = normalizePresetRequirement(args);

  return {
    notification: definition.notification,
    requirement,
    params: patternOptions(defaults, requirement, definition.preset),
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
      'Low-level ralph-loop API. Usage: /ralph-loop [--completion edit-only|draft-pr|pr] [--autofix none|ci|comment] [--merge none|fix-completed|approved] [--review] [--qa] [--static-check <cmd>] [--acceptance <text>] <requirement>',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const parsed = parseRalphLoopArgs(args);
      const params = mergeLowLevelOptions(defaults, parsed);

      ctx.ui.notify(
        `ralph-loop: completion=${params.completion}, autofix=${params.autofix}, mergeCondition=${params.mergeCondition}, review=${params.review}, qa=${params.qa}`,
        'info',
      );

      sendRalphLoopConfiguration(pi, 'ralph-loop', parsed.requirement, params);
    },
  });

  pi.registerCommand('ralph-check', {
    description:
      'Configure a lightweight verification gate: completion=edit-only, autofix=none, mergeCondition=none.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-check');

      ctx.ui.notify(configuration.notification, 'info');
      sendRalphLoopConfiguration(
        pi,
        'ralph-check',
        configuration.requirement,
        configuration.params,
      );
    },
  });

  pi.registerCommand('ralph-pr', {
    description:
      'Configure a delegated draft-PR loop: completion=draft-pr, autofix=comment, mergeCondition=none, review=true, qa=true.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-pr');

      ctx.ui.notify(configuration.notification, 'info');
      sendRalphLoopConfiguration(pi, 'ralph-pr', configuration.requirement, configuration.params);
    },
  });

  pi.registerCommand('ralph-delegate', {
    description:
      'Configure a highly delegated PR loop: completion=pr, autofix=comment, mergeCondition=fix-completed, review=true, qa=true.',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const defaults = loadDefaultOptions(ctx.cwd);
      const configuration = createPresetCommandConfiguration(defaults, args, 'ralph-delegate');

      ctx.ui.notify(configuration.notification, 'info');
      sendRalphLoopConfiguration(
        pi,
        'ralph-delegate',
        configuration.requirement,
        configuration.params,
      );
    },
  });
}
