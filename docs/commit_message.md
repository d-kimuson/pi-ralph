# Commit Message Convention

Based on [Conventional Commits](https://www.conventionalcommits.org/).

## Format

```
<type>(<scope>): <description>

[optional body]
```

## Types

| Type       | When to use                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature or capability                               |
| `fix`      | Bug fix                                                 |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `chore`    | Build process, tooling, dependencies, CI changes        |
| `docs`     | Documentation only                                      |
| `test`     | Adding or updating tests                                |
| `perf`     | Performance improvement                                 |

## Scope

Optional. Use the module or feature area name.

- Extension module: `feat(ext): ...`
- Skill: `feat(skill): ...`
- Core library: `feat(lib): ...`

## Rules

- Description: imperative mood, lowercase start, no period at end
- Language: English
- Keep the first line under 72 characters
- Use body for "why", not "what" (the diff shows "what")

## Examples

Good:

- `feat(ext): add browser-automation extension`
- `fix: resolve race condition in hook registration`
- `chore: update dependencies`
- `refactor(lib): extract validation to pure function`

Bad:

- `Fixed bug` (no type, vague)
- `feat: Add new feature for the user authentication system` (too long, capitalized)
- `update` (no type, no description)

> Note: this project has no Git history yet. These conventions are defaults and may evolve.
