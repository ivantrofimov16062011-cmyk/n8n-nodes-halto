#!/usr/bin/env bash
# Copies this package into its public repository, which publishes it to npm with provenance (n8n verification needs
# both). Halto's own repository stays the place to change the code; the public one only mirrors it.
#   scripts/sync-public-repo.sh          push the current code (no release)
#   scripts/sync-public-repo.sh --tag    also tag package.json's version: the public repository then publishes it
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=${N8N_PUBLIC_REPO:-https://github.com/ivantrofimov16062011-cmyk/n8n-nodes-halto.git}
VERSION=$(node -p 'require("'"$HERE"'/package.json").version')
SOURCE=$(git -C "$HERE" rev-parse --short HEAD)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$REPO" "$WORK"
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
# The package's committed files, minus the guide that only makes sense inside Halto's repository.
(cd "$HERE" && git ls-files -z . | tar --null -T - -cf -) | (cd "$WORK" && tar -xf -)
rm -f "$WORK/PUBLISHING.md"
printf 'node_modules/\ndist/\n' > "$WORK/.gitignore"

cd "$WORK"
# npm ci in the workflow needs a lockfile; check that it builds, tests and lints the way the workflow will.
npm install --no-audit --no-fund --loglevel=error
npm test
npm run lint
npm run build >/dev/null
rm -rf node_modules dist

git add -A
if git diff --cached --quiet; then
  echo "Public repository already has this code."
else
  git commit --quiet -m "Sync from Halto ($SOURCE)"
  git push --quiet origin HEAD
  echo "Pushed the code from Halto $SOURCE."
fi
if [ "${1:-}" = "--tag" ]; then
  git tag "$VERSION"
  git push --quiet origin "$VERSION"
  echo "Tagged $VERSION: the public repository's Publish workflow now puts it on npm."
fi
