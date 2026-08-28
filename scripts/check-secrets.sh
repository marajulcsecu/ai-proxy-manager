#!/usr/bin/env bash
#
# Fails if anything that looks like a live credential is about to be committed.
#
#   scripts/check-secrets.sh            # scan files tracked by git + the staged index
#   scripts/check-secrets.sh --all      # also scan every commit in history
#
# Install as a pre-commit hook:
#   ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
#
set -uo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
[ -t 1 ] || { RED=; GREEN=; YELLOW=; OFF=; }

# Credential shapes worth blocking. Kept deliberately broad.
PATTERNS='(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----)'

# Obvious placeholders used in docs, tests and examples.
ALLOW='sk-your|sk-xxx|sk-\.\.\.|sk-…|sk-1234|sk-abc|sk-test|sk-demo|sk-fake|sk-example|sk-placeholder|sk-acme|sk-primary|sk-passthrough|sk-caller|sk-dead|sk-fresh|sk-local|sk-created-from-ui|sk-tabi|sk-goro|REDACTED|<your-|your-key'

status=0

scan() {
  local label="$1" input="$2"
  local hits
  hits=$(printf '%s' "$input" | grep -InE "$PATTERNS" | grep -vEi "$ALLOW")
  if [ -n "$hits" ]; then
    printf '%s✖ possible secret in %s%s\n' "$RED" "$label" "$OFF"
    printf '%s\n' "$hits" | sed 's/^/    /'
    status=1
  fi
}

# 1. Files git knows about (tracked, plus anything staged).
files=$( { git ls-files; git diff --cached --name-only --diff-filter=ACM; } | sort -u)
for file in $files; do
  [ -f "$file" ] || continue
  case "$file" in *.png|*.jpg|*.jpeg|*.gif|*.ico|*.pdf) continue ;; esac
  scan "$file" "$(cat "$file")"
done

# 2. The staged diff itself, in case a file is only partially staged.
scan "the staged diff" "$(git diff --cached -U0)"

# 3. Optional: every blob ever committed.
if [ "${1:-}" = "--all" ]; then
  printf '%sScanning full history…%s\n' "$YELLOW" "$OFF"
  while read -r commit; do
    found=$(git grep -InE "$PATTERNS" "$commit" -- 2>/dev/null | grep -vEi "$ALLOW")
    [ -n "$found" ] && { printf '%s⚠ %s%s\n' "$YELLOW" "$(git log -1 --format='%h %ad %s' --date=short "$commit")" "$OFF"
                         printf '%s\n' "$found" | sed 's/^/    /'; status=2; }
  done < <(git rev-list --all)
fi

if [ "$status" -eq 0 ]; then
  printf '%s✔ no credentials found%s\n' "$GREEN" "$OFF"
elif [ "$status" -eq 2 ]; then
  printf '\n%sFindings are in git history only — the working tree is clean.%s\n' "$YELLOW" "$OFF"
  printf 'Rotate the credential at the provider; purging history needs a force push.\n'
fi
exit "$status"
