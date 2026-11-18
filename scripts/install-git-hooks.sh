#!/usr/bin/env bash
# Install the checked-in git hooks for this checkout.
# Usage: pnpm run hooks:install   (or: bash scripts/install-git-hooks.sh)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
hooks_dir="$root/scripts/git-hooks"

[ -d "$hooks_dir" ] || { printf 'hooks dir missing: %s\n' "$hooks_dir" >&2; exit 1; }
chmod +x "$hooks_dir/pre-commit" "$hooks_dir/pre-push"
git -C "$root" config core.hooksPath scripts/git-hooks

printf 'git hooks installed: core.hooksPath=scripts/git-hooks\n'
printf '  pre-commit: tests + local CI + consistency check\n'
printf '  pre-push:   blocked unless HYPRSCOPE_ALLOW_PUSH=1 (human approval)\n'
