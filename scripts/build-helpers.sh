#!/usr/bin/env bash
# Build every native helper this package can build on this machine.
#
# Observation (state/clients/workspaces/monitors/events, layout and region
# screenshots) needs none of them. Control, window capture and the capability
# probe do. A missing compiler, wayland-scanner or wayland dev package skips
# only the helper that needs it: the script reports what was built and what was
# skipped instead of failing the whole install.
set -uo pipefail

strict=0
case "${1:-}" in
  "") ;;
  --strict) strict=1 ;;
  *) printf 'usage: %s [--strict]\n' "$0" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
built=()
skipped=()

step() {
  local name="$1"; shift
  local log
  log="$(mktemp)"
  if (cd "$repo_root" && "$@") >"$log" 2>&1; then
    built+=("$name")
    printf 'built  %s\n' "$name"
  else
    skipped+=("$name")
    printf 'skipped %s (see below)\n' "$name"
    sed -e 's/^/    /' "$log" | tail -n 6
  fi
  rm -f "$log"
}

step bin/wl-globals bash -c 'gcc -O2 -o bin/wl-globals probe/wl-globals.c $(pkg-config --cflags --libs wayland-client)'
step bin/wl-scratch bash tools/scratch/build.sh
step bin/wl-inject  bash tools/inject/build.sh
step bin/wl-capture bash tools/capture/build.sh

echo
printf 'built:   %s\n' "${built[*]:-none}"
printf 'skipped: %s\n' "${skipped[*]:-none}"

if [ "$strict" -eq 1 ] && [ "${#skipped[@]}" -gt 0 ]; then
  echo "strict: every helper must build on this machine, but ${#skipped[@]} did not" >&2
  exit 1
fi

echo "Observation works without any of them; control and window capture need"
echo "bin/wl-inject and bin/wl-capture. Re-run this script after installing"
echo "gcc, wayland-scanner and the wayland development headers."
