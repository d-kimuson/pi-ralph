---
name: release
description: Run the pi-ralph release flow end-to-end. Use when the user asks to release patch, minor, major, beta, or an explicit semver; includes non-interactive release execution, GitHub Actions monitoring with gh, npm trusted publishing verification, draft release note cleanup, and publishing the GitHub Release.
---

# pi-ralph Release

Use this skill to perform an end-to-end release for this repository.

## Inputs

Interpret the user's argument as the release version spec:

- `patch`, `minor`, `major`, `beta`
- or an explicit semver such as `0.1.0` / `0.1.0-beta.0`

If no version spec is present, ask the user which one to use.

## Preconditions

1. Work from the repository root.
2. Inspect the current branch and working tree:

```bash
git branch --show-current
git status --short
```

3. If there are unrelated uncommitted changes, stop and ask the user how to handle them.
4. If release-related changes were just made, commit them before running release because `scripts/release.ts` requires a clean working tree.
5. Confirm SSH signing config used by `scripts/release.ts`:

```bash
git config --get gpg.format
git config --get commit.gpgsign
git config --get tag.gpgsign
```

Expected values are `ssh`, `true`, `true`. 6. Confirm npm trusted publishing is configured for this package on npmjs.com:

- Package: `@kimuson/pi-ralph`
- Publisher: GitHub Actions
- Organization/user: `d-kimuson`
- Repository: `pi-ralph`
- Workflow filename: `release.yaml` (filename only, not `.github/workflows/release.yaml`)
- Environment name: empty unless `.github/workflows/release.yaml` is changed to use one
- Allowed action: `npm publish`

Do not use or add an `NPM_TOKEN`; this release flow relies on GitHub Actions OIDC (`id-token: write`) and `npm publish --provenance`. The workflow uses `--ignore-scripts` so the development-only `prepare` hook does not run during publish.

## Release command

Run the non-interactive release:

```bash
VERSION_SPEC="patch" # replace with the user's requested spec
pnpm release -- -y --version "$VERSION_SPEC"
```

The script runs audit/build/package-shape/gatecheck/test checks, updates `package.json`, creates a signed release commit, creates a signed tag, and pushes commits and tags.

## If push fails because the branch has no upstream

The release commit and tag may already exist locally. Push the current branch with upstream, then push tags:

```bash
BRANCH="$(git branch --show-current)"
git push --set-upstream origin "$BRANCH"
git push --tags
```

Do not rerun `pnpm release` unless the local release commit/tag were removed or the previous run failed before creating them.

## Monitor GitHub Actions

After tags are pushed, find and watch the Release workflow run:

```bash
gh run list --workflow Release --limit 5
RUN_ID="<id from the vX.Y.Z row>"
gh run watch "$RUN_ID" --exit-status
```

A reusable one-liner variant:

```bash
TAG="v0.0.0"; RUN_ID="$(gh run list --workflow Release --limit 20 --json databaseId,headBranch,event --jq ".[] | select(.headBranch == \"$TAG\" and .event == \"push\") | .databaseId" | head -n 1)"; test -n "$RUN_ID" && gh run watch "$RUN_ID" --exit-status
```

If the workflow fails, inspect logs before taking corrective action:

```bash
gh run view "$RUN_ID" --log-failed
```

## Verify publish

After the workflow succeeds:

```bash
TAG="v0.0.0" # replace
npm view @kimuson/pi-ralph version
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url
```

For prereleases, verify the expected dist-tag too:

```bash
npm view @kimuson/pi-ralph dist-tags --json
```

## Rewrite and publish GitHub Release

The workflow creates a draft release. Inspect the generated notes:

```bash
TAG="v0.0.0" # replace
gh release view "$TAG" --json body --jq .body
```

Rewrite the notes according to `docs/release-note-guideline.md`. The generated draft is based on commit logs, so categories and wording may be wrong from the pi package user perspective. Remove internal-only updates, move entries to the correct category, merge intermediate same-release fixes into their related feature, and rewrite commit-message phrasing into release-note prose.

For a second-pass review before publishing, delegate a focused review to another agent:

```bash
RELEASE_URL="https://github.com/d-kimuson/pi-ralph/releases/tag/v0.0.0" # replace
pi -p "Read docs/release-note-guideline.md, review the Release Note at $RELEASE_URL, and identify concrete changes that should be made. Do not edit files or GitHub releases; only report findings."
```

Apply the review findings when they are consistent with the guideline.

Publish the draft with the rewritten notes:

```bash
TAG="v0.0.0" # replace
NOTES_FILE="/tmp/pi-ralph-$TAG-release-notes.md"
$EDITOR "$NOTES_FILE" # or write the file with the agent's file tool
gh release edit "$TAG" --notes-file "$NOTES_FILE" --draft=false
```

Confirm it is public:

```bash
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,url
```

## Final report

Report:

- released tag/version
- local release command used
- GitHub Actions run ID and result
- npm version/dist-tag verification result
- GitHub Release URL and draft/public state
- any follow-up commits created for release automation or skill updates
