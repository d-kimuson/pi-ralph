# @kimuson/pi-ralph

A pi package that provides the **ralph-loop** extension — automated task completion checks with static verification, agent-based review, PR automation, and CI-aware merge gating for pi coding agent sessions.

## Features

- **Static checks**: Run arbitrary shell commands as done-criteria (e.g., type checking, linting, gate checks).
- **Agent review**: Optional sub-agent reviews your work and accepts or rejects it.
- **Acceptance criteria**: Optional natural-language criteria verified by an agent.
- **Completion automation**: Automatically create or update PRs (`pr` / `draft-pr`) after checks pass.
- **Merge gating**: Wait for CI to pass and auto-merge with `ci-passed`.
- **Stateful retry**: Failed checks don't restart passed ones — review and acceptance criteria results are reused across retries.

## Installation

```bash
pi pkg install @kimuson/pi-ralph
```

## Usage

Call `set-ralph-loop` once at the start of a task to configure completion conditions:

```
set-ralph-loop
  staticChecks: ["pnpm typecheck", "pnpm test"]
  completion: pr
  mergeCondition: ci-passed
```

After configuration, the checks run automatically when the task tries to finish. The task stays open until all checks pass.

### Completion modes

| Mode        | Behavior                                                  |
| ----------- | --------------------------------------------------------- |
| `only-edit` | No git checks — just static checks and optional review/AC |
| `commit`    | Requires clean working tree (no uncommitted changes)      |
| `pr`        | Commit checks + creates a ready-for-review PR via `gh`    |
| `draft-pr`  | Commit checks + creates a draft PR via `gh`               |

### Merge conditions

| Condition   | Behavior                                                   |
| ----------- | ---------------------------------------------------------- |
| `none`      | No merge automation                                        |
| `ci-passed` | Wait for CI to pass on the PR, then auto-merge and cleanup |

## Package Structure

```
@kimuson/pi-ralph/
├── extensions/            # pi extensions (auto-discovered)
│   └── set-ralph-loop.ts
├── src/ralph-loop/        # Core service modules
│   ├── ralphLoop.service.ts           # Main loop orchestrator
│   ├── ralphLoopConfig.service.ts     # Validation & guidance
│   ├── activeLoop.service.ts          # Loop state management
│   ├── agentCheckRunner.service.ts    # Agent review/AC execution
│   ├── decisionAgentRunner.service.ts # Shared sub-agent runner
│   ├── completionAutomationRunner.service.ts  # PR automation agent
│   ├── completionAutomationTool.extension.ts  # PR automation tool def
│   ├── pullRequestTemplate.service.ts  # PR template loader
│   ├── reviewTool.extension.ts         # Review tool definition
│   └── *.test.ts                       # Tests
├── skills/                # pi skills
├── prompts/               # pi prompt templates
└── themes/                # pi themes
```

## Development

```bash
pnpm typecheck    # TypeScript type checking
pnpm test         # Run tests
pnpm lint         # Lint & format check
pnpm gatecheck check  # Run all commit gates
```

## Release

See [docs/release.md](docs/release.md) for the complete release process.

```bash
pnpm release      # Interactive release (bump, commit, tag, push)
```

The release uses npm trusted publishing (provenance) via GitHub Actions.

## License

MIT
