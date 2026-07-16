#!/usr/bin/env bash
# Dispatch a private, signed GitHub candidate build for pre-tag testing.
# In-place edits of /Applications/Clementine.app are intentionally forbidden:
# they invalidate the sealed bundle and bypass the canonical release signer.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

for command in git node gh; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command"
    [[ "$command" == "gh" ]] && echo "Install GitHub CLI, then run: gh auth login"
    exit 1
  }
done

[[ $# -le 1 ]] || { echo "Usage: $0 [next-version-prerelease]"; exit 1; }
CURRENT_VERSION="$(node -p "require('./package.json').version")"
VERSION="${1:-$(node scripts/release-candidate-version.mjs default "$CURRENT_VERSION")}"
if ! node scripts/release-candidate-version.mjs validate "$VERSION" "$CURRENT_VERSION"; then
  echo "Use a prerelease newer than $CURRENT_VERSION (example: $(node scripts/release-candidate-version.mjs default "$CURRENT_VERSION"))."
  exit 1
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$BRANCH" ]] || { echo "Candidate dispatch requires a named branch, not detached HEAD."; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Commit the candidate first; the worktree is dirty."; exit 1; }

HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote origin "refs/heads/$BRANCH" | awk '{print $1}')"
if [[ "$REMOTE_SHA" != "$HEAD_SHA" ]]; then
  MAIN_SHA="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  if [[ "$MAIN_SHA" == "$HEAD_SHA" ]]; then
    BRANCH=main
  else
    echo "Push $BRANCH first; GitHub does not have candidate commit $HEAD_SHA."
    exit 1
  fi
fi

gh auth status >/dev/null
gh workflow run release-desktop.yml \
  --ref "$BRANCH" \
  -f "candidate_version=$VERSION"

echo
echo "Private signed candidate dispatched: $VERSION"
echo "List:     gh run list --workflow release-desktop.yml --branch \"$BRANCH\" --event workflow_dispatch --limit 1"
echo "Watch:    gh run watch --exit-status <run-id>"
echo "macOS:    gh run download --name \"clementine-macos-$VERSION\""
echo "Windows:  gh run download --name \"clementine-windows-$VERSION\""
