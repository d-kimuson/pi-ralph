# AGENTS.md (pi-ralph)

## Architecture

pi-ralph is a pi package that bundles extensions, skills, prompts, and themes for the pi coding agent. Resources are auto-discovered through convention directories and declared in the `pi` manifest.

```
package.json (pi manifest)
  ├── extensions/    (.ts/.js — pi extension modules)
  ├── skills/        (SKILL.md — task-specific skill instructions)
  ├── prompts/       (.md — prompt templates)
  └── themes/        (.json — visual themes)
```

- All source code lives in `src/`, with colocated tests (`*.test.ts`).
- The package targets Node.js and uses ESM (`"type": "module"`).
- pi core packages are declared as `peerDependencies` — they must not be bundled.

## Reference

- Coding guideline (design philosophy): docs/coding-guideline.md
- Coding process and conventions: docs/coding-process.md
- Commit message conventions: docs/commit_message.md
- Branch naming conventions: docs/branch_naming.md
- E2E exploratory testing process: docs/e2e-exploratory-testing-process.md
