#!/usr/bin/env bash
# Local mirror of the CircleCI "verify" workflow (.circleci/config.yml).
# Usage: pnpm run ci:local [--skip-tests]
# Runs the same checks CI runs, plus the helper builds, on this machine.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || root="$(pwd)"
cd "$root" || exit 1

skip_tests=0
case "${1:-}" in
  "") ;;
  --skip-tests) skip_tests=1 ;;
  *) printf 'usage: %s [--skip-tests]\n' "$0" >&2; exit 2 ;;
esac

fail=0
run() {
  local label="$1"
  shift
  printf '\n-- %s --\n' "$label"
  if "$@"; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label" >&2
    fail=1
  fi
}

printf 'hyprscope local CI: mirror of .circleci/config.yml\n'

run "docs: verify bilingual document pairs" \
  python3 .agents/se/scripts/docs/verify_translation_pairing.py

run "check: type-check" \
  pnpm run typecheck

if [ "$skip_tests" -eq 0 ]; then
  run "check: tests" \
    pnpm test
fi

run "wayland-tools: build the probe" \
  pnpm run build:probe
run "wayland-tools: build the injection helper" \
  pnpm run build:inject
run "wayland-tools: build the scratch window" \
  pnpm run build:scratch
run "wayland-tools: build the window capture helper" \
  pnpm run build:capture
run "wayland-tools: build every helper through the published script" \
  bash scripts/build-helpers.sh --strict

if [ "$fail" -ne 0 ]; then
  printf '\nlocal CI: FAILED\n' >&2
  exit 1
fi
printf '\nlocal CI: passed\n'
