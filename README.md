# @kimuson/pi-ralph

`@kimuson/pi-ralph` is a pi package for running a configurable **ralph-loop** inside [`pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent).

It is not just a single “run tests before finishing” hook. It is a delivery loop for coding-agent work: static verification, AI review, acceptance/QA checks, pull request automation, CI/comment follow-up, and optional merge automation can be composed into one self-running workflow.

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

### `/ralph-check`

Lightweight verification gate.

Use this when you want ralph-loop to run the configured static checks, and optionally agent-side checks, without touching Git or GitHub delivery.

Preset:

```yaml
completion: edit-only
autofix: none
mergeCondition: none
review: false
qa: false
```

### `/ralph-pr`

Create a draft PR and keep the loop open for higher-confidence delivery checks.

Use this when you want the agent to prepare a PR but not merge it automatically.

Preset:

```yaml
completion: draft-pr
autofix: comment
mergeCondition: none
review: true
qa: true
```

### `/ralph-delegate`

Delegate the whole delivery flow to the agent.

Use this when you want the agent to create a ready PR, fix CI/comment feedback, and merge once the configured follow-up is complete.

Preset:

```yaml
completion: pr
autofix: comment
mergeCondition: fix-completed
review: true
qa: true
```

### `/ralph-loop`

Low-level command for custom combinations.

Use this when the presets are not enough:

```text
/ralph-loop --completion pr --autofix ci --merge approved --review --qa "Implement user login"
```

Common options:

```text
--completion edit-only|draft-pr|pr
--autofix none|ci|comment
--merge none|fix-completed|approved
--review
--qa
--static-check <command>
--acceptance <text>
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

Controls whether ralph-loop should keep the task open for PR feedback.

| Mode      | Behavior                                                        |
| --------- | --------------------------------------------------------------- |
| `none`    | Do not wait for CI or comments                                  |
| `ci`      | Wait for PR CI and keep the loop open for failed/pending checks |
| `comment` | Run CI follow-up, then check unresolved PR comments             |

`autofix` does not magically patch code by itself. It reports the failing CI/comment state back into the agent loop so the agent can continue working until the checks pass.

### Merge condition

Controls whether and when ralph-loop should merge the PR.

| Condition       | Behavior                                                     |
| --------------- | ------------------------------------------------------------ |
| `none`          | Never merge automatically                                    |
| `fix-completed` | Merge after the configured `autofix` checks pass             |
| `approved`      | Wait for PR approval after `autofix` checks pass, then merge |

## Typical workflows

### Run local verification only

```text
/ralph-check "Refactor the parser"
```

### Ask the agent to prepare a draft PR

```text
/ralph-pr "Add password reset flow"
```

### Delegate implementation through merge

```text
/ralph-delegate "Fix the flaky checkout test"
```

### Require approval before merge

```text
/ralph-loop --completion pr --autofix comment --merge approved --review --qa "Implement billing export"
```

## How it works

The package registers pi commands and tools. User-facing commands such as `/ralph-check`, `/ralph-pr`, and `/ralph-delegate` translate presets into a `set-ralph-loop` configuration. Once configured, the loop runs from pi's task-completion lifecycle and sends feedback back into the agent when a phase fails.

Internally, ralph-loop is stateful: passed review and acceptance checks are reused on later retries, while failed static checks, PR checks, CI, comments, or merge conditions keep the task open until the agent fixes them or the loop is explicitly bypassed.

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
