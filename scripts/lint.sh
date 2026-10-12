#!/usr/bin/env bash
# Static checks that need no database: JavaScript syntax, shell syntax
# (plus shellcheck when installed), and a scan for committed secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "==> JavaScript syntax"
while IFS= read -r file; do node --check "${file}"; done < <(git ls-files '*.js' '*.mjs' '*.cjs')

echo "==> Shell syntax"
mapfile -t shell_files < <(git ls-files '*.sh')
for file in "${shell_files[@]}"; do bash -n "${file}"; done
if command -v shellcheck > /dev/null; then
  shellcheck --severity=warning "${shell_files[@]}"
else
  echo "    (shellcheck not installed; skipped)"
fi

echo "==> Secret scan"
bash scripts/check-secrets.sh

echo "==> Lint passed"
