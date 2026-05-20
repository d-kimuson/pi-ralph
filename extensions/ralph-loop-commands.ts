import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RalphLoopCompletion = 'only-edit' | 'commit' | 'pr' | 'draft-pr';
type RalphLoopMergeCondition = 'none' | 'ci-passed' | 'comment-fixed';

type RalphLoopOptions = {
  readonly staticChecks: readonly string[];
  readonly completion: RalphLoopCompletion;
  readonly mergeCondition: RalphLoopMergeCondition;
  readonly review: boolean;
};

const DEFAULT_OPTIONS: RalphLoopOptions = {
  staticChecks: [],
  completion: 'commit',
  mergeCondition: 'none',
  review: false,
};

// ---------------------------------------------------------------------------
// Default-options file helpers
// ---------------------------------------------------------------------------

const getConfigDir = (cwd: string): string => path.join(cwd, '.pi', 'agent', 'ralph-loop');

const getConfigFile = (cwd: string): string => path.join(getConfigDir(cwd), 'default-options.json');

const loadDefaultOptions = (cwd: string): RalphLoopOptions => {
  const file = getConfigFile(cwd);
  if (!existsSync(file)) {
    return { ...DEFAULT_OPTIONS };
  }
  try {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      staticChecks: Array.isArray(parsed['staticChecks']) ? parsed['staticChecks'] : [],
      completion: validateCompletion(parsed['completion']),
      mergeCondition: validateMergeCondition(parsed['mergeCondition']),
      review: typeof parsed['review'] === 'boolean' ? parsed['review'] : false,
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
};

const saveDefaultOptions = (cwd: string, options: RalphLoopOptions): void => {
  const dir = getConfigDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigFile(cwd), JSON.stringify(options, null, 2) + '\n', 'utf-8');
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const COMPLETION_VALUES: readonly RalphLoopCompletion[] = ['only-edit', 'commit', 'pr', 'draft-pr'];

const MERGE_CONDITION_VALUES: readonly RalphLoopMergeCondition[] = [
  'none',
  'ci-passed',
  'comment-fixed',
];

const isValidCompletion = (value: unknown): value is RalphLoopCompletion =>
  typeof value === 'string' && (COMPLETION_VALUES as readonly string[]).includes(value);

const validateCompletion = (value: unknown): RalphLoopCompletion => {
  if (isValidCompletion(value)) {
    return value;
  }
  return 'commit';
};

const isValidMergeCondition = (value: unknown): value is RalphLoopMergeCondition =>
  typeof value === 'string' && (MERGE_CONDITION_VALUES as readonly string[]).includes(value);

const validateMergeCondition = (value: unknown): RalphLoopMergeCondition => {
  if (isValidMergeCondition(value)) {
    return value;
  }
  return 'none';
};

// ---------------------------------------------------------------------------
// Option description labels
// ---------------------------------------------------------------------------

const COMPLETION_LABELS: Record<RalphLoopCompletion, string> = {
  'only-edit': 'Only edit (no commit, no PR)',
  commit: 'Commit changes when done',
  pr: 'Create a full PR',
  'draft-pr': 'Create a draft PR',
};

const MERGE_LABELS: Record<RalphLoopMergeCondition, string> = {
  none: 'No merge automation',
  'ci-passed': 'Auto-merge when CI passes',
  'comment-fixed': 'Wait for CI + resolve comments, then auto-merge',
};

// ---------------------------------------------------------------------------
// CLI argument parser for /ralph-loop
// ---------------------------------------------------------------------------

type ParsedArgs = {
  staticChecks: string[];
  completion: RalphLoopCompletion | undefined;
  mergeCondition: RalphLoopMergeCondition | undefined;
  review: boolean;
  acceptanceCriteria: string | undefined;
  requirement: string;
};

const parseRalphLoopArgs = (args: string): ParsedArgs => {
  const tokens = tokenize(args);
  const staticChecks: string[] = [];
  let completion: RalphLoopCompletion | undefined;
  let mergeCondition: RalphLoopMergeCondition | undefined;
  let review = false;
  let acceptanceCriteria: string | undefined;
  const positional: string[] = [];

  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];

    if (token === undefined) {
      idx++;
      continue;
    }

    if (token === '--draft-pr') {
      completion = 'draft-pr';
    } else if (token === '--pr') {
      completion = 'pr';
    } else if (token === '--commit') {
      completion = 'commit';
    } else if (token === '--only-edit') {
      completion = 'only-edit';
    } else if (token === '--review') {
      review = true;
    } else if (token === '--ci-passed') {
      mergeCondition = 'ci-passed';
    } else if (token === '--comment-fixed') {
      mergeCondition = 'comment-fixed';
    } else if (token === '--no-merge') {
      mergeCondition = 'none';
    } else if (token === '--static-check' || token === '-c') {
      // Consume the next token as the command
      idx++;
      const nextArg: string | undefined = tokens[idx];
      if (nextArg !== undefined) {
        staticChecks.push(nextArg);
      }
    } else if (token === '--acceptance' || token === '--ac') {
      idx++;
      const acToken: string | undefined = tokens[idx];
      if (acToken !== undefined) {
        acceptanceCriteria = acToken;
      }
    } else if (token.startsWith('--static-check=')) {
      const checkValue: string = token.slice('--static-check='.length);
      if (checkValue !== '') {
        staticChecks.push(checkValue);
      }
    } else if (token.startsWith('--acceptance=')) {
      const acValue: string = token.slice('--acceptance='.length);
      if (acValue !== '') {
        acceptanceCriteria = acValue;
      }
    } else if (token.startsWith('--ac=')) {
      const acValue: string = token.slice('--ac='.length);
      if (acValue !== '') {
        acceptanceCriteria = acValue;
      }
    } else {
      positional.push(token);
    }

    idx++;
  }

  return {
    staticChecks,
    completion,
    mergeCondition,
    review,
    acceptanceCriteria,
    requirement: positional.join(' '),
  };
};

