#!/usr/bin/env bash
# sync-manifest.sh — Copy tool-manifest.json and json-schema-to-zod.ts from the
# Neuralingual monorepo into this public repo, then verify the build.
#
# Usage:
#   ./scripts/sync-manifest.sh [monorepo-path]
#
# Default monorepo path: ../neuralingual

set -euo pipefail

MONOREPO="${1:-../neuralingual}"
MONOREPO_SRC="$MONOREPO/packages/mcp/src"
PUBLIC_SRC="$(cd "$(dirname "$0")/.." && pwd)/src"

# Validate monorepo path
if [ ! -d "$MONOREPO_SRC" ]; then
  echo "Error: monorepo source not found at $MONOREPO_SRC"
  echo "Usage: $0 [path-to-neuralingual-monorepo]"
  exit 1
fi

FILES=("tool-manifest.json" "json-schema-to-zod.ts")
changed=0

for file in "${FILES[@]}"; do
  src="$MONOREPO_SRC/$file"
  dst="$PUBLIC_SRC/$file"

  if [ ! -f "$src" ]; then
    echo "Warning: $src not found, skipping"
    continue
  fi

  if [ -f "$dst" ] && diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  $file — no changes"
  else
    cp "$src" "$dst"
    echo "  $file — updated"
    changed=$((changed + 1))
  fi
done

if [ "$changed" -eq 0 ]; then
  echo ""
  echo "No files changed. Already in sync."
  exit 0
fi

echo ""
echo "$changed file(s) updated. Verifying build..."
echo ""

npm run build
npm run typecheck
npm test

echo ""
echo "Build, typecheck, and tests passed."
echo ""

read -rp "Publish to npm? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  npm publish --access public
  echo "Published!"
else
  echo "Skipped publish. Ready to commit."
fi
