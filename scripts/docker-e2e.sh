#!/usr/bin/env bash
# Run the browser tests in the official Playwright image (native arch), i.e. the
# same environment as CI — use it to create or update the Linux screenshot
# baselines from a Mac or Windows machine.
#   scripts/docker-e2e.sh                       run desktop + mobile suites
#   scripts/docker-e2e.sh --update-snapshots    re-baseline
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('@playwright/test/package.json').version")
exec docker run --rm --ipc=host \
  -v "$PWD":/work -v /work/node_modules -w /work -e CI=1 \
  "mcr.microsoft.com/playwright:v${VERSION}-noble" \
  bash -c "npm ci --no-audit --no-fund --ignore-scripts >/dev/null && npx playwright test --project=desktop --project=mobile $(printf "%q " "$@")"
