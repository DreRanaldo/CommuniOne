#!/usr/bin/env bash
# Fails if a tracked file looks like it contains a credential: JWTs (Supabase
# anon/service-role keys are JWTs), new-style Supabase keys, private keys,
# database URLs with passwords, or a committed .env file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

status=0
patterns=(
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.'   # JWT (anon / service-role keys)
  'sb_(secret|publishable)_[A-Za-z0-9_-]{10,}'        # new-style Supabase API keys
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'postgres(ql)?://[^:/ ]+:[^@/ ]{6,}@'               # connection string with a password
  'super-secret-jwt-token'                            # the well-known local JWT secret
  'sbp_[A-Za-z0-9]{20,}'                              # Supabase personal access token
)
for pattern in "${patterns[@]}"; do
  if matches="$(git grep -nIE -e "${pattern}" -- . ':!package-lock.json' ':!scripts/check-secrets.sh')"; then
    echo "Possible secret matching /${pattern}/:" >&2
    echo "${matches}" >&2
    status=1
  fi
done

if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' | grep -q .; then
  echo "A .env file is tracked by git:" >&2
  git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' >&2
  status=1
fi

if [[ ${status} -eq 0 ]]; then echo "    no secrets found"; fi
exit "${status}"
