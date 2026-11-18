#!/usr/bin/env bash
# Build bin/wl-scratch from probe/wl-scratch.c and the stable xdg-shell XML.
# Safe to run from anywhere; paths are rooted at the repository.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Ask the package database first; distributions do not all install the XMLs in
# the same prefix, and this script is meant to work on a different machine.
protocol_dir="$(pkg-config --variable=pkgdatadir wayland-protocols 2>/dev/null || true)"
protocol_dir="${protocol_dir:-/usr/share/wayland-protocols}"
protocol_xml="$protocol_dir/stable/xdg-shell/xdg-shell.xml"
if [[ ! -f "$protocol_xml" ]]; then
  echo "build:scratch: xdg-shell.xml not found under $protocol_dir (install wayland-protocols)" >&2
  exit 1
fi
generated_dir="$repo_root/tools/scratch/generated"
bin_dir="$repo_root/bin"

mkdir -p "$generated_dir" "$bin_dir"

wayland-scanner client-header "$protocol_xml" "$generated_dir/xdg-shell-client-protocol.h"
wayland-scanner private-code "$protocol_xml" "$generated_dir/xdg-shell-protocol.c"

gcc -O2 -Wall -Wextra -o "$bin_dir/wl-scratch" \
  "$repo_root/probe/wl-scratch.c" \
  "$generated_dir"/*.c \
  -I "$generated_dir" \
  $(pkg-config --cflags --libs wayland-client)

echo "built $bin_dir/wl-scratch"
