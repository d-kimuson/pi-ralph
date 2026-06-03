# @kimuson/pi-ralph

`@kimuson/pi-ralph` is a pi package for running a configurable **ralph-loop** inside [`pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent).

It is not just a single “run tests before finishing” hook. It is a delivery loop for coding-agent work: static verification, AI review, acceptance checks, pull request automation, CI/comment follow-up, and optional merge automation can be composed into one self-running workflow.

The goal is to let an agent continue from implementation to GitHub delivery without repeatedly blocking on a human for routine verification steps.

## What ralph-loop does

A ralph-loop can run the following phases in order:

1. **Static checks** — project-defined commands such as `pnpm typecheck`, `pnpm test`, or `pnpm gatecheck check`.
2. **AI checks** — optional agent review and natural-language acceptance criteria checks.
3. **Completion** — stop at edits only, create/update a draft PR, or create/update a ready PR.
4. **PR follow-up** — optionally wait for CI and keep the task open for the agent to fix failed checks and unresolved PR comments.
5. **Merge** — optionally merge after follow-up completes, or wait for approval before merging.

Passed AI checks are cached across retries, so the loop can focus on the failing phase instead of restarting everything from scratch.

## Setup

Install the package into pi:

```bash
pi install npm:@kimuson/pi-ralph
```

Then configure the default static checks for the repository:

```text
/ralph-configure
```

`/ralph-configure` stores only `staticChecks` in `.pi/agent/ralph-loop/default-options.json`. Delivery behavior such as PR creation, CI/comment follow-up, and merge automation is selected per command.

For GitHub PR, CI, comment, or merge workflows, the repository must be usable with the GitHub CLI (`gh`) in the current environment.

## Main commands

Preset commands (`/ralph-check`, `/ralph-pr`, `/ralph-delegate`) treat all trailing text as freeform requirement text and forward it to the agent without CLI-style option parsing.

`/ralph-loop` is also freeform now, but unlike the presets it does **not** hardcode the final `set-ralph-loop` payload. Instead, it asks the agent to interpret the request, resolve safe defaults, call `set-ralph-loop` once, and then continue the actual task work.

### `/ralph-check`

Lightweight verification gate.

Use this when you want ralph-loop to run the configured static checks, and optionally agent-side checks, without touching Git or GitHub delivery.

Trailing text is forwarded as the requirement without option parsing.

Preset:

```yaml
completion: edit-only
autofix: none
mergeCondition:
  enabled: false
review: false
```

### `/ralph-pr`

Create a draft PR and keep the loop open for higher-confidence delivery checks.

Use this when you want the agent to prepare a PR but not merge it automatically.

Trailing text is forwarded as the requirement without option parsing.

Preset:

```yaml
completion: draft-pr
autofix: comment
mergeCondition:
  enabled: false
review: true
acceptanceCriteria: inferred from the requirement when possible
```

### `/ralph-delegate`

Delegate the whole delivery flow to the agent.

Use this when you want the agent to create a ready PR, fix CI/comment feedback, and merge once the configured follow-up is complete.

Trailing text is forwarded as the requirement without option parsing.

Preset:

```yaml
completion: pr
autofix: comment
mergeCondition:
  enabled: true
  approved: false
review: true
acceptanceCriteria: inferred from the requirement when possible
```

### `/ralph-loop`

Natural-language entrypoint for custom combinations.

Use this when the presets are not enough:

```text
/ralph-loop After CI passes and PR approval is present, merge automatically. Review the code too.
```

`/ralph-loop` may still receive old CLI-like text such as `--autofix comment --merge approved`, but that text is no longer machine-parsed by the command itself. The agent reads the request, infers structured parameters, calls `set-ralph-loop` once, and keeps working.

Safe defaults for unspecified settings:

```yaml
completion: edit-only
autofix: none
mergeCondition:
  enabled: false
review: false
```

## Option model

### Completion

Controls what artifact ralph-loop should produce after static and AI checks pass.

| Mode        | Behavior                                                    |
| ----------- | ----------------------------------------------------------- |
| `edit-only` | Do not commit or create a PR                                |
| `draft-pr`  | Require a clean commit state, then create/update a draft PR |
| `pr`        | Require a clean commit state, then create/update a ready PR |

### Autofix

Controls how ralph-loop should keep the task open for PR feedback.

| Mode      | Behavior                                                                |
| --------- | ----------------------------------------------------------------------- |
| `none`    | Do not perform PR follow-up                                             |
| `ci`      | Reopen the task when PR CI is unresolved so the agent can fix it        |
| `comment` | Handle PR CI first when present, then reopen for unresolved PR comments |

`autofix` does not magically patch code by itself. It reports failing CI/comment state back into the agent loop so the agent can continue working until the checks pass.

If no CI checks exist, `autofix: ci` becomes a no-op and `autofix: comment` may still proceed to comment follow-up.

### Merge condition

Controls whether and when ralph-loop should merge the PR.

```yaml
mergeCondition:
  enabled: false
```

Never merge automatically.

```yaml
mergeCondition:
  enabled: true
  approved: false
```

Merge automatically after the configured `autofix` flow completes.

```yaml
mergeCondition:
  enabled: true
  approved: true
```

Wait for GitHub PR approval after the configured `autofix` flow completes, then merge.

When `completion: draft-pr` is combined with `mergeCondition.enabled: true`, ralph-loop automatically marks the draft PR as **Ready for review** before waiting for approval or merging.

## Typical workflows

### Run local verification only

```text
/ralph-check Refactor the parser
```

### Ask the agent to prepare a draft PR

```text
/ralph-pr Add password reset flow
```

### Delegate implementation through merge

```text
/ralph-delegate Fix the flaky checkout test
```

### Require approval before merge

```text
/ralph-loop After comment follow-up and PR approval, merge the PR automatically. Review the implementation too.
```

## How it works

The package registers pi commands and tools. User-facing preset commands such as `/ralph-check`, `/ralph-pr`, and `/ralph-delegate` translate presets into an exact `set-ralph-loop` configuration while forwarding their trailing text to the agent as freeform requirement text. `/ralph-loop` now sends a natural-language handoff that asks the agent to interpret the request, resolve safe defaults and dependencies, call `set-ralph-loop` once, and then continue the actual task work.

Internally, ralph-loop is stateful: passed review and acceptance checks are reused on later retries, while failed static checks, PR checks, autofix follow-up, or merge conditions keep the task open until the agent fixes them or the loop is explicitly bypassed.

The internal review/completion agents relaunch the `pi` CLI. If you run pi-ralph inside an embedded SDK host and need to force a specific CLI path, set `PI_RALPH_PI_CLI_PATH=/absolute/path/to/pi`.

## Development

```bash
pnpm typecheck        # TypeScript type checking
pnpm test             # Run tests
pnpm lint             # Lint & format check
pnpm gatecheck check  # Run all commit gates
```

## Release

See [docs/release.md](docs/release.md) for the complete release process.

```bash
pnpm release # Interactive release (bump, commit, tag, push)
```

The release uses npm trusted publishing (provenance) via GitHub Actions.

## License

MIT
