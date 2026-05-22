# Release Flow

Run `pnpm release` locally to publish a new version of `@kimuson/pi-ralph`.

The intended flow is:

1. **Local skill** — use `.agents/skills/release/SKILL.md` to operate the release consistently.
2. **Local script** — `scripts/release.ts` selects the version, runs checks, commits, tags, and pushes.
3. **GitHub Actions** — `.github/workflows/release.yaml` publishes to npm with trusted publishing and creates a draft GitHub Release.
4. **Local finalization** — review, rewrite, and publish the draft GitHub Release.

## Prerequisites

### Git signing

The release script creates a signed commit and a signed tag. Configure SSH signing before release:

```bash
git config --global gpg.format ssh
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

The working tree must be clean before running the release script.

### npm trusted publishing

This repository does **not** use an `NPM_TOKEN`. Publishing is authenticated by npm trusted publishing through GitHub Actions OIDC.

Configure the package on npmjs.com:

1. Open the npm package settings for `@kimuson/pi-ralph`.
2. Add a **Trusted Publisher**.
3. Select **GitHub Actions**.
4. Use these values:

| npm trusted publisher field | Value          |
| --------------------------- | -------------- |
| Organization or user        | `d-kimuson`    |
| Repository                  | `pi-ralph`     |
| Workflow filename           | `release.yaml` |
| Environment name            | empty / unset  |
| Allowed actions             | `npm publish`  |

Important details from npm's trusted publishing model:

- The workflow filename is only the filename (`release.yaml`), not `.github/workflows/release.yaml`.
- The workflow must run on GitHub-hosted runners.
- The publish job must have `permissions.id-token: write` and `permissions.contents: read`.
- Trusted publishing requires npm CLI `11.5.1` or later and Node.js `22.14.0` or later. This repository uses Node `24` and installs `npm@11.5.1` in the shared setup action.
- `npm publish --provenance` automatically uses the GitHub Actions OIDC identity when the trusted publisher matches. The workflow adds `--ignore-scripts` so the development-only `prepare` hook does not run during publish. Do not add `NPM_TOKEN` unless intentionally abandoning this flow.

## Release Process

### 1. Run release script locally

Interactive:

```bash
pnpm release
```

Non-interactive examples:

```bash
pnpm release -- -y --version patch
pnpm release -- -y --version minor
pnpm release -- -y --version major
pnpm release -- -y --version beta
pnpm release -- -y --version 0.2.0
pnpm release -- -y --version 0.2.0-beta.0
```

The script will:

1. Check prerequisites: clean working tree and git signing config.
2. Resolve the next version.
3. Confirm the release unless `-y` / `--yes` is provided.
4. Run publish-ready checks:
   - `pnpm audit --audit-level low`
   - `pnpm build`
   - `pnpm check:pack`
   - `pnpm gatecheck check`
   - `pnpm test`
5. Update `package.json` with the new version.
6. Create a signed commit: `chore: release vX.Y.Z`.
7. Create a signed tag: `vX.Y.Z`.
8. Push the commit and tag.

If push fails because the branch has no upstream, do not rerun the release script. The release commit and tag may already exist locally. Push them explicitly:

```bash
BRANCH="$(git branch --show-current)"
git push --set-upstream origin "$BRANCH"
git push --tags
```

### 2. CD — automatic on GitHub Actions

A pushed `v*` tag triggers `.github/workflows/release.yaml`.

The `publish` job:

1. Checks out the tagged commit.
2. Sets up Node, npm, pnpm, and dependencies through `.github/actions/setup-node/action.yml`.
3. Derives the npm dist-tag:
   - Stable versions, e.g. `v0.2.0` → `latest`
   - Prereleases, e.g. `v0.2.0-beta.0` → `beta`
4. Runs npm trusted publishing:

```bash
npm publish --ignore-scripts --provenance --access public --tag <dist-tag>
```

The `release-notes` job runs after publish and creates a draft GitHub Release with:

```bash
pnpm exec changelogithub --draft
```

### 3. Monitor and verify

Watch the Release workflow:

```bash
gh run list --workflow Release --limit 5
RUN_ID="<id from the vX.Y.Z row>"
gh run watch "$RUN_ID" --exit-status
```

If it fails:

```bash
gh run view "$RUN_ID" --log-failed
```

After success, verify npm and GitHub Release state:

```bash
TAG="v0.0.0" # replace
npm view @kimuson/pi-ralph version
npm view @kimuson/pi-ralph dist-tags --json
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url
```

### 4. Edit and publish draft release

The generated GitHub Release is intentionally a draft. Rewrite it before publishing:

1. Read `docs/release-note-guideline.md`.
2. Inspect the generated notes:

```bash
TAG="v0.0.0" # replace
gh release view "$TAG" --json body --jq .body
```

3. Rewrite the notes from the perspective of `@kimuson/pi-ralph` users.
4. Publish the draft:

```bash
TAG="v0.0.0" # replace
NOTES_FILE="/tmp/pi-ralph-$TAG-release-notes.md"
gh release edit "$TAG" --notes-file "$NOTES_FILE" --draft=false
```

5. Confirm it is public:

```bash
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url
```

## Files Involved

| File                                    | Purpose                                                 |
| --------------------------------------- | ------------------------------------------------------- |
| `.agents/skills/release/SKILL.md`       | Local release operation skill                           |
| `scripts/release.ts`                    | Local release script                                    |
| `scripts/check-pack.ts`                 | Published package shape check                           |
| `.github/workflows/release.yaml`        | CD workflow: trusted npm publish + draft GitHub Release |
| `.github/workflows/ci.yml`              | CI workflow                                             |
| `.github/actions/setup-node/action.yml` | Shared Node/npm/pnpm setup action                       |
| `docs/release-note-guideline.md`        | Release note rewrite guideline                          |
| `package.json` (`publishConfig.access`) | Public npm publish config                               |
| `package.json` (`files`)                | Published file allowlist                                |

## Notes

- This package is public and published as `@kimuson/pi-ralph`.
- There is no compilation build step required for the pi package resources.
- `scripts/check-pack.ts` verifies that the package contains the expected pi resources and excludes internal release/CI files.
- For hotfix releases targeting an older base, use an explicit semver with `--version`.