// ---------------------------------------------------------------------------
// Select value parsing (select returns "value — label" strings)
// ---------------------------------------------------------------------------

const parseSelectValue = (selected: string): string => {
  const dashIndex = selected.indexOf(' — ');
  return dashIndex >= 0 ? selected.slice(0, dashIndex) : selected;
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
// Merging logic
// ---------------------------------------------------------------------------

const mergeWithDefaults = (
  defaults: RalphLoopOptions,
  parsed: ParsedArgs,
  requirement: string,
): {
  readonly params: {
    readonly staticChecks: readonly string[];
    readonly completion: RalphLoopCompletion;
    readonly mergeCondition: RalphLoopMergeCondition;
    readonly review: boolean;
    readonly acceptanceCriteria?: string;
  };
  readonly requirement: string;
} => {
  const staticChecks = parsed.staticChecks.length > 0 ? parsed.staticChecks : defaults.staticChecks;
  const completion = parsed.completion ?? defaults.completion;
  const mergeCondition = parsed.mergeCondition ?? defaults.mergeCondition;

  // If acceptance criteria is explicitly provided via CLI, use it.
  // Otherwise, if a requirement text is present, use that.
  const acceptanceCriteria =
    parsed.acceptanceCriteria ?? (requirement.trim() !== '' ? requirement : undefined);

  return {
    params: {
      staticChecks,
      completion,
      mergeCondition,
      review: parsed.review || defaults.review,
      acceptanceCriteria,
    },
    requirement,
  };
};

// ---------------------------------------------------------------------------
// Build the message that wraps set-ralph-loop
// ---------------------------------------------------------------------------

const buildSetRalphLoopMessage = (params: RalphLoopOptions): string => {
  const lines: string[] = ['set-ralph-loop:'];

  // Static checks
  if (params.staticChecks.length > 0) {
    lines.push('  staticChecks:');
    for (const check of params.staticChecks) {
      lines.push(`    - "${check}"`);
    }
  } else {
    lines.push('  staticChecks: []');
  }

  // Completion
  lines.push(`  completion: ${params.completion}`);
  lines.push(`  mergeCondition: ${params.mergeCondition}`);
  lines.push(`  review: ${params.review}`);

  lines.push('');
  lines.push('Call set-ralph-loop once with these parameters to configure done criteria.');

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // =========================================================================
  // /ralph-configure
  // =========================================================================
  pi.registerCommand('ralph-configure', {
    description:
      'Create or update .pi/agent/ralph-loop/default-options.json interactively. Run this once to set your preferred defaults for /ralph-loop.',
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const current = loadDefaultOptions(cwd);

      ctx.ui.notify(
        'Configuring ralph-loop defaults. This sets the default-options.json that /ralph-loop uses.',
        'info',
      );

      // --- completion ---
      const completionChoiceValue = await ctx.ui.select(
        'Default completion policy:',
        COMPLETION_VALUES.map((v) => `${v} — ${COMPLETION_LABELS[v]}`),
      );

      if (completionChoiceValue === undefined) {
        ctx.ui.notify('ralph-configure cancelled.', 'warning');
        return;
      }

      const completion = parseSelectValue(completionChoiceValue);

      if (!isValidCompletion(completion)) {
        ctx.ui.notify('ralph-configure: invalid completion value.', 'warning');
        return;
      }

      // --- merge condition ---
      // Only offer merge conditions that are valid with the chosen completion
      const availableMergeConditions: readonly RalphLoopMergeCondition[] =
        completion === 'pr' || completion === 'draft-pr'
          ? ['none', 'ci-passed', 'comment-fixed']
          : ['none'];

      const mergeChoiceValue = await ctx.ui.select(
        'Default merge condition:',
        availableMergeConditions.map((v) => `${v} — ${MERGE_LABELS[v]}`),
      );

      if (mergeChoiceValue === undefined) {
        ctx.ui.notify('ralph-configure cancelled.', 'warning');
        return;
      }

      const mergeCondition = parseSelectValue(mergeChoiceValue);

      if (!isValidMergeCondition(mergeCondition)) {
        ctx.ui.notify('ralph-configure: invalid merge condition value.', 'warning');
        return;
      }

      // --- review ---
      const reviewResult = await ctx.ui.confirm(
        'Enable agent review by default?',
        current.review ? 'Yes (currently enabled)' : 'No (currently disabled)',
      );

      if (reviewResult === undefined) {
        ctx.ui.notify('ralph-configure cancelled.', 'warning');
        return;
      }

      const review = reviewResult;

      // --- static checks ---
      // Input multi-line
      let staticChecks: readonly string[] = current.staticChecks;
      const staticCheckInput = await ctx.ui.input(
        'Static check commands (one per line, empty = keep current):',
        current.staticChecks.join('\n'),
      );

      if (staticCheckInput === undefined) {
        ctx.ui.notify('ralph-configure cancelled.', 'warning');
        return;
      }

      const trimmedInput = staticCheckInput.trim();
      if (trimmedInput !== '') {
        staticChecks = trimmedInput
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
      }

      const options: RalphLoopOptions = {
        staticChecks,
        completion: completion,
        mergeCondition: mergeCondition,
        review,
      };

      saveDefaultOptions(cwd, options);
      ctx.ui.notify('Saved default options to .pi/agent/ralph-loop/default-options.json', 'info');
    },
  });

  // =========================================================================
  // /ralph-loop
  // =========================================================================
  pi.registerCommand('ralph-loop', {
    description:
      'Configure set-ralph-loop with CLI-like arguments. Merges with default-options.json.\n\n' +
      'Usage: /ralph-loop [options] <requirement>\n\n' +
      'Options:\n' +
      '  --draft-pr                Create a draft PR on completion\n' +
      '  --pr                      Create a PR on completion\n' +
      '  --commit                  Commit on completion (default)\n' +
      '  --only-edit               Only edit, no commit or PR\n' +
      '  --review                  Enable agent review\n' +
      '  --ci-passed               Auto-merge when CI passes\n' +
      '  --comment-fixed           Wait for CI + resolve comments, then merge\n' +
      '  --no-merge                No merge automation\n' +
      '  --static-check <cmd>      Add a static check command (repeatable)\n' +
      '  --static-check=<cmd>      Same, using = syntax\n' +
      '  --acceptance <text>       Acceptance criteria text\n' +
      '  --acceptance=<text>       Same, using = syntax\n' +
      '  -c <cmd>                  Shorthand for --static-check\n\n' +
      'Examples:\n' +
      '  /ralph-loop --draft-pr --ci-passed "Implement user login"\n' +
      '  /ralph-loop --pr --review --static-check "pnpm test" "Fix the bug"\n' +
      '  /ralph-loop --commit "Refactor database layer"',
    // eslint-disable-next-line @typescript-eslint/require-await -- handler signature requires Promise<void>
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const defaults = loadDefaultOptions(cwd);
      const parsed = parseRalphLoopArgs(args);
      const merged = mergeWithDefaults(defaults, parsed, parsed.requirement);

      const message = buildSetRalphLoopMessage(merged.params);

      ctx.ui.notify(
        `ralph-loop: completion=${merged.params.completion}, mergeCondition=${merged.params.mergeCondition}, review=${merged.params.review}`,
        'info',
      );

      // Show the generated set-ralph-loop configuration message to the agent
      // This tells the agent to call set-ralph-loop with these parameters.
      pi.sendUserMessage(
        [
          {
            type: 'text',
            text: [
              'The user invoked /ralph-loop. Configure the task using set-ralph-loop once with the following parameters.',
              '',
              `Requirement: ${merged.requirement || '(none — work on the current request)'}`,
              '',
              message,
              '',
              'Do not ask the user to confirm. Call set-ralph-loop now with these exact parameters.',
            ].join('\n'),
          },
        ],
        { deliverAs: 'followUp' },
      );
    },
  });
}
