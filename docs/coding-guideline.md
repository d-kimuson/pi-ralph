# Coding Guideline

Design philosophies behind this codebase. Not specific syntax rules — those are enforced by lint.

## Type-Driven Correctness

Maximize what the type checker can catch at compile time.

- Use discriminated unions (ADT) to model domain variants. Each branch carries a literal `type` or `kind` discriminant, enabling exhaustive narrowing via `switch`/`if`.
- Leverage `as const satisfies` to get both literal narrowing and structural constraint checking from a single declaration.
- Prefer `readonly` on all data structure fields. Mutable state should only exist in function-scoped closures when strictly necessary.

## Functional and Immutable Style

No classes. All code is functions operating on plain data.

- Side-effect-free modules are marked with `*.pure.ts` suffix — these contain only pure functions and are the primary unit test targets.
- Service modules (`*.service.ts`) are the boundary where I/O happens.
- Route handlers / entry points are thin orchestrators: validate → convert → call domain → serialize response.

## Collocated Directory Structure

Related files live close together.

- Unit tests (`*.test.ts`) sit next to their source.
- Integration tests sit alongside the entrypoint they exercise.

## Pi Extension Conventions

- Extensions register commands, tools, or hooks via the pi extension API.
- Skills are markdown-based instruction files; keep them focused on a single task domain.
- Prompts are reusable prompt templates in markdown; use variable interpolation where appropriate.
