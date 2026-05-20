# Release Flow

Run `pnpm release` interactively to publish a new version of `@kimuson/pi-ralph`.

## Prerequisites

- Git signing must be configured with SSH keys:
  ```bash
  git config --global gpg.format ssh
  git config --global commit.gpgsign true
  git config --global tag.gpgsign true
  ```
- Working tree must be clean (no uncommitted changes).
- `npm trusted publishing` must be configured on the GitHub repository (Settings → Environments → npm provenance).

## Release Process

### 1. Run release script

```bash
pnpm release
```

Or with options:

```bash
pnpm release -- -y                              # Skip confirmation prompt
pnpm release -- --version patch                 # Specify version bump
pnpm release -- --version minor
pnpm release -- --version major
pnpm release -- --version beta
pnpm release -- --version 0.2.0                 # Explicit semver
```

The script will:

1. **Check prerequisites** — clean working tree, git signing config.
2. **Prompt for version** — interactive selection from bump choices.
3. **Confirm** — ask for final confirmation.
4. **Run publish-ready checks:**
   - `pnpm audit --audit-level low`
   - `pnpm build` (no build step needed, placeholder only)
   - `pnpm gatecheck check`
   - `pnpm test`
5. **Update package.json** with new version.
6. **Create signed commit** (`chore: release vX.Y.Z`).
7. **Create signed tag** (`vX.Y.Z`).
8. **Push commit and tag** to GitHub.

### 2. CD (GitHub Actions) — automatic

On tag push (`v*`), the `release.yaml` workflow:

1. **Publish to npm** — uses `--provenance` (npm trusted publishing) with the correct dist-tag:
   - Pre-release tags (e.g., `v0.1.0-beta.0`) → `beta` dist-tag
   - Stable versions → `latest` dist-tag
2. **Generate release notes** — uses `changelogithub --draft` to create a draft GitHub Release.

### 3. Edit and publish draft release

After the GitHub Actions workflow finishes:

1. Open the draft release on GitHub.
2. Review and rewrite the auto-generated release notes.
3. Publish the release.

## Files Involved

| File | Purpose |
|------|---------|
| `scripts/release.ts` | Interactive release script |
| `.github/workflows/release.yaml` | CD workflow — publish to npm + draft release |
| `.github/workflows/ci.yaml` | CI workflow (runs on PRs and main) |
| `.github/actions/setup-node/action.yml` | Shared Node/pnpm setup action |
| `package.json` (`publishConfig.access`) | npm publish access config |

## Notes

- This package is `@kimuson/pi-ralph`, published publicly.
- There is no build step needed (pure TypeScript with pi auto-discovery).
- The `files` field in package.json controls what gets published to npm.
- The release script always updates `package.json` and commits it.
- For hotfix releases targeting an older base, use the explicit version option.
